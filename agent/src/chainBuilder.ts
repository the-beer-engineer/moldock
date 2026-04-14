import { Transaction, P2PKH, Script, LockingScript, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import type { UTXO } from './wallet.js';
import { getNetwork } from './network.js';
import { generateChainSx } from './chainTemplate.js';
import { compileSxToLockHex, buildChainLockScript } from './genesis.js';
import { computeBatchEnergy } from './energy.js';
import { config } from './config.js';
import type { Molecule, ReceptorSite, ChainState, BatchResult } from './types.js';

/** Fee UTXO for covering chain TX mining fees */
export interface FeeUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  script: string;
  sourceTransaction?: Transaction;
}

/** Options for chain execution with fee support */
export interface ChainExecOptions {
  /** Fee UTXOs — one per chain step. If provided, added as input 1 to each chain TX. */
  feeUtxos?: FeeUtxo[];
  /** Wallet to sign fee inputs. Required if feeUtxos provided. */
  feeWallet?: Wallet;
  /** Payment pubkey for the compute agent (receives reward in final TX output 1) */
  paymentPubkey?: string;
  /** Payment amount in sats (reward for compute agent) */
  paymentSats?: number;
  /** Callback on each chain event */
  onEvent?: (event: ChainEvent) => void;
  /** Delay between steps (ms) */
  stepDelayMs?: number;
  /** If true, broadcast each TX to regtest immediately */
  broadcast?: boolean;
}

// --- Minimal push encoding for scriptSig construction ---
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
  prevTxid: string,
  inputSats: number,
  batchTotal: number,
  scoreOut: number,
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

// --- Compiled script cache ---
const compiledCache = new Map<number, string>();

export function getCompiledAsm(numAtoms: number): string {
  if (!compiledCache.has(numAtoms)) {
    const sx = generateChainSx(numAtoms);
    compiledCache.set(numAtoms, compileSxToLockHex(sx, `chain_${numAtoms}.sx`));
  }
  return compiledCache.get(numAtoms)!;
}

// --- Chain result ---
export interface ChainResult {
  moleculeId: string;
  genesisTxid: string;
  stepTxids: string[];
  states: ChainState[];
  finalScore: number;
  totalTxs: number;
  totalBytes: number;
  status: 'completed' | 'failed';
  error?: string;
  durationMs: number;
  /** Full chain of Transaction objects for deferred broadcasting */
  txChain?: Transaction[];
}

export type ChainEvent =
  | { type: 'genesis'; moleculeId: string; txid: string }
  | { type: 'step'; moleculeId: string; step: number; totalSteps: number; txid: string; score: number }
  | { type: 'complete'; moleculeId: string; finalScore: number; totalTxs: number }
  | { type: 'error'; moleculeId: string; step: number; error: string };

export type FundingUtxo = {
  txid: string; vout: number; satoshis: number; script: string; sourceTransaction: Transaction;
};

// --- Fund a wallet (regtest: from node, mainnet: uses existing UTXOs) ---
export async function fundWalletP2PK(wallet: Wallet, amountBsv: number = 0.05): Promise<FundingUtxo> {
  const net = getNetwork();

  if (net.getNetwork() === 'regtest') {
    const regtest = await import('./regtest.js');
    const p2pkhUtxo = regtest.fundWallet(wallet.address, amountBsv);
    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: p2pkhUtxo.sourceTransaction,
      sourceOutputIndex: p2pkhUtxo.vout,
      unlockingScriptTemplate: new P2PKH().unlock(
        wallet.privateKey, 'all', false,
        p2pkhUtxo.satoshis, Script.fromHex(p2pkhUtxo.script),
      ),
    });
    tx.addOutput({ lockingScript: wallet.p2pkLockingScript(), change: true });
    await tx.fee(new SatoshisPerKilobyte(config.feePerKb));
    await tx.sign();
    const txid = regtest.broadcastAndMine(tx);
    return {
      txid, vout: 0, satoshis: tx.outputs[0].satoshis!,
      script: wallet.p2pkLockingScript().toHex(),
      sourceTransaction: Transaction.fromHex(regtest.getRawTx(txid)),
    };
  }

  // Mainnet/testnet: return largest UTXO from wallet
  const utxos = wallet.getUtxos();
  if (utxos.length === 0) throw new Error('No UTXOs. Fund wallet: ' + wallet.address);
  const best = [...utxos].sort((a, b) => b.satoshis - a.satoshis)[0];
  return {
    txid: best.txid, vout: best.vout, satoshis: best.satoshis,
    script: best.script, sourceTransaction: best.sourceTransaction!,
  };
}

