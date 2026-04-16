import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import { readFileSync } from 'fs';

async function main() {
  const w = new Wallet(process.env.DISPATCH_PRIVATE_KEY!, 'mainnet');
  
  // Use a UTXO from state file
  const state = JSON.parse(readFileSync('../.moldock-state.json', 'utf-8'));
  // Find a usable one (not the tiny ones)
  const utxo = state.utxos.find((u: any) => u.satoshis >= 600 && u.satoshis <= 2000 && u.sourceTxHex);
  if (!utxo) { console.log('No suitable UTXO in state'); return; }
  
  const srcTx = Transaction.fromHex(utxo.sourceTxHex);
  console.log('Using:', utxo.txid.slice(0,16) + '...', 'vout:', utxo.vout, 'sats:', utxo.satoshis);

  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: utxo.vout,
    unlockingScriptTemplate: w.p2pkUnlock(utxo.satoshis, Script.fromHex(utxo.script)),
  });
  tx.addOutput({ lockingScript: w.p2pkLockingScript(), satoshis: utxo.satoshis - 200 });
  await tx.fee(new SatoshisPerKilobyte(100));
  await tx.sign();
  
  const hex = tx.toHex();
  const txSize = hex.length / 2;
  const totalOut = tx.outputs.reduce((s, o) => s + (o.satoshis || 0), 0);
  const fee = utxo.satoshis - totalOut;
  console.log('TXID:', tx.id('hex'));
  console.log('Size:', txSize, 'bytes, Fee:', fee, 'sats, Rate:', (fee/txSize*1000).toFixed(1), 'sats/kB');

  // Broadcast to GorillaPool ARC — capture FULL response
  console.log('\n=== GorillaPool ARC broadcast ===');
  const body = Buffer.from(hex, 'hex');
  const arcResp = await fetch('https://arc.gorillapool.io/v1/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  console.log('HTTP Status:', arcResp.status, arcResp.statusText);
  const arcBody = await arcResp.text();
  console.log('Response:', arcBody);

  // Check the TX status after broadcast
  console.log('\n=== ARC TX status check ===');
  const txid = tx.id('hex');
  const statusResp = await fetch('https://arc.gorillapool.io/v1/tx/' + txid);
  console.log('Status check:', await statusResp.text());
}

main().catch(console.error);
