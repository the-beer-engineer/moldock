import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import { readFileSync } from 'fs';

async function main() {
  const w = new Wallet(process.env.DISPATCH_PRIVATE_KEY!, 'mainnet');
  const state = JSON.parse(readFileSync('../.moldock-state.json', 'utf-8'));
  
  // Get the big UTXO
  const utxo = state.utxos.find((u: any) => u.satoshis > 100000);
  if (!utxo) { console.log('No big UTXO'); return; }
  
  // Load source TX from hex (simulates reload from disk)
  const srcTx = Transaction.fromHex(utxo.sourceTxHex);
  console.log('Source TX inputs:', srcTx.inputs.length);
  console.log('Source TX input 0 has sourceTransaction:', !!srcTx.inputs[0]?.sourceTransaction);
  
  // Build a simple spend
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
  
  // Try toHexEF
  try {
    const ef = tx.toHexEF();
    console.log('toHexEF SUCCESS, length:', ef.length / 2, 'bytes');
  } catch (e: any) {
    console.log('toHexEF FAILED:', e.message);
  }
}
main().catch(console.error);