// --- Bulk fund: create many P2PK UTXOs in one TX ---
// On regtest: funds from node wallet. On mainnet/testnet: uses wallet's own UTXOs.
export async function bulkFundWalletP2PK(
  wallet: Wallet,
  count: number,
  satsPerUtxo: number = 10000,
): Promise<FundingUtxo[]> {
  const net = getNetwork();
  const totalNeeded = count * satsPerUtxo + 10000; // extra for fees

  if (net.getNetwork() === 'regtest') {
    // Regtest: fund from node coinbase wallet
    const regtest = await import('./regtest.js');
    const amountBsv = parseFloat((totalNeeded / 1e8 + 0.01).toFixed(8));
    const p2pkhUtxo = regtest.fundWallet(wallet.address, amountBsv);

    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: p2pkhUtxo.sourceTransaction,
      sourceOutputIndex: p2pkhUtxo.vout,
      unlockingScriptTemplate: new P2PKH().unlock(
        wallet.privateKey, 'all', false,
        p2pkhUtxo.satoshis, Script.fromHex(p2pkhUtxo.script),
      ),
    });

    const lockScript = wallet.p2pkLockingScript();
    for (let i = 0; i < count; i++) {
      tx.addOutput({ lockingScript: lockScript, satoshis: satsPerUtxo });
    }
    tx.addOutput({ lockingScript: lockScript, change: true });
    await tx.fee(new SatoshisPerKilobyte(config.feePerKb));
    await tx.sign();

    const txid = regtest.broadcastAndMine(tx);
    const sourceTx = Transaction.fromHex(regtest.getRawTx(txid));
    const scriptHex = lockScript.toHex();

    return Array.from({ length: count }, (_, i) => ({
      txid, vout: i, satoshis: satsPerUtxo, script: scriptHex, sourceTransaction: sourceTx,
    }));
  }

  // Mainnet/testnet: use wallet's own UTXOs
  let utxos = wallet.getUtxos();
  if (utxos.length === 0) {
    // Fetch UTXOs from WoC
    const wocUtxos = await net.fetchUtxos(wallet.address);
    for (const u of wocUtxos) {
      // Fetch the source TX for spending
      const wocBase = net.getNetwork() === 'mainnet'
        ? 'https://api.whatsonchain.com/v1/bsv/main'
        : 'https://api.whatsonchain.com/v1/bsv/test';
      const resp = await fetch(`${wocBase}/tx/${u.txid}/hex`);
      if (!resp.ok) continue;
      const txHex = await resp.text();
      wallet.addUtxo({
        txid: u.txid,
        vout: u.vout,
        satoshis: u.satoshis,
        script: wallet.p2pkLockingScript().toHex(),
        sourceTransaction: Transaction.fromHex(txHex),
      });
    }
    utxos = wallet.getUtxos();
  }

  if (utxos.length === 0) throw new Error('No UTXOs available. Fund the wallet first: ' + wallet.address);

  // Find a UTXO large enough, or combine multiple
  const sortedUtxos = [...utxos].sort((a, b) => b.satoshis - a.satoshis);
  const utxo = sortedUtxos[0];
  if (utxo.satoshis < totalNeeded) {
    throw new Error(`Largest UTXO (${utxo.satoshis} sats) too small. Need ${totalNeeded} sats.`);
  }

  // Build fan-out TX
  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: utxo.sourceTransaction,
    sourceOutputIndex: utxo.vout,
    unlockingScriptTemplate: wallet.p2pkUnlock(utxo.satoshis, Script.fromHex(utxo.script)),
  });

  const lockScript = wallet.p2pkLockingScript();
  for (let i = 0; i < count; i++) {
    tx.addOutput({ lockingScript: lockScript, satoshis: satsPerUtxo });
  }
  tx.addOutput({ lockingScript: lockScript, change: true });
  await tx.fee(new SatoshisPerKilobyte(config.feePerKb));
  await tx.sign();

  const txid = await net.broadcast(tx);
  wallet.spendUtxo(utxo.txid, utxo.vout);

  // Track change output as new UTXO
  const changeIdx = count; // change is output after all funded outputs
  const changeSats = tx.outputs[changeIdx]?.satoshis;
  if (changeSats && changeSats > 0) {
    wallet.addUtxo({
      txid, vout: changeIdx, satoshis: changeSats,
      script: lockScript.toHex(), sourceTransaction: tx,
    });
  }

  const scriptHex = lockScript.toHex();
  return Array.from({ length: count }, (_, i) => ({
    txid, vout: i, satoshis: satsPerUtxo, script: scriptHex, sourceTransaction: tx,
  }));
}

