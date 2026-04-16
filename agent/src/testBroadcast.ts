import { Transaction, Script, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import { getNetwork } from './network.js';

async function main() {
  const wif = process.env.DISPATCH_PRIVATE_KEY;
  if (!wif) { console.error('No DISPATCH_PRIVATE_KEY'); process.exit(1); }

  const wallet = new Wallet(wif, 'mainnet');
  console.log('Address:', wallet.address);

  // Pick a mined UTXO
  const testTxid = 'ce41a272e7e2c8b95f168bd446ea702495d9ea75fcfbcac71c1b7482028b07fa';
  const testVout = 0;
  const testSats = 2000;

  const resp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${testTxid}/hex`);
  const txHex = await resp.text();
  const sourceTx = Transaction.fromHex(txHex);
  const outputScript = sourceTx.outputs[testVout].lockingScript!.toHex();
  console.log('Output script:', outputScript);
  console.log('Output sats:', sourceTx.outputs[testVout].satoshis);
  const isP2PKH = outputScript.length === 50 && outputScript.startsWith('76a914');
  console.log('Is P2PKH:', isP2PKH, 'Script length:', outputScript.length);

  // Build TX
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: testVout,
    unlockingScriptTemplate: isP2PKH
      ? new P2PKH().unlock(wallet.privateKey, 'all', false, testSats, Script.fromHex(outputScript))
      : wallet.p2pkUnlock(testSats, Script.fromHex(outputScript)),
  });
  tx.addOutput({ lockingScript: wallet.p2pkLockingScript(), satoshis: 1500 });
  await tx.fee(new SatoshisPerKilobyte(100));
  await tx.sign();

  const txSize = Math.floor(tx.toHex().length / 2);
  const totalOut = tx.outputs.reduce((s, o) => s + (o.satoshis || 0), 0);
  const feeAmount = testSats - totalOut;
  console.log('TX size:', txSize, 'bytes');
  console.log('Fee:', feeAmount, 'sats (', (feeAmount / txSize * 1000).toFixed(1), 'sats/kB)');

  // Broadcast
  const net = getNetwork();
  try {
    const txid = await net.broadcast(tx);
    console.log('SUCCESS! txid:', txid);
  } catch (err: any) {
    console.error('BROADCAST FAILED:', err.message);
  }
}

main().catch(console.error);
