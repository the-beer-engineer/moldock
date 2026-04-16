import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';

async function main() {
  const w = new Wallet(process.env.DISPATCH_PRIVATE_KEY!, 'mainnet');
  
  // Fetch confirmed UTXOs from WoC
  const resp = await fetch('https://api.whatsonchain.com/v1/bsv/main/script/58b7004a165dc81aa4df8a99b9626b676e4e4e74d1011175f97f50c06dc7fb7b/unspent');
  const utxos = await resp.json() as any[];
  const small = utxos.filter((u: any) => u.value >= 600 && u.value <= 2000).sort((a: any, b: any) => a.value - b.value)[0];
  if (!small) { console.log('No suitable UTXO'); return; }
  console.log('Using:', small.tx_hash.slice(0, 16) + '...', 'sats:', small.value);

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
  console.log('TXID:', tx.id('hex'));
  console.log('Size:', hex.length / 2, 'bytes');

  // Try WoC broadcast
  console.log('\n--- WoC broadcast ---');
  const wocRes = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: hex }),
  });
  console.log('WoC status:', wocRes.status);
  const wocBody = await wocRes.text();
  console.log('WoC response:', wocBody.slice(0, 500));
}

main().catch(console.error);
