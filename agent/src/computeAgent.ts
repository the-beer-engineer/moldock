#!/usr/bin/env node
/**
 * MolDock Compute Agent — Autonomous molecular docking computation.
 *
 * This is the "compute" side of the two-agent system required by the hackathon.
 * It autonomously:
 *   1. Generates its own BSV wallet
 *   2. Discovers the dispatch agent via HTTP
 *   3. Registers and requests work (bounties/molecules)
 *   4. Executes covenant chains (energy calculation verified by Bitcoin Script)
 *   5. Attaches fee inputs and broadcasts chain TXs
 *   6. Receives payment in the final chain TX
 *
 * Usage:
 *   npx tsx src/computeAgent.ts --server http://localhost:3456 --name MyAgent
 *   COMPUTE_PRIVATE_KEY=<wif> npx tsx src/computeAgent.ts --server http://... --name Bot1
 */

import { PrivateKey, Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { createInterface } from 'readline';
import { Wallet } from './wallet.js';
import { computeBatchEnergy } from './energy.js';
import { config } from './config.js';
import type { Molecule, ReceptorSite, Atom } from './types.js';

// --- Config ---
const POLL_INTERVAL_MS = 2000;

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
const serverUrl = getArg('--server') ?? 'http://localhost:3456';

// --- Wallet ---
const wif = process.env.COMPUTE_PRIVATE_KEY;
const wallet = new Wallet(wif, config.network as any);

// --- Interactive prompt ---
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// --- HTTP helpers ---
async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${serverUrl}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// --- Chain building (standalone — mirrors chainBuilder.ts) ---

function pushScriptNum(n: number): number[] {
  if (n === 0) return [0x00];
  if (n === -1) return [0x4f];
  if (n >= 1 && n <= 16) return [0x50 + n];
  const neg = n < 0;
  let abs = Math.abs(n);
  const bytes: number[] = [];
  while (abs > 0) { bytes.push(abs & 0xff); abs >>= 8; }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(neg ? 0x80 : 0x00);
  else if (neg) bytes[bytes.length - 1] |= 0x80;
  return pushData(bytes);
}

function pushData(data: number[]): number[] {
  if (data.length === 0) return [0x00];
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16) return [0x50 + data[0]];
  if (data.length === 1 && data[0] === 0x81) return [0x4f];
  if (data.length <= 75) return [data.length, ...data];
  if (data.length <= 255) return [0x4c, data.length, ...data];
  return [0x4d, data.length & 0xff, (data.length >> 8) & 0xff, ...data];
}

function buildChainScriptSig(
  prevTxid: string, inputSats: number, batchTotal: number, scoreOut: number,
  pairs: Array<{ dsq: number; dist: number; vdw: number; elec: number; hbond: number }>,
): string {
  const parts: number[][] = [];
  const txidBytes = Array.from(Buffer.from(prevTxid, 'hex').reverse());
  parts.push(pushData(txidBytes));
  const satsBuf = Buffer.alloc(8);
  satsBuf.writeBigUInt64LE(BigInt(inputSats));
  parts.push(pushData(Array.from(satsBuf)));
  parts.push(pushScriptNum(batchTotal));
  parts.push(pushScriptNum(scoreOut));
  for (const pair of pairs) {
    parts.push(pushScriptNum(pair.hbond));
    parts.push(pushScriptNum(pair.elec));
    parts.push(pushScriptNum(pair.vdw));
    parts.push(pushScriptNum(pair.dist));
    parts.push(pushScriptNum(pair.dsq));
  }
  return parts.map(p => Buffer.from(p).toString('hex')).join('');
}

const bodyHexCache = new Map<string, string>();

function buildChainLockScript(numAtoms: number, score: number, compiledAsm: string): Script {
  let cachedBodyHex = bodyHexCache.get(compiledAsm);
  if (!cachedBodyHex) {
    const parts = compiledAsm.split('OP_DROP ');
    if (parts.length < 2) throw new Error('Could not find OP_DROP in compiled chain ASM');
    const bodyAsm = parts.slice(1).join('OP_DROP ');
    cachedBodyHex = Script.fromASM(bodyAsm).toHex();
    bodyHexCache.set(compiledAsm, cachedBodyHex);
  }

  const buf = Buffer.alloc(4);
  if (score !== 0) {
    const neg = score < 0;
    const abs = Math.abs(score);
    buf.writeUInt32LE(abs);
    if (neg) buf[3] |= 0x80;
  }
  const scorePrefix = '04' + buf.toString('hex');
  const fullHex = scorePrefix + '75' + cachedBodyHex;
  const rawBytes = Uint8Array.from(Buffer.from(fullHex, 'hex'));
  return new Script([], rawBytes, undefined, false);
}

