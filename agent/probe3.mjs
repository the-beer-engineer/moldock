import { readFileSync } from 'fs';
import { PrivateKey, Transaction, LockingScript, Script, SatoshisPerKilobyte, Hash, UnlockingScript, TransactionSignature, P2PKH } from '@bsv/sdk';
import { createHash } from 'crypto';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const pubKeyBytes = pk.toPublicKey().encode(true);
const addr = pk.toAddress();
console.log(`address: ${addr}`);

const p2pkHex = new LockingScript([
  { op: pubKeyBytes.length, data: pubKeyBytes },
  { op: 0xac }
]).toHex();
const scriptHash = Buffer.from(createHash('sha256').update(Buffer.from(p2pkHex, 'hex')).digest()).reverse().toString('hex');

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/script/${scriptHash}/unspent`).then(r => r.json());
const picked = unspent.sort((a, b) => b.value - a.value)[0];
console.log(`Picked: ${picked.tx_hash.slice(0, 16)}:${picked.tx_pos} value=${picked.value}`);

const srcHex = await fetch(`${base}/tx/${picked.tx_hash}/hex`).then(r => r.text());
const srcTx = Transaction.fromHex(srcHex);

async function buildAndTest(outputType, label) {
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
        subscript: Script.fromHex(p2pkHex),
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
  if (outputType === 'p2pk') {
    tx.addOutput({ lockingScript: Script.fromHex(p2pkHex), change: true });
  } else {
    tx.addOutput({ lockingScript: new P2PKH().lock(addr), change: true });
  }
  await tx.fee(new SatoshisPerKilobyte(1000));
  await tx.sign();
  console.log(`\n=== ${label} ===`);
  console.log(`txid: ${tx.id('hex')}`);
  console.log(`size: ${tx.toHex().length / 2} bytes`);
  console.log(`change: ${tx.outputs[0].satoshis}`);
  const efHex = tx.toHexEF();
  const r = await fetch('https://arcade-eu-1.bsvb.tech/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(efHex, 'hex'),
  });
  const txt = await r.text();
  console.log(`HTTP ${r.status}`);
  // Parse and show full extraInfo
  try {
    const j = JSON.parse(txt);
    console.log(`  status: ${j.txStatus}`);
    console.log(`  extraInfo: ${j.extraInfo || '-'}`);
  } catch { console.log(`  body: ${txt}`); }
}

// P2PK → P2PKH
await buildAndTest('p2pkh', 'P2PK input → P2PKH output');
// P2PK → P2PK
await buildAndTest('p2pk', 'P2PK input → P2PK output (current behavior)');
