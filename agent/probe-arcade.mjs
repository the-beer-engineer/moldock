// Directly test what Arcade does with a fresh valid TX built from our wallet.
import { readFileSync } from 'fs';
import { PrivateKey, Transaction, LockingScript, Script, SatoshisPerKilobyte, P2PKH, TransactionSignature, Hash, UnlockingScript } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const pubKeyBytes = pk.toPublicKey().encode(true);
const addr = pk.toAddress();

// Fetch one of our unspent UTXOs from WoC
const base = 'https://api.whatsonchain.com/v1/bsv/main';
const scriptHex = new LockingScript([
  { op: pubKeyBytes.length, data: pubKeyBytes },
  { op: 0xac }
]).toHex();
const { createHash } = await import('crypto');
const scriptHash = Buffer.from(createHash('sha256').update(Buffer.from(scriptHex, 'hex')).digest()).reverse().toString('hex');

const unspent = await fetch(`${base}/script/${scriptHash}/unspent`).then(r => r.json());
console.log(`WoC unspent: ${unspent.length} UTXOs`);
if (unspent.length === 0) process.exit(1);

// Pick one with decent satoshis
const picked = unspent.find(u => u.value >= 10000) || unspent[0];
console.log(`Picked: ${picked.tx_hash}:${picked.tx_pos} value=${picked.value}`);

// Fetch source TX hex
const srcHex = await fetch(`${base}/tx/${picked.tx_hash}/hex`).then(r => r.text());
const srcTx = Transaction.fromHex(srcHex);
console.log(`Source TX loaded, outputs: ${srcTx.outputs.length}`);
const srcOut = srcTx.outputs[picked.tx_pos];
console.log(`Source output script: ${srcOut.lockingScript.toHex().slice(0, 40)}...`);
console.log(`Source output value: ${srcOut.satoshis}`);

// Build a simple P2PK-to-P2PK TX
const tx = new Transaction();
tx.version = 2;

// Manual p2pkUnlock template
const unlock = {
  sign: async (tx, inputIndex) => {
    const sig = TransactionSignature.format({
      sourceTXID: picked.tx_hash,
      sourceOutputIndex: picked.tx_pos,
      sourceSatoshis: picked.value,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
      inputIndex,
      outputs: tx.outputs,
      inputSequence: tx.inputs[inputIndex].sequence,
      subscript: Script.fromHex(scriptHex),
      lockTime: tx.lockTime,
      scope: TransactionSignature.SIGHASH_FORKID | TransactionSignature.SIGHASH_ALL,
    });
    const rawSig = pk.sign(Hash.sha256(sig));
    const sigBytes = new TransactionSignature(rawSig.r, rawSig.s, TransactionSignature.SIGHASH_FORKID | TransactionSignature.SIGHASH_ALL).toChecksigFormat();
    return new UnlockingScript([{ op: sigBytes.length, data: sigBytes }]);
  },
  estimateLength: async () => 74,
};

tx.addInput({
  sourceTransaction: srcTx,
  sourceOutputIndex: picked.tx_pos,
  unlockingScriptTemplate: unlock,
});
tx.addOutput({ lockingScript: Script.fromHex(scriptHex), change: true });
await tx.fee(new SatoshisPerKilobyte(100));
await tx.sign();

const newTxid = tx.id('hex');
console.log(`Built TX: ${newTxid}`);
console.log(`Inputs: ${tx.inputs.length}, Outputs: ${tx.outputs.length}`);
console.log(`Change output: ${tx.outputs[0].satoshis} sats`);
console.log(`Serialized length: ${tx.toHex().length / 2} bytes`);
const efHex = tx.toHexEF();
console.log(`EF length: ${efHex.length / 2} bytes`);

// Broadcast directly to Arcade
const endpoints = [
  'https://arcade-eu-1.bsvb.tech',
  'https://arcade-ttn-us-1.bsvb.tech',
  'https://arcade-us-1.bsvb.tech',
];

for (const ep of endpoints) {
  console.log(`\n=== ${ep} ===`);
  try {
    const r = await fetch(`${ep}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(efHex, 'hex'),
    });
    const txt = await r.text();
    console.log(`HTTP ${r.status}`);
    console.log(`body: ${txt.slice(0, 500)}`);
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
  }
}
