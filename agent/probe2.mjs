import { readFileSync } from 'fs';
import { PrivateKey, Transaction, LockingScript, Script, SatoshisPerKilobyte, Hash, UnlockingScript, TransactionSignature } from '@bsv/sdk';
import { createHash } from 'crypto';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const pubKeyBytes = pk.toPublicKey().encode(true);

const scriptHex = new LockingScript([
  { op: pubKeyBytes.length, data: pubKeyBytes },
  { op: 0xac }
]).toHex();
const scriptHash = Buffer.from(createHash('sha256').update(Buffer.from(scriptHex, 'hex')).digest()).reverse().toString('hex');

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/script/${scriptHash}/unspent`).then(r => r.json());

// Pick a BIG UTXO this time to afford higher fees
const picked = unspent.find(u => u.value >= 1000000) || unspent.sort((a, b) => b.value - a.value)[0];
console.log(`Picked: ${picked.tx_hash.slice(0, 16)}:${picked.tx_pos} value=${picked.value}`);

// Verify it's really unspent via full tx detail
const txDetail = await fetch(`${base}/tx/hash/${picked.tx_hash}`).then(r => r.json());
const spentTxId = txDetail.vout[picked.tx_pos]?.spentTxId;
console.log(`spentTxId: ${spentTxId || 'NOT SPENT (confirmed unspent on chain)'}`);
if (spentTxId) { console.log('SPENT! stopping.'); process.exit(1); }

const srcHex = await fetch(`${base}/tx/${picked.tx_hash}/hex`).then(r => r.text());
const srcTx = Transaction.fromHex(srcHex);

async function buildAndTest(feeRate, label) {
  const tx = new Transaction();
  tx.version = 2;
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
  tx.addInput({ sourceTransaction: srcTx, sourceOutputIndex: picked.tx_pos, unlockingScriptTemplate: unlock });
  tx.addOutput({ lockingScript: Script.fromHex(scriptHex), change: true });
  await tx.fee(new SatoshisPerKilobyte(feeRate));
  await tx.sign();
  const feeAmount = picked.value - tx.outputs[0].satoshis;
  console.log(`\n=== ${label}: fee ${feeRate} sats/kB, fee=${feeAmount} sats ===`);
  const efHex = tx.toHexEF();
  const r = await fetch('https://arcade-eu-1.bsvb.tech/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(efHex, 'hex'),
  });
  const txt = await r.text();
  console.log(`HTTP ${r.status}: ${txt.slice(0, 300)}`);
}

await buildAndTest(100, '100 sats/kB (current)');
await buildAndTest(500, '500 sats/kB');
await buildAndTest(1000, '1000 sats/kB');
await buildAndTest(5000, '5000 sats/kB');
