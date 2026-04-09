import { Transaction, P2PKH, Script, LockingScript, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import * as regtest from './regtest.js';
import { generateChainSx } from './chainTemplate.js';
import { compileSxToLockHex, buildChainLockScript } from './genesis.js';
import { generateMolecule, generateReceptorSite } from './generate.js';
import { computeBatchEnergy } from './energy.js';

console.log('=== Regtest Full Covenant Chain Test ===\n');

const NUM_ATOMS = 3;
const NUM_RECEPTOR_ATOMS = 3; // = chain steps

// --- Helper functions ---
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

  // prevTxid: 32 bytes LE (internal byte order)
  const txidBytes = Array.from(Buffer.from(prevTxid, 'hex').reverse());
  parts.push(pushData(txidBytes));

  // inputSats: 8 bytes LE
  const satsBuf = Buffer.alloc(8);
  satsBuf.writeBigUInt64LE(BigInt(inputSats));
  parts.push(pushData(Array.from(satsBuf)));

  // batchTotal, scoreOutN
  parts.push(pushScriptNum(batchTotal));
  parts.push(pushScriptNum(scoreOut));

  // Per-atom: hbond, elec, vdw, dist, dsq (atom 1 pushed first = deepest)
  for (const pair of pairs) {
    parts.push(pushScriptNum(pair.hbond));
    parts.push(pushScriptNum(pair.elec));
    parts.push(pushScriptNum(pair.vdw));
    parts.push(pushScriptNum(pair.dist));
    parts.push(pushScriptNum(pair.dsq));
  }

  return parts.map(p => Buffer.from(p).toString('hex')).join('');
}

// --- Setup ---
const wallet = new Wallet(undefined, 'regtest');
console.log(`Agent pubkey: ${wallet.publicKeyHex}`);

// Fund: P2PKH from node → convert to P2PK
const p2pkhUtxo = regtest.fundWallet(wallet.address, 0.05);
const convertTx = new Transaction();
convertTx.addInput({
  sourceTransaction: p2pkhUtxo.sourceTransaction,
  sourceOutputIndex: p2pkhUtxo.vout,
  unlockingScriptTemplate: new P2PKH().unlock(
    wallet.privateKey, 'all', false,
    p2pkhUtxo.satoshis, Script.fromHex(p2pkhUtxo.script),
  ),
});
convertTx.addOutput({ lockingScript: wallet.p2pkLockingScript(), change: true });
await convertTx.fee(new SatoshisPerKilobyte(1));
await convertTx.sign();
const convertTxid = regtest.broadcastAndMine(convertTx);
console.log(`P2PK funding: ${convertTxid}`);

// --- Compile chain script ---
const sxSource = generateChainSx(NUM_ATOMS);
const compiledAsm = compileSxToLockHex(sxSource, `chain_${NUM_ATOMS}.sx`);
console.log(`Compiled chain script (${compiledAsm.length} chars ASM)`);

const molecule = generateMolecule(NUM_ATOMS);
const receptor = generateReceptorSite(NUM_RECEPTOR_ATOMS);

// --- Genesis TX ---
const genesisTx = new Transaction();
genesisTx.version = 2;

const p2pkUtxo = {
  txid: convertTxid,
  vout: 0,
  satoshis: convertTx.outputs[0].satoshis!,
  script: wallet.p2pkLockingScript().toHex(),
  sourceTransaction: Transaction.fromHex(regtest.getRawTx(convertTxid)),
};

genesisTx.addInput({
  sourceTransaction: p2pkUtxo.sourceTransaction,
  sourceOutputIndex: 0,
  unlockingScriptTemplate: wallet.p2pkUnlock(p2pkUtxo.satoshis, Script.fromHex(p2pkUtxo.script)),
});

const covenantLockScript = buildChainLockScript(NUM_ATOMS, 0, compiledAsm);
genesisTx.addOutput({ lockingScript: covenantLockScript, satoshis: 1 });
genesisTx.addOutput({ lockingScript: wallet.p2pkLockingScript(), change: true });

await genesisTx.fee(new SatoshisPerKilobyte(1));
await genesisTx.sign();

const genesisTxid = regtest.broadcastAndMine(genesisTx);
console.log(`Genesis mined: ${genesisTxid}`);
console.log(`Covenant UTXO: ${genesisTxid}:0 (1 sat, ${covenantLockScript.toHex().length / 2} bytes)\n`);

// --- Chain steps ---
let currentTxid = genesisTxid;
let currentScore = 0;

for (let step = 0; step < NUM_RECEPTOR_ATOMS; step++) {
  const receptorAtom = receptor.atoms[step];
  const batch = computeBatchEnergy(molecule.atoms, receptorAtom);
  const newScore = currentScore + batch.batchTotal;

  console.log(`--- Chain Step ${step + 1}/${NUM_RECEPTOR_ATOMS} ---`);
  console.log(`  Receptor: (${receptorAtom.x}, ${receptorAtom.y}, ${receptorAtom.z})`);
  console.log(`  Batch: ${batch.batchTotal}, Score: ${currentScore} → ${newScore}`);

  const scriptSigHex = buildChainScriptSig(
    currentTxid, 1, batch.batchTotal, newScore, batch.pairs,
  );

  const chainTx = new Transaction();
  chainTx.version = 2;
  chainTx.lockTime = 0;

  const prevRawTx = Transaction.fromHex(regtest.getRawTx(currentTxid));
  chainTx.addInput({
    sourceTransaction: prevRawTx,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromHex(scriptSigHex),
    sequence: 0xffffffff,
  });

  // Output: continuation covenant UTXO with updated score
  const nextLockScript = buildChainLockScript(NUM_ATOMS, newScore, compiledAsm);
  chainTx.addOutput({ lockingScript: nextLockScript, satoshis: 1 });

  try {
    const chainTxid = regtest.broadcastAndMine(chainTx);
    console.log(`  Mined: ${chainTxid}`);
    console.log(`  PASS ✓\n`);
    currentTxid = chainTxid;
    currentScore = newScore;
  } catch (err: any) {
    console.log(`  FAIL: ${err.message.split('\n').slice(0, 3).join(' | ')}`);
    process.exit(1);
  }
}

console.log(`=== Full ${NUM_RECEPTOR_ATOMS}-step chain complete ===`);
console.log(`Final score: ${currentScore}`);
console.log(`Total TXs: ${NUM_RECEPTOR_ATOMS + 1} (1 genesis + ${NUM_RECEPTOR_ATOMS} chain steps)`);
