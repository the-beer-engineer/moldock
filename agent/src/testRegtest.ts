import { Transaction, P2PKH, LockingScript, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import * as regtest from './regtest.js';

console.log('=== Regtest P2PK Integration Test ===\n');

// Step 1: Check node
console.log(`Block height: ${regtest.getBlockCount()}`);
console.log(`Wallet balance: ${regtest.getBalance()} BSV`);

// Step 2: Create agent wallet
const wallet = new Wallet(undefined, 'regtest');
console.log(`Agent address (regtest): ${wallet.address}`);
console.log(`Agent pubkey: ${wallet.publicKeyHex}`);

// Step 3: Fund agent wallet from regtest node (creates P2PKH UTXO)
console.log('\nFunding agent wallet...');
const utxo = regtest.fundWallet(wallet.address, 0.01);
console.log(`Funded: ${utxo.txid}:${utxo.vout} (${utxo.satoshis} sats)`);
wallet.addUtxo(utxo);

// Step 4: Build TX: P2PKH input → P2PK output (send to self)
console.log('\n--- Test 1: P2PKH → P2PK ---');
const tx1 = new Transaction();

tx1.addInput({
  sourceTransaction: utxo.sourceTransaction,
  sourceOutputIndex: utxo.vout,
  unlockingScriptTemplate: new P2PKH().unlock(
    wallet.privateKey,
    'all',
    false,
    utxo.satoshis,
    Script.fromHex(utxo.script),
  ),
});

// Output: P2PK to ourselves
tx1.addOutput({
  lockingScript: wallet.p2pkLockingScript(),
  satoshis: 5000,
});

// Change: also P2PK to ourselves
tx1.addOutput({
  lockingScript: wallet.p2pkLockingScript(),
  change: true,
});

await tx1.fee(new SatoshisPerKilobyte(1));
await tx1.sign();

console.log(`TX1 hex length: ${tx1.toHex().length}`);
console.log(`TX1 id: ${tx1.id('hex')}`);

try {
  const txid1 = regtest.broadcastAndMine(tx1);
  console.log(`Broadcast + mined: ${txid1}`);
  console.log('P2PKH → P2PK: PASS ✓');

  // Track the new P2PK UTXOs
  const p2pkUtxo = {
    txid: txid1,
    vout: 0,
    satoshis: 5000,
    script: wallet.p2pkLockingScript().toHex(),
    sourceTransaction: Transaction.fromHex(regtest.getRawTx(txid1)),
  };
  wallet.spendUtxo(utxo.txid, utxo.vout);

  // Step 5: P2PK → P2PK (spend the P2PK output)
  console.log('\n--- Test 2: P2PK → P2PK ---');
  const tx2 = new Transaction();

  tx2.addInput({
    sourceTransaction: p2pkUtxo.sourceTransaction,
    sourceOutputIndex: p2pkUtxo.vout,
    unlockingScriptTemplate: wallet.p2pkUnlock(
      p2pkUtxo.satoshis,
      Script.fromHex(p2pkUtxo.script),
    ),
  });

  tx2.addOutput({
    lockingScript: wallet.p2pkLockingScript(),
    satoshis: 1000,
  });

  tx2.addOutput({
    lockingScript: wallet.p2pkLockingScript(),
    change: true,
  });

  await tx2.fee(new SatoshisPerKilobyte(1));
  await tx2.sign();

  console.log(`TX2 hex length: ${tx2.toHex().length}`);
  console.log(`TX2 id: ${tx2.id('hex')}`);

  const txid2 = regtest.broadcastAndMine(tx2);
  console.log(`Broadcast + mined: ${txid2}`);
  console.log('P2PK → P2PK: PASS ✓');

} catch (err: any) {
  console.log(`Broadcast failed: ${err.message}`);

  try {
    const decoded = regtest.decodeTx(tx1.toHex());
    console.log('Decoded TX:', JSON.stringify(decoded, null, 2).substring(0, 500));
  } catch {}

  console.log('Test: FAIL ✗');
  process.exit(1);
}

console.log('\n=== Regtest P2PK tests complete ===');
