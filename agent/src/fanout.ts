import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = resolve(__dirname, '../../.moldock-state.json');

async function main() {
  const w = new Wallet(process.env.DISPATCH_PRIVATE_KEY!, 'mainnet');
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  
  // Find all UTXOs > 100K sats
  const bigUtxos = state.utxos.filter((u: any) => u.satoshis > 100000 && u.sourceTxHex);
  if (bigUtxos.length === 0) { console.log('No big UTXOs to fan out'); return; }
  
  const totalBig = bigUtxos.reduce((s: number, u: any) => s + u.satoshis, 0);
  console.log(`Found ${bigUtxos.length} big UTXOs, total: ${totalBig} sats`);
  
  // Target: 50 UTXOs of equal size
  const NUM_OUTPUTS = 50;
  const SATS_PER_OUTPUT = Math.floor((totalBig - 5000) / NUM_OUTPUTS); // reserve for fees
  console.log(`Creating ${NUM_OUTPUTS} UTXOs of ${SATS_PER_OUTPUT} sats each`);
  
  const tx = new Transaction();
  tx.version = 2;
  
  for (const utxo of bigUtxos) {
    const srcTx = Transaction.fromHex(utxo.sourceTxHex);
    const isP2PKH = utxo.script.length === 50 && utxo.script.startsWith('76a914');
    tx.addInput({
      sourceTransaction: srcTx,
      sourceOutputIndex: utxo.vout,
      unlockingScriptTemplate: isP2PKH
        ? (await import('@bsv/sdk')).P2PKH.prototype.unlock.call(new (await import('@bsv/sdk')).P2PKH(), w.privateKey, 'all', false, utxo.satoshis, Script.fromHex(utxo.script))
        : w.p2pkUnlock(utxo.satoshis, Script.fromHex(utxo.script)),
    });
  }
  
  const lockScript = w.p2pkLockingScript();
  for (let i = 0; i < NUM_OUTPUTS; i++) {
    tx.addOutput({ lockingScript: lockScript, satoshis: SATS_PER_OUTPUT });
  }
  // Change
  tx.addOutput({ lockingScript: lockScript, change: true });
  await tx.fee(new SatoshisPerKilobyte(100));
  await tx.sign();
  
  const txSize = tx.toHex().length / 2;
  const totalOut = tx.outputs.reduce((s, o) => s + (o.satoshis || 0), 0);
  const fee = totalBig - totalOut;
  console.log(`TX size: ${txSize} bytes, fee: ${fee} sats (${(fee/txSize*1000).toFixed(1)} sats/kB)`);
  
  // Broadcast via Arcade EF
  const efHex = tx.toHexEF();
  const body = Buffer.from(efHex, 'hex');
  console.log('Broadcasting to Arcade...');
  const resp = await fetch('https://arcade-us-1.bsvb.tech/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  const result = await resp.text();
  console.log(`Arcade: ${resp.status} ${result.slice(0, 200)}`);
  
  if (resp.ok) {
    const txid = tx.id('hex');
    // Update state: remove big UTXOs, add fan-out outputs
    const bigTxids = new Set(bigUtxos.map((u: any) => `${u.txid}:${u.vout}`));
    state.utxos = state.utxos.filter((u: any) => !bigTxids.has(`${u.txid}:${u.vout}`));
    
    const scriptHex = lockScript.toHex();
    const sourceTxHex = tx.toHex();
    for (let i = 0; i <= NUM_OUTPUTS; i++) { // +1 for change
      const sats = tx.outputs[i]?.satoshis;
      if (sats && sats > 0) {
        state.utxos.push({ txid, vout: i, satoshis: sats, script: scriptHex, sourceTxHex });
      }
    }
    
    const total = state.utxos.reduce((s: number, u: any) => s + u.satoshis, 0);
    console.log(`Updated state: ${state.utxos.length} UTXOs, ${total} sats`);
    writeFileSync(STATE_FILE, JSON.stringify(state));
    console.log('State saved. Restart the server.');
  }
}
main().catch(console.error);
