/**
 * Test: Verify SIGHASH_SINGLE|ANYONECANPAY covenant works on regtest.
 *
 * This test:
 * 1. Compiles the updated covenant with 0xC3 sighash
 * 2. Creates a genesis TX with covenant output
 * 3. Spends covenant with a chain step TX (NO extra inputs — baseline)
 * 4. Spends covenant with a chain step TX WITH an extra fee input
 * 5. Verifies both succeed on regtest
 */

import { Transaction, P2PKH, Script, LockingScript, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import { generateChainSx } from './chainTemplate.js';
import { compileSxToLockHex, buildChainLockScript } from './genesis.js';
import { computeBatchEnergy } from './energy.js';
import * as regtest from './regtest.js';
import { readFileSync } from 'fs';

const NUM_ATOMS = 3;  // small for quick test

// Load a test molecule
const library = JSON.parse(readFileSync(new URL('../data/cdk2/library.json', import.meta.url), 'utf-8'));

const molecule = library.molecules[0];
const receptor = library.receptor;

console.log(`\n=== Testing SIGHASH_SINGLE|ANYONECANPAY Covenant ===`);
console.log(`Molecule: ${molecule.id} (${molecule.atoms.length} atoms)`);
console.log(`Receptor: ${receptor.atoms.length} atoms (chain steps)`);

// 1. Compile the covenant
console.log(`\n[1] Compiling covenant for ${molecule.atoms.length} atoms...`);
const sx = generateChainSx(molecule.atoms.length);
const compiledAsm = compileSxToLockHex(sx, `test_sighash_${molecule.atoms.length}.sx`);
console.log(`    Compiled ASM length: ${compiledAsm.length} chars`);

// 2. Create wallet and fund it
const wallet = new Wallet();
console.log(`\n[2] Wallet: ${wallet.address}`);

const p2pkhUtxo = regtest.fundWallet(wallet.address, 0.1);
console.log(`    Funded: ${p2pkhUtxo.satoshis} sats`);

// Convert P2PKH to P2PK
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
console.log(`    P2PK convert: ${convertTxid}`);

const fundingSats = convertTx.outputs[0].satoshis!;
const fundingScript = wallet.p2pkLockingScript().toHex();

// 3. Create genesis TX
console.log(`\n[3] Creating genesis TX...`);
const genesisTx = new Transaction();
genesisTx.version = 2;
genesisTx.addInput({
  sourceTransaction: convertTx,
  sourceOutputIndex: 0,
  unlockingScriptTemplate: wallet.p2pkUnlock(fundingSats, Script.fromHex(fundingScript)),
});
const covenantLock = buildChainLockScript(molecule.atoms.length, 0, compiledAsm);
genesisTx.addOutput({ lockingScript: covenantLock, satoshis: 1 });
genesisTx.addOutput({ lockingScript: wallet.p2pkLockingScript(), change: true });
await genesisTx.fee(new SatoshisPerKilobyte(1));
await genesisTx.sign();

const genesisTxid = regtest.broadcastAndMine(genesisTx);
console.log(`    Genesis TX: ${genesisTxid}`);
console.log(`    Covenant output: ${genesisTx.outputs[0].lockingScript!.toHex().length / 2} bytes`);
console.log(`    Genesis TX size: ${Math.floor(genesisTx.toHex().length / 2)} bytes`);

// Helper: build scriptSig for chain step
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

// 4. Chain step 1 — NO extra inputs (baseline test)
console.log(`\n[4] Chain step 1 (baseline — no fee input)...`);
const receptorAtom0 = receptor.atoms[0];
const batch0 = computeBatchEnergy(molecule.atoms, receptorAtom0);
const score1 = batch0.batchTotal;

const scriptSig0 = buildChainScriptSig(genesisTxid, 1, batch0.batchTotal, score1, batch0.pairs);

const step1Tx = new Transaction();
step1Tx.version = 2;
step1Tx.lockTime = 0;
step1Tx.addInput({
  sourceTransaction: genesisTx,
  sourceOutputIndex: 0,
  unlockingScript: Script.fromHex(scriptSig0),
  sequence: 0xffffffff,
});
const nextLock1 = buildChainLockScript(molecule.atoms.length, score1, compiledAsm);
step1Tx.addOutput({ lockingScript: nextLock1, satoshis: 1 });

const step1Txid = regtest.broadcastOnly(step1Tx);
console.log(`    Step 1 TX: ${step1Txid}`);
console.log(`    Score: 0 → ${score1}`);
console.log(`    Step 1 TX size: ${Math.floor(step1Tx.toHex().length / 2)} bytes`);

// 5. Chain step 2 — WITH extra fee input (the key test!)
console.log(`\n[5] Chain step 2 (WITH fee input — ANYONECANPAY test)...`);

// Create a fee UTXO from the wallet change
const changeSats = genesisTx.outputs[1].satoshis!;
const changeScript = wallet.p2pkLockingScript().toHex();

const receptorAtom1 = receptor.atoms[1];
const batch1 = computeBatchEnergy(molecule.atoms, receptorAtom1);
const score2 = score1 + batch1.batchTotal;

const scriptSig1 = buildChainScriptSig(step1Txid, 1, batch1.batchTotal, score2, batch1.pairs);

const step2Tx = new Transaction();
step2Tx.version = 2;
step2Tx.lockTime = 0;

// Input 0: covenant UTXO
step2Tx.addInput({
  sourceTransaction: step1Tx,
  sourceOutputIndex: 0,
  unlockingScript: Script.fromHex(scriptSig1),
  sequence: 0xffffffff,
});

// Input 1: fee input from wallet (ANYONECANPAY allows this!)
step2Tx.addInput({
  sourceTransaction: genesisTx,
  sourceOutputIndex: 1,
  unlockingScriptTemplate: wallet.p2pkUnlock(changeSats, Script.fromHex(changeScript)),
  sequence: 0xffffffff,
});

// Output 0: covenant continuation (SIGHASH_SINGLE only signs this)
const nextLock2 = buildChainLockScript(molecule.atoms.length, score2, compiledAsm);
step2Tx.addOutput({ lockingScript: nextLock2, satoshis: 1 });

// Output 1: change back to wallet (not covered by SIGHASH_SINGLE)
step2Tx.addOutput({ lockingScript: wallet.p2pkLockingScript(), change: true });

await step2Tx.fee(new SatoshisPerKilobyte(10));  // Use realistic fee rate
await step2Tx.sign();

try {
  const step2Txid = regtest.broadcastOnly(step2Tx);
  console.log(`    ✅ Step 2 TX: ${step2Txid}`);
  console.log(`    Score: ${score1} → ${score2}`);
  console.log(`    Step 2 TX size: ${Math.floor(step2Tx.toHex().length / 2)} bytes`);
  console.log(`    Fee input: ${changeSats} sats from wallet`);
  console.log(`    Change output: ${step2Tx.outputs[1].satoshis} sats`);
} catch (err: any) {
  console.error(`    ❌ FAILED: ${err.message}`);
  process.exit(1);
}

// Mine to confirm all
regtest.mine(1);

console.log(`\n=== ALL TESTS PASSED ===`);
console.log(`SIGHASH_SINGLE|ANYONECANPAY covenant works with fee inputs!\n`);