// --- Chain execution with fee inputs ---

interface FeeUtxoInfo {
  txid: string;
  vout: number;
  satoshis: number;
  scriptHex: string;
  sourceTxHex: string;
}

function executeChainWithFees(
  molecule: Molecule, receptor: ReceptorSite, compiledAsm: string,
  genesisTx: Transaction, genesisTxid: string,
  feeUtxos: FeeUtxoInfo[],
  agentWallet: Wallet,
  paymentSats: number,
): { txChain: Transaction[]; txHexes: string[]; finalScore: number; stepTxids: string[] } {
  const numAtoms = molecule.atoms.length;
  const numSteps = receptor.atoms.length;
  const txChain: Transaction[] = [genesisTx];
  const txHexes: string[] = [genesisTx.toHex()];
  const stepTxids: string[] = [];

  let prevTx = genesisTx;
  let currentTxid = genesisTxid;
  let currentScore = 0;

  for (let step = 0; step < numSteps; step++) {
    const receptorAtom = receptor.atoms[step];
    const batch = computeBatchEnergy(molecule.atoms, receptorAtom);
    const newScore = currentScore + batch.batchTotal;

    const scriptSigHex = buildChainScriptSig(currentTxid, 1, batch.batchTotal, newScore, batch.pairs);

    const chainTx = new Transaction();
    chainTx.version = 2;
    chainTx.lockTime = 0;

    // Input 0: covenant UTXO
    chainTx.addInput({
      sourceTransaction: prevTx,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromHex(scriptSigHex),
      sequence: 0xffffffff,
    });

    // Output 0: covenant continuation
    chainTx.addOutput({
      lockingScript: buildChainLockScript(numAtoms, newScore, compiledAsm),
      satoshis: 1,
    });

    // Add fee input if available (SIGHASH_SINGLE|ANYONECANPAY allows extra inputs)
    if (step < feeUtxos.length) {
      const feeUtxo = feeUtxos[step];
      const feeSourceTx = Transaction.fromHex(feeUtxo.sourceTxHex);
      chainTx.addInput({
        sourceTransaction: feeSourceTx,
        sourceOutputIndex: feeUtxo.vout,
        unlockingScriptTemplate: agentWallet.p2pkUnlock(
          feeUtxo.satoshis, Script.fromHex(feeUtxo.scriptHex),
        ),
        sequence: 0xffffffff,
      });

      // Final step: add payment output to compute agent
      const isLastStep = step === numSteps - 1;
      if (isLastStep && paymentSats > 0) {
        chainTx.addOutput({
          lockingScript: agentWallet.p2pkLockingScript(),
          satoshis: paymentSats,
        });
      }

      // Change output
      chainTx.addOutput({
        lockingScript: agentWallet.p2pkLockingScript(),
        change: true,
      });
    }

    // Sign fee input (input 0 is covenant, already has unlockingScript)
    // The fee() call sets the fee, sign() signs input 1
    if (step < feeUtxos.length) {
      // We need to sign synchronously — use a helper
      signChainTx(chainTx);
    }

    const chainTxid = chainTx.id('hex');
    txChain.push(chainTx);
    txHexes.push(chainTx.toHex());
    stepTxids.push(chainTxid);

    prevTx = chainTx;
    currentTxid = chainTxid;
    currentScore = newScore;
  }

  return { txChain, txHexes, finalScore: currentScore, stepTxids };
}

async function signChainTx(tx: Transaction): Promise<void> {
  await tx.fee(new SatoshisPerKilobyte(config.feePerKb));
  await tx.sign();
}

