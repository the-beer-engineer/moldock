import { Transaction, Script, SatoshisPerKilobyte, MerklePath } from '@bsv/sdk';
import { Wallet } from './wallet.js';

async function main() {
  const w = new Wallet(process.env.DISPATCH_PRIVATE_KEY!, 'mainnet');
  
  const txid = 'dbc60cbcf497af911ca08586c39b290d9807949b3f2909e2d2bd1f2dfd2575af';
  
  // Fetch source TX
  let srcHex = '';
  for (let i = 0; i < 3; i++) {
    const r = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/' + txid + '/hex');
    if (r.ok) { srcHex = await r.text(); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!srcHex) { console.log('No source TX'); return; }
  
  const srcTx = Transaction.fromHex(srcHex);
  
  // Fetch merkle proof for the source TX 
  let merkleProof: any = null;
  try {
    const mpResp = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/' + txid + '/proof/tsc');
    if (mpResp.ok) {
      merkleProof = await mpResp.json();
      console.log('Got merkle proof for source TX');
    }
  } catch {}
  
  if (merkleProof) {
    try {
      srcTx.merklePath = MerklePath.fromHex(merkleProof.composite || '');
    } catch {
      // Try constructing from proof data
      console.log('Merkle proof format:', JSON.stringify(merkleProof).slice(0, 200));
    }
  }
  
  const vout = 0;
  const sats = srcTx.outputs[vout].satoshis!;
  const script = srcTx.outputs[vout].lockingScript!.toHex();
  console.log('Using:', txid.slice(0,16) + '... sats:', sats);

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

  console.log('TXID:', tx.id('hex'));

  // Try raw format on Arcade
  console.log('\n=== Arcade RAW format ===');
  const rawBody = Buffer.from(tx.toHex(), 'hex');
  const r1 = await fetch('https://arcade-us-1.bsvb.tech/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: rawBody,
  });
  console.log('Status:', r1.status, '→', await r1.text());

  // Try EF (extended) format  
  console.log('\n=== Arcade EXTENDED format ===');
  try {
    const efHex = tx.toHexEF();
    const efBody = Buffer.from(efHex, 'hex');
    const r2 = await fetch('https://arcade-us-1.bsvb.tech/tx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: efBody,
    });
    console.log('Status:', r2.status, '→', await r2.text());
  } catch (e: any) {
    console.log('EF error:', e.message);
  }

  // Try BEEF format
  console.log('\n=== Arcade BEEF format ===');
  try {
    const beefHex = tx.toHexBEEF();
    const beefBody = Buffer.from(beefHex, 'hex');
    const r3 = await fetch('https://arcade-us-1.bsvb.tech/tx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: beefBody,
    });
    console.log('Status:', r3.status, '→', await r3.text());
  } catch (e: any) {
    console.log('BEEF error:', e.message);
  }
}

main().catch(console.error);
