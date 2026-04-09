import { Transaction, P2PKH, Script, LockingScript, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import * as regtest from './regtest.js';
import { generateChainSx } from './chainTemplate.js';
import { compileSxToLockHex, buildChainLockScript, createGenesisTx } from './genesis.js';
import { generateMolecule, generateReceptorSite } from './generate.js';

console.log('=== Regtest Covenant Genesis Test ===\n');

const NUM_ATOMS = 3;

// Step 1: Create wallet and fund it
const wallet = new Wallet(undefined, 'regtest');
console.log(`Agent pubkey: ${wallet.publicKeyHex}`);

// Fund with P2PKH from node, then convert to P2PK
const p2pkhUtxo = regtest.fundWallet(wallet.address, 0.05);
console.log(`P2PKH funding: ${p2pkhUtxo.txid}:${p2pkhUtxo.vout} (${p2pkhUtxo.satoshis} sats)`);

// Convert to P2PK UTXO
const convertTx = new Transaction();
convertTx.addInput({
  sourceTransaction: p2pkhUtxo.sourceTransaction,
  sourceOutputIndex: p2pkhUtxo.vout,
  unlockingScriptTemplate: new P2PKH().unlock(
    wallet.privateKey, 'all', false,
    p2pkhUtxo.satoshis, Script.fromHex(p2pkhUtxo.script),
  ),
});
convertTx.addOutput({
  lockingScript: wallet.p2pkLockingScript(),
  change: true,
});
await convertTx.fee(new SatoshisPerKilobyte(1));
await convertTx.sign();

const convertTxid = regtest.broadcastAndMine(convertTx);
console.log(`Converted to P2PK: ${convertTxid}`);

const p2pkUtxo = {
  txid: convertTxid,
  vout: 0,
  satoshis: convertTx.outputs[0].satoshis!,
  script: wallet.p2pkLockingScript().toHex(),
  sourceTransaction: Transaction.fromHex(regtest.getRawTx(convertTxid)),
};

// Step 2: Compile chain script
console.log(`\nCompiling atomChain for ${NUM_ATOMS} atoms...`);
const sxSource = generateChainSx(NUM_ATOMS);
const compiledAsm = compileSxToLockHex(sxSource, `chain_${NUM_ATOMS}.sx`);
console.log(`Compiled ASM length: ${compiledAsm.length}`);
console.log(`ASM preview: ${compiledAsm.substring(0, 120)}...`);

// Step 3: Build genesis TX
console.log('\nBuilding genesis TX...');
const molecule = generateMolecule(NUM_ATOMS);

const genesisTx = await createGenesisTx(molecule, NUM_ATOMS, compiledAsm, p2pkUtxo, wallet);
console.log(`Genesis TX hex length: ${genesisTx.toHex().length}`);
console.log(`Genesis TX id: ${genesisTx.id('hex')}`);
console.log(`Output 0 (covenant): ${genesisTx.outputs[0].satoshis} sats, script len ${genesisTx.outputs[0].lockingScript!.toHex().length / 2} bytes`);
console.log(`Output 1 (OP_RETURN): ${genesisTx.outputs[1].satoshis} sats`);
if (genesisTx.outputs[2]) {
  console.log(`Output 2 (change): ${genesisTx.outputs[2].satoshis} sats`);
}

// Step 4: Broadcast genesis
try {
  const genesisTxid = regtest.broadcastAndMine(genesisTx);
  console.log(`Genesis broadcast + mined: ${genesisTxid}`);
  console.log('Covenant genesis: PASS ✓');
} catch (err: any) {
  console.log(`Genesis broadcast failed: ${err.message}`);
  try {
    const decoded = regtest.decodeTx(genesisTx.toHex());
    console.log('Decoded genesis TX:', JSON.stringify(decoded, null, 2).substring(0, 800));
  } catch {}
  console.log('Covenant genesis: FAIL ✗');
  process.exit(1);
}

console.log('\n=== Genesis test complete ===');
