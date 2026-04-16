// Final proof: test COVENANT outputs specifically (our chain lock script)
import { readFileSync } from 'fs';
import { PrivateKey, Transaction, Script, SatoshisPerKilobyte, P2PKH } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
if (unspent.length === 0) { console.log('no P2PKH UTXOs available'); process.exit(0); }

const nonce = Date.now().toString(16).padStart(12, '0');
let idx = 0;

async function build(extraOutputs, withNonce) {
  const picked = unspent.sort((a,b) => b.value - a.value)[idx++];
  if (!picked) return null;
  const srcHex = await fetch(`${base}/tx/${picked.tx_hash}/hex`).then(r => r.text());
  const srcTx = Transaction.fromHex(srcHex);
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: picked.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, picked.value, new P2PKH().lock(addr)),
  });
  for (const o of extraOutputs) tx.addOutput(o);
  if (withNonce) tx.addOutput({ lockingScript: Script.fromHex(`006a06${nonce}`), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), change: true });
  await tx.fee(new SatoshisPerKilobyte(500));
  await tx.sign();
  return tx;
}

async function test(tx, label) {
  if (!tx) { console.log(`${label}: NO UTXO`); return; }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('https://arcade-eu-1.bsvb.tech/tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(tx.toHexEF(), 'hex'),
      });
      const j = await r.json();
      if (j.error && /database is locked/i.test(j.error) && attempt < 2) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      console.log(`${label}: ${j.txStatus || 'X'} ${((j.extraInfo || j.error) || '').slice(0, 140)}`);
      return;
    } catch (e) { console.log(`${label}: ${e.message}`); return; }
  }
}

// Read an actual chain lock script hex to test
const { buildChainLockScript } = await import('./build/genesis.js').catch(async () => {
  const m = await import('./src/genesis.js').catch(() => null);
  return m || { buildChainLockScript: null };
});

// Skip if we can't load — use a simplified "fake covenant" pattern instead
// Real chain lock: push data + OP_DROP + big PUSHDATA (script body) + execute
const fakeCov = '04deadbeef' + '75' + '4c10' + 'aa'.repeat(16);  // push4+drop+push16
await test(await build([{ lockingScript: Script.fromHex(fakeCov), satoshis: 1 }], true), 'Fake-covenant (push+drop+push16)');

// Script that ends mid-push (non-TRUE)
const badEnd = '04deadbeef75' + '01' + '00';  // push4+drop+push1byte(0)
await test(await build([{ lockingScript: Script.fromHex(badEnd), satoshis: 1 }], true), 'Push4/drop/push1byte=0x00');

// Script ending in OP_1
const opOne = '04deadbeef7551';
await test(await build([{ lockingScript: Script.fromHex(opOne), satoshis: 1 }], true), 'Push4/drop/OP_1');

// Our ACTUAL script pattern prefix
const actualPrefix = '0400000000754d58066b';
// Add body to make it parseable but small
const shortCov = actualPrefix + '00'.repeat(0x0658) + '51';
await test(await build([{ lockingScript: Script.fromHex(shortCov), satoshis: 1 }], true), 'Actual chain prefix + zeros body + OP_1');
