import { Transaction, P2PKH, Script, LockingScript, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import * as regtest from './regtest.js';
import { generateChainSx } from './chainTemplate.js';
import { compileSxToLockHex, buildChainLockScript } from './genesis.js';
import { computeBatchEnergy } from './energy.js';
import type { Molecule, ReceptorSite, ChainState, BatchResult } from './types.js';

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

// --- Fund a wallet from regtest node (single UTXO) ---
export async function fundWalletP2PK(wallet: Wallet, amountBsv: number = 0.05): Promise<FundingUtxo> {
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
  await tx.fee(new SatoshisPerKilobyte(1));
  await tx.sign();
  const txid = regtest.broadcastAndMine(tx);
  return {
    txid,
    vout: 0,
    satoshis: tx.outputs[0].satoshis!,
    script: wallet.p2pkLockingScript().toHex(),
    sourceTransaction: Transaction.fromHex(regtest.getRawTx(txid)),
  };
}

// --- Bulk fund: create many P2PK UTXOs in one TX ---
export async function bulkFundWalletP2PK(
  wallet: Wallet,
  count: number,
  satsPerUtxo: number = 10000,
): Promise<FundingUtxo[]> {
  // Get enough coins from regtest node
  const totalNeeded = count * satsPerUtxo + 10000; // extra for fees
  const amountBsv = parseFloat((totalNeeded / 1e8 + 0.01).toFixed(8));
  const p2pkhUtxo = regtest.fundWallet(wallet.address, amountBsv);

  // Build a fan-out TX: 1 P2PKH input → N P2PK outputs
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
  // Change
  tx.addOutput({ lockingScript: lockScript, change: true });

  await tx.fee(new SatoshisPerKilobyte(1));
  await tx.sign();

  const txid = regtest.broadcastAndMine(tx);
  const sourceTx = Transaction.fromHex(regtest.getRawTx(txid));
  const scriptHex = lockScript.toHex();

  return Array.from({ length: count }, (_, i) => ({
    txid,
    vout: i,
    satoshis: satsPerUtxo,
    script: scriptHex,
    sourceTransaction: sourceTx,
  }));
}

// --- Execute chain steps from a pre-built genesis TX (for worker agents) ---
// When broadcast=false (default), builds entire chain in memory without touching the network.
// Returns txChain[] for deferred broadcasting by a BroadcastAgent.
export async function executeChainSteps(
  molecule: Molecule,
  receptor: ReceptorSite,
  compiledAsm: string,
  genesisTx: Transaction,
  genesisTxid: string,
  onEvent?: (event: ChainEvent) => void,
  stepDelayMs: number = 0,
  broadcast: boolean = false,
): Promise<ChainResult> {
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

      // Compute txid locally — no network call needed
      const chainTxid = broadcast
        ? regtest.broadcastOnly(chainTx)
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
  const broadcast = fast ? regtest.broadcastOnly : regtest.broadcastAndMine;

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
    await genesisTx.fee(new SatoshisPerKilobyte(1));
    await genesisTx.sign();

    const genesisTxid = broadcast(genesisTx);
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

      const chainTxid = broadcast(chainTx);
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
