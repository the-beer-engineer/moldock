#!/usr/bin/env node
/**
 * MolDock Remote Agent Client
 *
 * Standalone executable that connects to a MolDock dispatch server,
 * requests work packages, executes docking chains locally, and reports results.
 *
 * Usage:
 *   moldock-agent [--server URL] [--name NAME] [--paymail HANDLE]
 *
 * If name/paymail are not provided, the agent prompts interactively.
 */
import { PrivateKey, Transaction, Script } from '@bsv/sdk';
import { createInterface } from 'readline';
import { computeBatchEnergy } from './energy.js';
import type { Molecule, ReceptorSite, Atom } from './types.js';

// --- Config ---
const DEFAULT_SERVER = 'http://localhost:3456';
const POLL_INTERVAL_MS = 2000;
const BROADCAST_CHUNK = 25;

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
const serverUrl = getArg('--server') ?? DEFAULT_SERVER;

// --- Interactive prompt ---
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// --- HTTP helpers ---
async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${serverUrl}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path}: ${res.status} ${body}`);
  }
  return res.json();
}

async function apiPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// --- Chain building (mirrors chainBuilder.ts logic but standalone) ---

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

// Cache for body hex extracted from compiledAsm
const bodyHexCache = new Map<string, string>();

function buildChainLockScript(numAtoms: number, score: number, compiledAsm: string): Script {
  // compiledAsm is ASM text: "<scoreInN> OP_DROP <body...>"
  // Extract the body hex (everything after OP_DROP) and cache it
  let cachedBodyHex = bodyHexCache.get(compiledAsm);
  if (!cachedBodyHex) {
    const parts = compiledAsm.split('OP_DROP ');
    if (parts.length < 2) {
      throw new Error('Could not find OP_DROP in compiled chain ASM');
    }
    const bodyAsm = parts.slice(1).join('OP_DROP ');
    cachedBodyHex = Script.fromASM(bodyAsm).toHex();
    bodyHexCache.set(compiledAsm, cachedBodyHex);
  }

  // Encode score as 4-byte push (matches on-chain 4n num2bin)
  const buf = Buffer.alloc(4);
  if (score !== 0) {
    const neg = score < 0;
    const abs = Math.abs(score);
    buf.writeUInt32LE(abs);
    if (neg) buf[3] |= 0x80;
  }
  const scorePrefix = '04' + buf.toString('hex'); // OP_PUSH4 + 4 bytes
  const fullHex = scorePrefix + '75' + cachedBodyHex; // + OP_DROP + body
  const rawBytes = Uint8Array.from(Buffer.from(fullHex, 'hex'));
  return new Script([], rawBytes, undefined, false);
}

/** Execute a full chain in memory, return the chain TXs and final score */
function executeChainInMemory(
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
    chainTx.addOutput({ lockingScript: buildChainLockScript(numAtoms, newScore, compiledAsm), satoshis: 1 });

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

// --- Simple pass/fail threshold (percentile-based locally across this agent's history) ---
const scoreHistory: number[] = [];

function isPassing(score: number): boolean {
  scoreHistory.push(score);
  if (scoreHistory.length < 5) return true; // not enough data
  const sorted = [...scoreHistory].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.2)];
  return score <= threshold;
}

// --- Main agent loop ---
async function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   MolDock Remote Agent v0.1          ║');
  console.log('  ║   On-chain molecular docking on BSV  ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  Server: ${serverUrl}`);
  console.log('');

  // Check server connectivity
  try {
    const node = await apiGet('/api/node');
    console.log(`  Connected to server — BSV node height: ${node.height}`);
  } catch (err: any) {
    console.error(`  Cannot reach server at ${serverUrl}: ${err.message}`);
    console.error('  Use --server URL to specify a different server.');
    process.exit(1);
  }

  // Get agent name
  let agentName = getArg('--name') ?? '';
  if (!agentName) {
    agentName = await prompt('  What is your agent name? > ');
    if (!agentName) {
      console.error('  Agent name is required.');
      process.exit(1);
    }
  }

  // Check name availability
  try {
    const check = await apiGet(`/api/agent/check-name/${encodeURIComponent(agentName)}`);
    if (!check.available) {
      console.error(`  Name "${agentName}" is already taken. Choose another.`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`  Name check failed: ${err.message}`);
    process.exit(1);
  }

  // Get Handcash handle or BSV address for rewards
  let paymail = getArg('--paymail') ?? '';
  if (!paymail) {
    paymail = await prompt('  Your Handcash handle or BSV address (for 100 sat rewards): > ');
  }

  // Generate agent keypair
  const privateKey = PrivateKey.fromRandom();
  const pubkeyHex = privateKey.toPublicKey().toString();

  console.log('');
  console.log(`  Registering agent "${agentName}"...`);

  // Register with dispatch server
  let agentId: string;
  try {
    const result = await apiPost('/api/agent/register', {
      name: agentName,
      pubkey: pubkeyHex,
      paymail: paymail || null,
    });
    if (result.error) {
      console.error(`  Registration failed: ${result.error}`);
      process.exit(1);
    }
    agentId = result.agent.id;
    console.log(`  Registered! Agent ID: ${agentId}`);
    console.log(`  Public key: ${pubkeyHex.slice(0, 16)}...`);
    if (paymail) console.log(`  Rewards to: ${paymail}`);
  } catch (err: any) {
    console.error(`  Registration failed: ${err.message}`);
    process.exit(1);
  }

  console.log('');
  console.log('  Starting work loop... (Ctrl+C to stop)');
  console.log('  ─'.repeat(30));

  let workCount = 0;
  let passCount = 0;
  let failCount = 0;
  let totalTxs = 0;
  let pendingWork: any = null; // work received from confirm/fail responses

  // Main work loop
  while (true) {
    try {
      // Get work: either from a previous response or by requesting new
      let work: any;
      if (pendingWork) {
        work = pendingWork;
        pendingWork = null;
      } else {
        const workRes = await apiGet(`/api/agent/${agentId}/work`);
        if (workRes.error) {
          console.log(`  Waiting for work... (${workRes.error})`);
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }
        work = workRes.work;
      }
      workCount++;
      const molId = work.molecule.id;
      const numSteps = work.numSteps;
      const numAtoms = work.molecule.atoms.length;

      console.log(`  [#${workCount}] ${molId} — ${numAtoms} atoms × ${numSteps} steps`);

      // Execute chain in memory
      let result: ReturnType<typeof executeChainInMemory>;
      let elapsed = '0';
      try {
        const genesisTx = Transaction.fromHex(work.genesisTxHex);
        const genesisTxid = work.genesisTxid;

        const t0 = performance.now();
        result = executeChainInMemory(
          work.molecule, work.receptor, work.compiledAsm,
          genesisTx, genesisTxid,
        );
        elapsed = ((performance.now() - t0) / 1000).toFixed(2);
        console.log(`    Computed: score=${result.finalScore} (${result.txChain.length} TXs, ${elapsed}s)`);
      } catch (chainErr: any) {
        // Chain execution failed — report as fail and continue
        console.log(`    CHAIN ERROR: ${chainErr.message}`);
        try {
          const failRes = await apiPost(`/api/agent/${agentId}/fail`, {
            workId: work.id,
            finalScore: 0,
          });
          if (failRes.nextWork) pendingWork = failRes.nextWork;
        } catch {}
        failCount++;
        continue;
      }

      const passed = isPassing(result.finalScore);
      totalTxs += result.txChain.length;

      if (passed) {
        passCount++;
        console.log(`    PASS score=${result.finalScore} (${result.txChain.length} TXs, ${elapsed}s)`);

        // Submit pass + chain TX hexes for verification and fee funding
        const passRes = await apiPost(`/api/agent/${agentId}/pass`, {
          workId: work.id,
          finalScore: result.finalScore,
          chainTxHexes: result.txHexes,
        });

        if (passRes.ok && passRes.feePackage) {
          console.log(`    Fee package received: ${passRes.feePackage.utxos.length} UTXOs`);
          // TODO: attach fee UTXOs to chain TXs and broadcast to mainnet
          // For now, confirm completion (server has the chain data)
          const confirmRes = await apiPost(`/api/agent/${agentId}/confirm`, {
            workId: work.id,
            txids: result.stepTxids,
          });
          console.log(`    Confirmed`);
          if (confirmRes.nextWork) {
            pendingWork = confirmRes.nextWork;
          }
        } else if (passRes.error) {
          console.log(`    Pass rejected: ${passRes.error}`);
        }
      } else {
        failCount++;
        console.log(`    FAIL score=${result.finalScore} (${elapsed}s)`);

        // Submit fail — get next work automatically
        const failRes = await apiPost(`/api/agent/${agentId}/fail`, {
          workId: work.id,
          finalScore: result.finalScore,
        });

        if (failRes.error) {
          console.log(`    Fail submit error: ${failRes.error}`);
        } else if (failRes.nextWork) {
          pendingWork = failRes.nextWork;
        }
      }

      // Status summary every 10 molecules
      if (workCount % 10 === 0) {
        console.log(`  ── ${workCount} processed | ${passCount} pass | ${failCount} fail | ${totalTxs} TXs ──`);
      }

    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS * 2));
    }
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Shutting down agent...');
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
