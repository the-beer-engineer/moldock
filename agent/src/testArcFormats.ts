import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import { readFileSync } from 'fs';

async function main() {
  const w = new Wallet(process.env.DISPATCH_PRIVATE_KEY!, 'mainnet');
  const state = JSON.parse(readFileSync('../.moldock-state.json', 'utf-8'));
  const utxo = state.utxos.find((u: any) => u.satoshis > 1000 && u.sourceTxHex);
  if (!utxo) { console.log('No UTXO'); return; }
  
  const srcTx = Transaction.fromHex(utxo.sourceTxHex);
  
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: utxo.vout,
    unlockingScriptTemplate: w.p2pkUnlock(utxo.satoshis, Script.fromHex(utxo.script)),
  });
  tx.addOutput({ lockingScript: w.p2pkLockingScript(), satoshis: 500 });
  await tx.fee(new SatoshisPerKilobyte(100));
  await tx.sign();
  
  const rawHex = tx.toHex();
  // Extended format includes source TXs (BRC-30 BEEF format)
  let efHex: string;
  try {
    efHex = tx.toHexEF();
    console.log('Extended format available, EF length:', efHex.length / 2, 'bytes');
  } catch (e: any) {
    console.log('EF not available:', e.message);
    efHex = '';
  }
  
  console.log('Raw hex length:', rawHex.length / 2, 'bytes');
  console.log('TXID:', tx.id('hex'));
  
  // Try GP with extended format (application/octet-stream but EF)
  if (efHex) {
    console.log('\n=== GP ARC with Extended Format ===');
    const efBody = Buffer.from(efHex, 'hex');
    const r = await fetch('https://arc.gorillapool.io/v1/tx', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/octet-stream',
        'X-TxFormat': 'EXTENDED',
      },
      body: efBody,
    });
    console.log('Status:', r.status);
    console.log('Response:', await r.text());
  }
  
  // Try BEEF format
  try {
    const beefHex = tx.toHexBEEF();
    console.log('\n=== GP ARC with BEEF Format ===');
    console.log('BEEF length:', beefHex.length / 2, 'bytes');
    const beefBody = Buffer.from(beefHex, 'hex');
    const r = await fetch('https://arc.gorillapool.io/v1/tx', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/octet-stream',
        'X-TxFormat': 'BEEF',
      },
      body: beefBody,
    });
    console.log('Status:', r.status);
    console.log('Response:', await r.text());
  } catch (e: any) {
    console.log('\nBEEF not available:', e.message);
  }
}

main().catch(console.error);