/** Execute chain without fee inputs (simple mode) */
function executeChainSimple(
  molecule: Molecule, receptor: ReceptorSite, compiledAsm: string,
  genesisTx: Transaction, genesisTxid: string,
): { txChain: Transaction[]; txHexes: string[]; finalScore: number; stepTxids: string[] } {
  const numAtoms = molecule.atoms.length;
  const numSteps = receptor.atoms.length;
  const txChain: Transaction[] = [genesisTx];
  const txHexes: string[] = [genesisTx.toHex()];
  const stepTxids: string[] = [];

  let prevTx = genesisTx;
  let currentTxid = genesisTxid;
  let currentScore = 0;

  for (let step = 0; step < numSteps; step++) {
    const receptorAtom = receptor.atoms[step];
    const batch = computeBatchEnergy(molecule.atoms, receptorAtom);
    const newScore = currentScore + batch.batchTotal;

    const scriptSigHex = buildChainScriptSig(currentTxid, 1, batch.batchTotal, newScore, batch.pairs);

    const chainTx = new Transaction();
    chainTx.version = 2;
    chainTx.lockTime = 0;
    chainTx.addInput({
      sourceTransaction: prevTx,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromHex(scriptSigHex),
      sequence: 0xffffffff,
    });
    chainTx.addOutput({
      lockingScript: buildChainLockScript(numAtoms, newScore, compiledAsm),
      satoshis: 1,
    });

    txChain.push(chainTx);
    txHexes.push(chainTx.toHex());
    stepTxids.push(chainTx.id('hex'));

    prevTx = chainTx;
    currentTxid = chainTx.id('hex');
    currentScore = newScore;
  }

  return { txChain, txHexes, finalScore: currentScore, stepTxids };
}

// --- Pass/fail threshold ---
const scoreHistory: number[] = [];

function isPassing(score: number): boolean {
  scoreHistory.push(score);
  if (scoreHistory.length < 5) return true;
  const sorted = [...scoreHistory].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.2)];
  return score <= threshold;
}

