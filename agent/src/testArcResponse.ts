import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';

async function main() {
  const w = new Wallet(process.env.DISPATCH_PRIVATE_KEY!, 'mainnet');
  
  // Fetch a confirmed UTXO
  const resp = await fetch('https://api.whatsonchain.com/v1/bsv/main/script/58b7004a165dc81aa4df8a99b9626b676e4e4e74d1011175f97f50c06dc7fb7b/unspent');
  const utxos = await resp.json() as any[];
  const small = utxos.filter((u: any) => u.value >= 600 && u.value <= 2000).sort((a: any, b: any) => a.value - b.value)[0];
  if (!small) { console.log('No suitable UTXO'); return; }
  console.log('Using:', small.tx_hash, 'vout:', small.tx_pos, 'sats:', small.value);

  const txResp = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/' + small.tx_hash + '/hex');
  const srcTx = Transaction.fromHex(await txResp.text());
  const script = srcTx.outputs[small.tx_pos].lockingScript!.toHex();

  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: small.tx_pos,
    unlockingScriptTemplate: w.p2pkUnlock(small.value, Script.fromHex(script)),
  });
  tx.addOutput({ lockingScript: w.p2pkLockingScript(), satoshis: small.value - 200 });
  await tx.fee(new SatoshisPerKilobyte(100));
  await tx.sign();
  
  const hex = tx.toHex();
  const txSize = hex.length / 2;
  const totalOut = tx.outputs.reduce((s, o) => s + (o.satoshis || 0), 0);
  const fee = small.value - totalOut;
  console.log('TXID:', tx.id('hex'));
  console.log('Size:', txSize, 'bytes, Fee:', fee, 'sats, Rate:', (fee/txSize*1000).toFixed(1), 'sats/kB');

  // Broadcast to GorillaPool ARC and log FULL response
  console.log('\n--- GorillaPool ARC ---');
  const body = Buffer.from(hex, 'hex');
  const arcResp = await fetch('https://arc.gorillapool.io/v1/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  console.log('Status:', arcResp.status, arcResp.statusText);
  const arcHeaders: Record<string, string> = {};
  arcResp.headers.forEach((v, k) => { arcHeaders[k] = v; });
  console.log('Headers:', JSON.stringify(arcHeaders, null, 2));
  const arcBody = await arcResp.text();
  console.log('Body:', arcBody);

  // Also try with X-WaitFor header to ask ARC to wait for mining
  console.log('\n--- ARC with X-WaitFor: SEEN_ON_NETWORK ---');
  const arcResp2 = await fetch('https://arc.gorillapool.io/v1/tx', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/octet-stream',
      'X-WaitFor': 'SEEN_ON_NETWORK',
    },
    body,
  });
  console.log('Status:', arcResp2.status);
  const arcBody2 = await arcResp2.text();
  console.log('Body:', arcBody2);
}

main().catch(console.error);
