import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';

async function main() {
  const w = new Wallet(process.env.DISPATCH_PRIVATE_KEY!, 'mainnet');
  
  // Use a known confirmed UTXO
  const txid = 'dbc60cbcf497af911ca08586c39b290d9807949b3f2909e2d2bd1f2dfd2575af';
  let srcHex = '';
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/' + txid + '/hex');
      if (r.ok) { srcHex = await r.text(); break; }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!srcHex) { console.log('Could not fetch source TX'); return; }

  const srcTx = Transaction.fromHex(srcHex);
  const vout = 0;
  const sats = srcTx.outputs[vout].satoshis!;
  const script = srcTx.outputs[vout].lockingScript!.toHex();
  console.log('Using:', txid.slice(0,16) + '...', 'vout:', vout, 'sats:', sats);

  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: vout,
    unlockingScriptTemplate: w.p2pkUnlock(sats, Script.fromHex(script)),
  });
  tx.addOutput({ lockingScript: w.p2pkLockingScript(), satoshis: sats - 200 });
  await tx.fee(new SatoshisPerKilobyte(100));
  await tx.sign();
  
  const hex = tx.toHex();
  const txSize = hex.length / 2;
  const totalOut = tx.outputs.reduce((s, o) => s + (o.satoshis || 0), 0);
  const fee = sats - totalOut;
  console.log('TXID:', tx.id('hex'));
  console.log('Size:', txSize, 'bytes, Fee:', fee, 'sats, Rate:', (fee/txSize*1000).toFixed(1), 'sats/kB');

  // Broadcast to Arcade
  console.log('\n=== Arcade US-1 broadcast ===');
  const body = Buffer.from(hex, 'hex');
  const resp = await fetch('https://arcade-us-1.bsvb.tech/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  console.log('Status:', resp.status);
  console.log('Response:', await resp.text());

  // Also check GorillaPool for comparison
  console.log('\n=== GorillaPool ARC broadcast ===');
  const gpResp = await fetch('https://arc.gorillapool.io/v1/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  console.log('Status:', gpResp.status);
  console.log('Response:', await gpResp.text());

  // Wait and check on WoC
  console.log('\nWaiting 5s then checking WoC...');
  await new Promise(r => setTimeout(r, 5000));
  try {
    const wocResp = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/' + tx.id('hex'));
    if (wocResp.ok) {
      const d = await wocResp.json() as any;
      console.log('WoC: confirmations=' + d.confirmations + ', block=' + (d.blockheight || 'mempool'));
    } else {
      console.log('WoC: NOT FOUND (status ' + wocResp.status + ')');
    }
  } catch (e: any) {
    console.log('WoC check failed:', e.message);
  }
}

main().catch(console.error);
