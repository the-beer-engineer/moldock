import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import { readFileSync } from 'fs';

async function main() {
  const w = new Wallet(process.env.DISPATCH_PRIVATE_KEY!, 'mainnet');
  
  const state = JSON.parse(readFileSync('../.moldock-state.json', 'utf-8'));
  // Use the big UTXO
  const utxo = state.utxos.find((u: any) => u.satoshis > 1000 && u.sourceTxHex);
  if (!utxo) { console.log('No suitable UTXO'); return; }
  
  const srcTx = Transaction.fromHex(utxo.sourceTxHex);
  console.log('Using:', utxo.txid.slice(0,16) + '...', 'vout:', utxo.vout, 'sats:', utxo.satoshis);
  console.log('Parent TX outputs:', srcTx.outputs.length);
  
  // Check: is the parent TX itself confirmed?
  console.log('\nChecking parent on ARC...');
  const parentStatus = await fetch('https://arc.gorillapool.io/v1/tx/' + utxo.txid);
  const ps = await parentStatus.text();
  console.log('Parent ARC status:', ps);

  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: utxo.vout,
    unlockingScriptTemplate: w.p2pkUnlock(utxo.satoshis, Script.fromHex(utxo.script)),
  });
  tx.addOutput({ lockingScript: w.p2pkLockingScript(), satoshis: 1000 });
  await tx.fee(new SatoshisPerKilobyte(100));
  await tx.sign();
  
  const hex = tx.toHex();
  const txSize = hex.length / 2;
  const totalOut = tx.outputs.reduce((s, o) => s + (o.satoshis || 0), 0);
  const fee = utxo.satoshis - totalOut;
  console.log('\nTXID:', tx.id('hex'));
  console.log('Size:', txSize, 'bytes, Fee:', fee, 'sats, Rate:', (fee/txSize*1000).toFixed(1), 'sats/kB');

  console.log('\n=== Broadcasting to ARC ===');
  const body = Buffer.from(hex, 'hex');
  const arcResp = await fetch('https://arc.gorillapool.io/v1/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  console.log('HTTP Status:', arcResp.status);
  console.log('Response:', await arcResp.text());
}

main().catch(console.error);
