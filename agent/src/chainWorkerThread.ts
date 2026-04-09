/**
 * Chain worker thread — runs inside a Node worker_thread.
 * Receives work items via parentPort messages, builds chains in memory,
 * returns results. Uses the same compute path as remote agents.
 *
 * Message protocol (same for local threads and remote agents):
 *   Main → Worker: { type: 'work', molecule, receptor, compiledAsm, genesisTxHex, genesisTxid }
 *   Worker → Main: { type: 'result', ...ChainResult (serialized) }
 *   Worker → Main: { type: 'event', ...ChainEvent }
 *   Main → Worker: { type: 'shutdown' }
 */
import { parentPort, workerData } from 'worker_threads';
import { Transaction, Script } from '@bsv/sdk';
import { computeBatchEnergy } from './energy.js';
import type { Molecule, ReceptorSite, Atom, ChainState } from './types.js';

if (!parentPort) {
  throw new Error('chainWorkerThread must be run as a worker_thread');
}

const workerId: number = workerData?.workerId ?? 0;
const workerName: string = workerData?.workerName ?? `Worker-${workerId}`;

// --- Script construction (duplicated from chainBuilder.ts to be self-contained) ---

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

// Cache for body hex extracted from compiledAsm (ASM text → hex)
const bodyHexCache = new Map<string, string>();

function buildChainLockScript(numAtoms: number, score: number, compiledAsm: string): Script {
  // compiledAsm is ASM text: "<scoreInN> OP_DROP <body...>"
  let cachedBodyHex = bodyHexCache.get(compiledAsm);
  if (!cachedBodyHex) {
    const parts = compiledAsm.split('OP_DROP ');
    if (parts.length < 2) throw new Error('Could not find OP_DROP in compiled chain ASM');
    const bodyAsm = parts.slice(1).join('OP_DROP ');
    cachedBodyHex = Script.fromASM(bodyAsm).toHex();
    bodyHexCache.set(compiledAsm, cachedBodyHex);
  }
  // Encode score as 4-byte signed LE push
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

// --- Chain execution ---

interface WorkMessage {
  type: 'work';
  molecule: Molecule;
  receptor: ReceptorSite;
  compiledAsm: string;
  genesisTxHex: string;
  genesisTxid: string;
  stepDelayMs?: number;
}

interface ResultMessage {
  type: 'result';
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
  txHexes: string[];  // serialized TX chain (hex strings, not objects)
}

function executeChain(msg: WorkMessage): ResultMessage {
  const t0 = performance.now();
  const { molecule, receptor, compiledAsm, genesisTxHex, genesisTxid } = msg;
  const numAtoms = molecule.atoms.length;
  const numSteps = receptor.atoms.length;
  const stepTxids: string[] = [];
  const states: ChainState[] = [];
  const txHexes: string[] = [genesisTxHex];

  try {
    let prevTx = Transaction.fromHex(genesisTxHex);
    let currentTxid = genesisTxid;
    let currentScore = 0;
    let totalBytes = Math.floor(genesisTxHex.length / 2);

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

      const chainTxid = chainTx.id('hex');
      const chainTxHex = chainTx.toHex();
      totalBytes += Math.floor(chainTxHex.length / 2);
      stepTxids.push(chainTxid);
      txHexes.push(chainTxHex);

      states.push({
        scoreIn: currentScore,
        scoreOut: newScore,
        receptorIdx: step,
        txid: chainTxid,
      });

      // Emit step event to parent
      parentPort!.postMessage({
        type: 'event',
        event: {
          type: 'step',
          moleculeId: molecule.id,
          step: step + 1,
          totalSteps: numSteps,
          txid: chainTxid,
          score: newScore,
        },
      });

      prevTx = chainTx;
      currentTxid = chainTxid;
      currentScore = newScore;
    }

    parentPort!.postMessage({
      type: 'event',
      event: {
        type: 'complete',
        moleculeId: molecule.id,
        finalScore: currentScore,
        totalTxs: 1 + numSteps,
      },
    });

    return {
      type: 'result',
      moleculeId: molecule.id,
      genesisTxid,
      stepTxids,
      states,
      finalScore: currentScore,
      totalTxs: 1 + numSteps,
      totalBytes,
      status: 'completed',
      durationMs: performance.now() - t0,
      txHexes,
    };
  } catch (err: any) {
    return {
      type: 'result',
      moleculeId: molecule.id,
      genesisTxid,
      stepTxids,
      states,
      finalScore: 0,
      totalTxs: 0,
      totalBytes: 0,
      status: 'failed',
      error: err.message,
      durationMs: performance.now() - t0,
      txHexes,
    };
  }
}

// --- Message handler ---
parentPort.on('message', async (msg: any) => {
  if (msg.type === 'shutdown') {
    process.exit(0);
  }

  if (msg.type === 'work') {
    // Optional delay to simulate different agent speeds
    if (msg.stepDelayMs && msg.stepDelayMs > 0) {
      await new Promise(r => setTimeout(r, msg.stepDelayMs));
    }
    const result = executeChain(msg);
    parentPort!.postMessage(result);
  }
});

// Signal ready
parentPort.postMessage({ type: 'ready', workerId, workerName });
