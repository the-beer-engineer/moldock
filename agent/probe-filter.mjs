// Verify each unspent UTXO against Arcade to filter phantoms
import { readFileSync } from 'fs';
import { PrivateKey } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
console.log(`WoC unspent: ${unspent.length}`);

let real = 0, phantom = 0;
for (const u of unspent) {
  try {
    const arcResp = await fetch(`https://arcade-eu-1.bsvb.tech/tx/${u.tx_hash}`);
    if (arcResp.ok) {
      const j = await arcResp.json();
      if (j.error) {
        console.log(`PHANTOM: ${u.tx_hash.slice(0,16)}:${u.tx_pos} ${u.value}`);
        phantom++;
      } else {
        console.log(`REAL:    ${u.tx_hash.slice(0,16)}:${u.tx_pos} ${u.value} (${j.txStatus})`);
        real++;
      }
    }
  } catch {}
  await new Promise(r => setTimeout(r, 100));
}
console.log(`\n${real} real, ${phantom} phantom`);