// --- Execute chain steps from a pre-built genesis TX (for worker agents) ---
// When broadcast=false (default), builds entire chain in memory without touching the network.
// Returns txChain[] for deferred broadcasting by a BroadcastAgent.
//
// With SIGHASH_SINGLE|ANYONECANPAY (0xC3) covenant:
// - Each chain TX can have a fee input (input 1) to pay miner fees
// - The final chain TX can include a payment output (output 1) to the compute agent
// - The covenant only verifies output 0 (covenant continuation) via SIGHASH_SINGLE
export async function executeChainSteps(
  molecule: Molecule,
  receptor: ReceptorSite,
  compiledAsm: string,
  genesisTx: Transaction,
  genesisTxid: string,
  opts: ChainExecOptions = {},
): Promise<ChainResult> {
  const { feeUtxos, feeWallet, paymentPubkey, paymentSats, onEvent, stepDelayMs = 0, broadcast = false } = opts;
  const t0 = performance.now();
  const numAtoms = molecule.atoms.length;
  const numSteps = receptor.atoms.length;
  const stepTxids: string[] = [];
  const states: ChainState[] = [];
  const txChain: Transaction[] = [genesisTx];
  let totalBytes = Math.floor(genesisTx.toHex().length / 2);

  try {
    let prevTx = genesisTx;
    let currentTxid = genesisTxid;
    let currentScore = 0;

    for (let step = 0; step < numSteps; step++) {
      if (stepDelayMs > 0) await new Promise(r => setTimeout(r, stepDelayMs));

      const receptorAtom = receptor.atoms[step];
      const batch = computeBatchEnergy(molecule.atoms, receptorAtom);
      const newScore = currentScore + batch.batchTotal;
      const isLastStep = step === numSteps - 1;

      const scriptSigHex = buildChainScriptSig(
        currentTxid, 1, batch.batchTotal, newScore, batch.pairs,
      );

      const chainTx = new Transaction();
      chainTx.version = 2;
      chainTx.lockTime = 0;

      // Input 0: covenant UTXO (verified by on-chain script)
      chainTx.addInput({
        sourceTransaction: prevTx,
        sourceOutputIndex: 0,
        unlockingScript: Script.fromHex(scriptSigHex),
        sequence: 0xffffffff,
      });

      // Input 1 (optional): fee UTXO from agent wallet
      // ANYONECANPAY allows extra inputs without breaking covenant verification
      const feeUtxo = feeUtxos?.[step];
      if (feeUtxo && feeWallet) {
        chainTx.addInput({
          sourceTransaction: feeUtxo.sourceTransaction,
          sourceTXID: feeUtxo.txid,
          sourceOutputIndex: feeUtxo.vout,
          unlockingScriptTemplate: feeWallet.p2pkUnlock(
            feeUtxo.satoshis, Script.fromHex(feeUtxo.script),
          ),
          sequence: 0xffffffff,
        });
      }

      // Output 0: covenant continuation (verified by SIGHASH_SINGLE)
      const nextLock = buildChainLockScript(numAtoms, newScore, compiledAsm);
      chainTx.addOutput({ lockingScript: nextLock, satoshis: 1 });

      // Output 1 (final step only): payment to compute agent
      // SIGHASH_SINGLE only signs output 0, so output 1+ are unconstrained
      if (isLastStep && paymentPubkey && paymentSats && paymentSats > 0) {
        const pubkeyBytes = Buffer.from(paymentPubkey, 'hex');
        const paymentLock = new LockingScript([
          { op: pubkeyBytes.length, data: [...pubkeyBytes] },
          { op: 0xac }, // OP_CHECKSIG
        ]);
        chainTx.addOutput({ lockingScript: paymentLock, satoshis: paymentSats });
      }

      // Output 2 (if fee input): change back to fee wallet
      if (feeUtxo && feeWallet) {
        chainTx.addOutput({ lockingScript: feeWallet.p2pkLockingScript(), change: true });
      }

      // Sign fee inputs (covenant input 0 is already signed via scriptSig)
      if (feeUtxo && feeWallet) {
        await chainTx.fee(new SatoshisPerKilobyte(config.feePerKb));
        await chainTx.sign();
      }

      // Compute txid
      const chainTxid = broadcast
        ? await getNetwork().broadcast(chainTx)
        : chainTx.id('hex');

      totalBytes += Math.floor(chainTx.toHex().length / 2);
      stepTxids.push(chainTxid);
      txChain.push(chainTx);

      states.push({
        scoreIn: currentScore,
        scoreOut: newScore,
        receptorIdx: step,
        txid: chainTxid,
      });

      onEvent?.({ type: 'step', moleculeId: molecule.id, step: step + 1, totalSteps: numSteps, txid: chainTxid, score: newScore });

      prevTx = chainTx;
      currentTxid = chainTxid;
      currentScore = newScore;
    }

    const totalTxs = 1 + numSteps;
    onEvent?.({ type: 'complete', moleculeId: molecule.id, finalScore: currentScore, totalTxs });

    return {
      moleculeId: molecule.id,
      genesisTxid,
      stepTxids,
      states,
      finalScore: currentScore,
      totalTxs,
      totalBytes,
      status: 'completed',
      durationMs: performance.now() - t0,
      txChain,
    };
  } catch (err: any) {
    const step = stepTxids.length;
    onEvent?.({ type: 'error', moleculeId: molecule.id, step, error: err.message });
    return {
      moleculeId: molecule.id,
      genesisTxid,
      stepTxids,
      states,
      finalScore: 0,
      totalTxs: 0,
      totalBytes,
      status: 'failed',
      error: err.message,
      durationMs: performance.now() - t0,
      txChain,
    };
  }
}