// --- Main ---
async function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   MolDock Compute Agent v1.0         ║');
  console.log('  ║   On-chain molecular docking on BSV  ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  Server:  ${serverUrl}`);
  console.log(`  Network: ${config.network}`);
  console.log(`  Wallet:  ${wallet.address}`);
  console.log(`  PubKey:  ${wallet.publicKeyHex.slice(0, 20)}...`);
  if (!wif) console.log('  ⚠  No COMPUTE_PRIVATE_KEY — using ephemeral wallet');
  console.log('');

  // Discover dispatch agent
  let dispatchInfo: any;
  try {
    dispatchInfo = await apiGet('/api/discover');
    console.log(`  ✓ Discovered dispatch agent`);
    console.log(`    Service: ${dispatchInfo.service} v${dispatchInfo.version}`);
    console.log(`    Network: ${dispatchInfo.network}`);
    console.log(`    Dispatch pubkey: ${dispatchInfo.dispatchPubkey?.slice(0, 20)}...`);
  } catch (err: any) {
    // Fallback to /api/node
    try {
      const node = await apiGet('/api/node');
      console.log(`  ✓ Connected to dispatch (node height: ${node.height})`);
    } catch {
      console.error(`  ✗ Cannot reach dispatch at ${serverUrl}: ${err.message}`);
      process.exit(1);
    }
  }

  // Get agent name
  let agentName = getArg('--name') ?? '';
  if (!agentName) {
    agentName = await prompt('  Agent name? > ');
    if (!agentName) { console.error('  Name required.'); process.exit(1); }
  }

  // Check availability
  try {
    const check = await apiGet(`/api/agent/check-name/${encodeURIComponent(agentName)}`);
    if (!check.available) {
      console.error(`  Name "${agentName}" taken. Choose another.`);
      process.exit(1);
    }
  } catch {}

  // Get paymail
  let paymail = getArg('--paymail') ?? '';
  if (!paymail && !args.includes('--no-prompt')) {
    paymail = await prompt('  Paymail or BSV address (for rewards): > ');
  }

  // Register
  console.log(`\n  Registering "${agentName}"...`);
  let agentId: string;
  try {
    const result = await apiPost('/api/agent/register', {
      name: agentName,
      pubkey: wallet.publicKeyHex,
      paymail: paymail || null,
    });
    if (result.error) { console.error(`  Registration failed: ${result.error}`); process.exit(1); }
    agentId = result.agent.id;
    console.log(`  ✓ Registered! ID: ${agentId}`);
  } catch (err: any) {
    console.error(`  Registration failed: ${err.message}`);
    process.exit(1);
  }

  console.log('');
  console.log('  Starting work loop... (Ctrl+C to stop)');
  console.log('  ' + '─'.repeat(50));

  let workCount = 0, passCount = 0, failCount = 0, totalTxs = 0, totalSatsEarned = 0;
  let pendingWork: any = null;

  while (true) {
    try {
      let work: any;
      if (pendingWork) {
        work = pendingWork;
        pendingWork = null;
      } else {
        const res = await apiGet(`/api/agent/${agentId}/work`);
        if (res.error) {
          process.stdout.write(`  Waiting for work... (${res.error})\r`);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        work = res.work;
      }

      workCount++;
      const molId = work.molecule.id;
      const numSteps = work.numSteps;
      const numAtoms = work.molecule.atoms.length;

      process.stdout.write(`  [#${workCount}] ${molId} (${numAtoms}×${numSteps})...`);

      // Execute chain in memory
      const genesisTx = Transaction.fromHex(work.genesisTxHex);
      const t0 = performance.now();
      const result = executeChainSimple(
        work.molecule, work.receptor, work.compiledAsm,
        genesisTx, work.genesisTxid,
      );
      const elapsed = ((performance.now() - t0)).toFixed(0);

      const passed = isPassing(result.finalScore);
      totalTxs += result.txChain.length;

      if (passed) {
        passCount++;
        console.log(` PASS score=${result.finalScore} (${result.txChain.length} TXs, ${elapsed}ms)`);

        // Submit pass + chain hex
        const passRes = await apiPost(`/api/agent/${agentId}/pass`, {
          workId: work.id,
          finalScore: result.finalScore,
          chainTxHexes: result.txHexes,
        });

        if (passRes.ok && passRes.feePackage) {
          const feeUtxos: FeeUtxoInfo[] = passRes.feePackage.utxos;
          console.log(`    Fee UTXOs received: ${feeUtxos.length}`);

          // Re-execute chain WITH fee inputs attached
          try {
            const rewardSats = 100 + (10 * numSteps); // dynamic pricing
            const withFees = executeChainWithFees(
              work.molecule, work.receptor, work.compiledAsm,
              genesisTx, work.genesisTxid,
              feeUtxos, wallet, rewardSats,
            );

            // Confirm broadcast (chain TXs will be broadcast by dispatch on regtest)
            const confirmRes = await apiPost(`/api/agent/${agentId}/confirm`, {
              workId: work.id,
              txids: withFees.stepTxids,
            });
            totalSatsEarned += rewardSats;
            console.log(`    ✓ Confirmed (reward: ${rewardSats} sats, total: ${totalSatsEarned})`);
            if (confirmRes.nextWork) pendingWork = confirmRes.nextWork;
          } catch (feeErr: any) {
            console.log(`    Fee attachment failed: ${feeErr.message} — confirming without fees`);
            const confirmRes = await apiPost(`/api/agent/${agentId}/confirm`, {
              workId: work.id,
              txids: result.stepTxids,
            });
            if (confirmRes.nextWork) pendingWork = confirmRes.nextWork;
          }
        } else if (passRes.error) {
          console.log(`    Pass rejected: ${passRes.error}`);
        }
      } else {
        failCount++;
        console.log(` FAIL score=${result.finalScore} (${elapsed}ms)`);
        const failRes = await apiPost(`/api/agent/${agentId}/fail`, {
          workId: work.id,
          finalScore: result.finalScore,
        });
        if (failRes.nextWork) pendingWork = failRes.nextWork;
      }

      // Status every 10
      if (workCount % 10 === 0) {
        console.log(`  ── ${workCount} done | ${passCount}P/${failCount}F | ${totalTxs} TXs | ${totalSatsEarned} sats earned ──`);
      }

    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
      await sleep(POLL_INTERVAL_MS * 2);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

process.on('SIGINT', () => {
  console.log('\n  Shutting down compute agent...');
  console.log(`  Stats: ${scoreHistory.length} molecules, earned ${0} sats`);
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
