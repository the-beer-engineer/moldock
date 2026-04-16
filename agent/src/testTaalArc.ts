import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';

async function main() {
  const w = new Wallet(process.env.DISPATCH_PRIVATE_KEY!, 'mainnet');
  
  // Fetch a confirmed UTXO directly (avoid WoC rate limit by picking one we know is confirmed)
  // b664d0f8... vout=0 was confirmed at block 944752
  const txid = 'b664d0f818ad9e3ab5bf4e7f33647656a980ef7dc184efd1998897f047df922d';
  
  // Wait and retry WoC
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
  const sats = 2000;
  const script = srcTx.outputs[vout].lockingScript!.toHex();
  
  // Check if this UTXO was already spent by our earlier test
  console.log('Source UTXO:', txid.slice(0,16), 'vout:', vout, 'sats:', sats);

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

  // Try TAAL ARC
  console.log('\n=== TAAL ARC ===');
  const body = Buffer.from(hex, 'hex');
  const taalResp = await fetch('https://arc.taal.com/v1/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  console.log('TAAL Status:', taalResp.status);
  console.log('TAAL Response:', await taalResp.text());

  // Try GorillaPool ARC  
  console.log('\n=== GorillaPool ARC ===');
  const gpResp = await fetch('https://arc.gorillapool.io/v1/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  console.log('GP Status:', gpResp.status);
  console.log('GP Response:', await gpResp.text());
}

main().catch(console.error);
