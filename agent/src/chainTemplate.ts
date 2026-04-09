import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

// Generate an atomChain .sx script parameterized for exactly N ligand atoms.
//
// Why template generation instead of runtime variable repeat?
// pushCodeData captures the compiled hex of chainBody. If chainBody contains
// `repeat .numAtomsN`, the hex includes unexpanded repeat markers, causing a
// hashOutputs mismatch when the covenant reconstructs itself (the actual script
// has N copies unrolled, but pushCodeData captured the unexpanded version).
//
// By generating the .sx source with `repeat Nn` baked in, the compiler fully
// unrolls the loop. pushCodeData captures the unrolled hex, and the covenant
// self-reference matches perfectly. N is constant per molecule (same ligand
// atoms across all chain steps), so this is safe.

export function generateChainSx(numAtoms: number): string {
  // Build the per-atom unlock args list
  const unlockAtomArgs = Array.from({ length: numAtoms }, (_, i) => {
    const n = i + 1;
    return `.hbondN${n} .elecN${n} .vdwN${n} .distN${n} .dsqN${n}`;
  }).join('\n');

  return `import 'std.sxLib'

// Auto-generated atomChain for ${numAtoms} ligand atoms per batch.
// Each TX: verify ${numAtoms} atom pairs, accumulate score, produce continuation UTXO.

#chainBody
    // Stack at entry (top first):
    //   bodyHex,
    //   [5 values per atom * ${numAtoms} atoms],
    //   scoreOutN, batchTotal, inputSats, prevTxid

    toAltStack      // bodyHex -> alt

    // Batch pair verification
    0n              // accumulator = 0

    repeat ${numAtoms}n pairVerify end

    // Stack: acc, scoreOutN, batchTotal, inputSats, prevTxid
    // Verify accumulated energy == batchTotal
    rot                 // batchTotal, acc, scoreOutN, inputSats, prevTxid
    swap equalVerify    // scoreOutN, inputSats, prevTxid

    // Save scoreOutN for hashOutputs
    toAltStack          // inputSats, prevTxid
    dup toAltStack      // save inputSats copy
    // Alt: inputSats_copy, scoreOutN, bodyHex

    swap dup            // prevTxid, prevTxid, inputSats

    // F1+2: nVersion || hashPrevouts
    00000000 cat hash256
    02000000 swap cat
    // F3: hashSequence
    ffffffff hash256 cat
    // F4: outpoint
    swap 00000000 cat cat
    // F5: scriptCode = 01ac
    01ac cat
    // F6: value
    swap cat
    // F7: nSequence
    ffffffff cat

    // F8: hashOutputs
    fromAltStack        // inputSats_copy
    fromAltStack        // scoreOutN
    fromAltStack        // bodyHex

    // Build covenant code: 4d || size_2LE || bodyHex || bodyHex || abac
    dup
    size 2n num2bin
    4d swap cat
    swap cat
    swap cat
    abac cat            // covenantCode

    // Build score pushdata: size||scoreOutN_4bytes||OP_DROP
    // Fixed 4-byte encoding avoids MINIMALDATA violations for small values (1-16, -1)
    // size opcode computes length at runtime (not a data push, so MINIMALDATA doesn't apply)
    swap                // covenantCode, scoreOutN
    4n num2bin          // covenantCode, scoreOutN_4bytes (always 4 bytes)
    size swap cat       // covenantCode, 04||scoreOutN_4bytes
    75 cat              // covenantCode, 04||scoreOutN_4bytes||75
    swap cat            // fullScript

    // hashOutputs
    writeVarInt
    cat
    hash256 cat

    // F9+10
    00000000 cat
    41000000 cat

    // Sign
    41 signCtx
end

#pairVerify
  toAltStack
  swap dup
  dup mul
  2n pick
  lessThanOrEqual verify
  1n add dup mul
  lessThan verify
  add add
  fromAltStack add
end

// scriptSig
.prevTxid .inputSats
.batchTotal .scoreOutN
${unlockAtomArgs}

|

// scriptPubKey
.scoreInN
drop

pushCodeData chainBody
chainBody
codeSeparator
checkSig
`;
}

// Generate a batch-only .sx (no covenant, just verification)
export function generateBatchSx(numAtoms: number): string {
  const unlockAtomArgs = Array.from({ length: numAtoms }, (_, i) => {
    const n = i + 1;
    return `.hbondN${n} .elecN${n} .vdwN${n} .distN${n} .dsqN${n}`;
  }).join('\n');

  return `import 'std.sxLib'

// Auto-generated atomPairBatch for ${numAtoms} ligand atoms.

.sig
.batchTotal
${unlockAtomArgs}

|

.pubKey

toAltStack
0n

repeat ${numAtoms}n pairVerify end

equalVerify
fromAltStack
checkSig

#pairVerify
  toAltStack
  swap dup
  dup mul
  2n pick
  lessThanOrEqual verify
  1n add dup mul
  lessThan verify
  add add
  fromAltStack add
end
`;
}

// Generate an .sxProj.json for simulation testing
export function generateChainSxProj(
  numAtoms: number,
  chainLength: number,
  atomData: Array<{
    pairs: Array<{ dsq: number; dist: number; vdw: number; elec: number; hbond: number }>;
    batchTotal: number;
  }>,
): string {
  const sx = generateChainSx(numAtoms);
  const stdLib = readFileSync(join(config.sxcPath, 'src/sx/lib/std.sxLib'), 'utf-8');

  const sim: any[] = [
    {
      name: 'createChainUTXO',
      vouts: [{ type: 'atomChain', sats: 1, args: { scoreInN: 0 } }],
    },
  ];

  let runningScore = 0;
  for (let step = 0; step < chainLength; step++) {
    const batch = atomData[step];
    const newScore = runningScore + batch.batchTotal;

    const vinArgs: Record<string, any> = {
      prevTxid: step,
      inputSats: '0100000000000000',
      batchTotal: batch.batchTotal,
      scoreOutN: newScore,
    };

    batch.pairs.forEach((p, i) => {
      const n = i + 1;
      vinArgs[`dsqN${n}`] = p.dsq;
      vinArgs[`distN${n}`] = p.dist;
      vinArgs[`vdwN${n}`] = p.vdw;
      vinArgs[`elecN${n}`] = p.elec;
      vinArgs[`hbondN${n}`] = p.hbond;
    });

    sim.push({
      name: `chainStep${step + 1}`,
      debug: 0,
      vins: [{ tx: step, vout: 0, args: vinArgs }],
      vouts: [{ type: 'atomChain', sats: 1, args: { scoreInN: newScore } }],
    });

    runningScore = newScore;
  }

  const proj = {
    name: 'atomChain',
    root: {
      type: 'directory',
      name: 'root',
      path: '/',
      createdAt: new Date().toISOString(),
      children: [
        {
          type: 'file', name: 'atomChain.sx', path: '/atomChain.sx',
          data: sx, createdAt: new Date().toISOString(), extension: 'sx', id: 0,
        },
        {
          type: 'file', name: 'sim.json', path: '/sim.json',
          data: JSON.stringify(sim, null, 2), createdAt: new Date().toISOString(), extension: 'json', id: 1,
        },
        {
          type: 'file', name: 'std.sxLib', path: '/std.sxLib',
          data: stdLib, createdAt: new Date().toISOString(), extension: 'sxLib', id: 2,
        },
      ],
      isEmpty: false,
      id: -1,
    },
    simFileId: 1,
    version: '1.0.0',
  };

  return JSON.stringify(proj, null, 2);
}
