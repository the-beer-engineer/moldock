import {
  Transaction,
  Script,
  LockingScript,
  SatoshisPerKilobyte,
} from '@bsv/sdk';
import type { Atom, PairResult, ChainState } from './types.js';
import { computeBatchEnergy } from './energy.js';
import { buildChainLockScript } from './genesis.js';

export interface ChainUTXO {
  txid: string;
  vout: number;
  satoshis: number;
  script: string;
  scoreIn: number;
  sourceTransaction?: Transaction;
}

// Create one chain step TX
export function createChainStepTx(
  utxo: ChainUTXO,
  ligandAtoms: Atom[],
  receptorAtom: Atom,
  numAtoms: number,
  compiledAsm: string,
): { tx: Transaction; newState: ChainState; batch: ReturnType<typeof computeBatchEnergy> } {
  // Compute energies off-chain
  const batch = computeBatchEnergy(ligandAtoms, receptorAtom);
  const scoreOut = utxo.scoreIn + batch.batchTotal;

  const tx = new Transaction();

  // Input: spend previous chain UTXO
  // The unlocking script for the covenant is constructed by the sxc simulator.
  // For real broadcast, we need to construct the sighash preimage matching
  // what signCtx expects, then provide the DER signature.
  //
  // For now, we build the scriptSig data values.
  // The actual signing requires the signCtx pattern.
  tx.addInput({
    sourceTXID: utxo.txid,
    sourceOutputIndex: utxo.vout,
    sourceTransaction: utxo.sourceTransaction,
    unlockingScript: new Script() as any,
    sequence: 0xffffffff,
  });

  // Output: continuation UTXO with updated score
  const lockScript = buildChainLockScript(numAtoms, scoreOut, compiledAsm);
  tx.addOutput({
    lockingScript: lockScript,
    satoshis: 1,
  });

  const newState: ChainState = {
    scoreIn: utxo.scoreIn,
    scoreOut,
    receptorIdx: -1,
  };

  return { tx, newState, batch };
}

// Build the complete scriptSig data for a chain step
// This produces the values that the .sx script expects
export function buildChainScriptSigData(
  prevTxid: Buffer,     // 32 bytes LE
  inputSats: number,
  batchTotal: number,
  scoreOut: number,
  pairs: PairResult[],
): Buffer[] {
  const parts: Buffer[] = [];

  // prevTxid (32 bytes)
  parts.push(prevTxid);

  // inputSats (8 bytes LE)
  const satsBuf = Buffer.alloc(8);
  satsBuf.writeUInt32LE(inputSats, 0);
  parts.push(satsBuf);

  // batchTotal (script number)
  parts.push(encodeScriptNumber(batchTotal));

  // scoreOutN (script number)
  parts.push(encodeScriptNumber(scoreOut));

  // Per-atom data (atom1 first = deepest on stack)
  for (const pair of pairs) {
    parts.push(encodeScriptNumber(pair.hbond));
    parts.push(encodeScriptNumber(pair.elec));
    parts.push(encodeScriptNumber(pair.vdw));
    parts.push(encodeScriptNumber(pair.dist));
    parts.push(encodeScriptNumber(pair.dsq));
  }

  return parts;
}

// Encode an integer as a Bitcoin Script number (minimal encoding, LE, sign bit)
function encodeScriptNumber(n: number): Buffer {
  if (n === 0) return Buffer.alloc(0);

  const neg = n < 0;
  let abs = Math.abs(n);
  const bytes: number[] = [];

  while (abs > 0) {
    bytes.push(abs & 0xff);
    abs >>= 8;
  }

  // If high bit set, add a sign byte
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(neg ? 0x80 : 0x00);
  } else if (neg) {
    bytes[bytes.length - 1] |= 0x80;
  }

  return Buffer.from(bytes);
}