// --- Execute a full covenant chain for one molecule ---
// Fast mode: broadcast without mining (spend unconfirmed outputs), skip getRawTx round-trips
export async function executeChain(
  molecule: Molecule,
  receptor: ReceptorSite,
  wallet: Wallet,
  compiledAsm: string,
  fundingUtxo: { txid: string; vout: number; satoshis: number; script: string; sourceTransaction: Transaction },
  onEvent?: (event: ChainEvent) => void,
  fast: boolean = false,
): Promise<ChainResult> {
  const t0 = performance.now();
  const numAtoms = molecule.atoms.length;
  const numSteps = receptor.atoms.length;
  const stepTxids: string[] = [];
  const states: ChainState[] = [];
  const net = getNetwork();
  const broadcastFn = async (tx: Transaction) => {
    const txid = await net.broadcast(tx);
    if (!fast) await net.mine(1);
    return txid;
  };

  try {
    // Genesis TX
    const genesisTx = new Transaction();
    genesisTx.version = 2;
    genesisTx.addInput({
      sourceTransaction: fundingUtxo.sourceTransaction,
      sourceOutputIndex: fundingUtxo.vout,
      unlockingScriptTemplate: wallet.p2pkUnlock(fundingUtxo.satoshis, Script.fromHex(fundingUtxo.script)),
    });
    const covenantLock = buildChainLockScript(numAtoms, 0, compiledAsm);
    genesisTx.addOutput({ lockingScript: covenantLock, satoshis: 1 });
    genesisTx.addOutput({ lockingScript: wallet.p2pkLockingScript(), change: true });
    await genesisTx.fee(new SatoshisPerKilobyte(config.feePerKb));
    await genesisTx.sign();

    const genesisTxid = await broadcastFn(genesisTx);
    onEvent?.({ type: 'genesis', moleculeId: molecule.id, txid: genesisTxid });

    // Chain steps — use in-memory TX objects to avoid getRawTx round-trips
    let prevTx = genesisTx;
    let currentTxid = genesisTxid;
    let currentScore = 0;

    for (let step = 0; step < numSteps; step++) {
      const receptorAtom = receptor.atoms[step];
      const batch = computeBatchEnergy(molecule.atoms, receptorAtom);
      const newScore = currentScore + batch.batchTotal;

      const scriptSigHex = buildChainScriptSig(
        currentTxid, 1, batch.batchTotal, newScore, batch.pairs,
      );

      const chainTx = new Transaction();
      chainTx.version = 2;
      chainTx.lockTime = 0;

      chainTx.addInput({
        sourceTransaction: prevTx,
        sourceOutputIndex: 0,
        unlockingScript: Script.fromHex(scriptSigHex),
        sequence: 0xffffffff,
      });

      const nextLock = buildChainLockScript(numAtoms, newScore, compiledAsm);
      chainTx.addOutput({ lockingScript: nextLock, satoshis: 1 });

      const chainTxid = await broadcastFn(chainTx);
      stepTxids.push(chainTxid);

      states.push({
        scoreIn: currentScore,
        scoreOut: newScore,
        receptorIdx: step,
        txid: chainTxid,
      });

      onEvent?.({ type: 'step', moleculeId: molecule.id, step: step + 1, totalSteps: numSteps, txid: chainTxid, score: newScore });

      prevTx = chainTx;
      currentTxid = chainTxid;
      currentScore = newScore;
    }

    const totalTxs = 1 + numSteps;
    onEvent?.({ type: 'complete', moleculeId: molecule.id, finalScore: currentScore, totalTxs });

    return {
      moleculeId: molecule.id,
      genesisTxid,
      stepTxids,
      states,
      finalScore: currentScore,
      totalTxs,
      totalBytes: 0,
      status: 'completed',
      durationMs: performance.now() - t0,
    };
  } catch (err: any) {
    const step = stepTxids.length;
    onEvent?.({ type: 'error', moleculeId: molecule.id, step, error: err.message });
    return {
      moleculeId: molecule.id,
      genesisTxid: '',
      stepTxids,
      states,
      finalScore: 0,
      totalTxs: 0,
      totalBytes: 0,
      status: 'failed',
      error: err.message,
      durationMs: performance.now() - t0,
    };
  }
}
