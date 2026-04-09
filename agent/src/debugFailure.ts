import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import * as regtest from './regtest.js';
import { bulkFundWalletP2PK, getCompiledAsm } from './chainBuilder.js';
import { buildChainLockScript } from './genesis.js';
import { generateMolecule, generateReceptorSite } from './generate.js';
import { computeBatchEnergy } from './energy.js';

// Reproduce a chain failure by running many molecules and catching the failing scriptSig
const wallet = new Wallet(undefined, 'regtest');

console.log('Funding...');
const utxos = await bulkFundWalletP2PK(wallet, 100, 10000);
const compiledAsm = getCompiledAsm(3);
const receptor = generateReceptorSite(3);

// --- Inline helpers (same as chainBuilder) ---
function pushScriptNum(n: number): number[] {
  if (n === 0) return [0x00];
  if (n === -1) return [0x4f];
  if (n >= 1 && n <= 16) return [0x50 + n];
  const neg = n < 0;
  let abs = Math.abs(n);
  const bytes: number[] = [];
  while (abs > 0) { bytes.push(abs & 0xff); abs >>= 8; }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(neg ? 0x80 : 0x00);
  else if (neg) bytes[bytes.length - 1] |= 0x80;
  return pushData(bytes);
}
function pushData(data: number[]): number[] {
  if (data.length === 0) return [0x00];
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16) return [0x50 + data[0]];
  if (data.length === 1 && data[0] === 0x81) return [0x4f];
  if (data.length <= 75) return [data.length, ...data];
  if (data.length <= 255) return [0x4c, data.length, ...data];
  return [0x4d, data.length & 0xff, (data.length >> 8) & 0xff, ...data];
}

let txsSinceLastMine = 0;

for (let i = 0; i < 100; i++) {
  const mol = generateMolecule(3);
  const utxo = utxos[i];

  // Genesis
  const genesisTx = new Transaction();
  genesisTx.version = 2;
  genesisTx.addInput({
    sourceTransaction: utxo.sourceTransaction,
    sourceOutputIndex: utxo.vout,
    unlockingScriptTemplate: wallet.p2pkUnlock(utxo.satoshis, Script.fromHex(utxo.script)),
  });
  genesisTx.addOutput({ lockingScript: buildChainLockScript(3, 0, compiledAsm), satoshis: 1 });
  genesisTx.addOutput({ lockingScript: wallet.p2pkLockingScript(), change: true });
  await genesisTx.fee(new SatoshisPerKilobyte(1));
  await genesisTx.sign();
  const genesisTxid = regtest.broadcastOnly(genesisTx);
  txsSinceLastMine++;

  // Chain steps
  let prevTx = genesisTx;
  let currentTxid = genesisTxid;
  let currentScore = 0;
  let failed = false;

  for (let step = 0; step < 3; step++) {
    const batch = computeBatchEnergy(mol.atoms, receptor.atoms[step]);
    const newScore = currentScore + batch.batchTotal;

    // Build scriptSig manually
    const parts: number[][] = [];
    const txidBytes = Array.from(Buffer.from(currentTxid, 'hex').reverse());
    parts.push(pushData(txidBytes));
    const satsBuf = Buffer.alloc(8);
    satsBuf.writeBigUInt64LE(1n);
    parts.push(pushData(Array.from(satsBuf)));
    parts.push(pushScriptNum(batch.batchTotal));
    parts.push(pushScriptNum(newScore));
    for (const pair of batch.pairs) {
      parts.push(pushScriptNum(pair.hbond));
      parts.push(pushScriptNum(pair.elec));
      parts.push(pushScriptNum(pair.vdw));
      parts.push(pushScriptNum(pair.dist));
      parts.push(pushScriptNum(pair.dsq));
    }
    const scriptSigHex = parts.map(p => Buffer.from(p).toString('hex')).join('');

    const chainTx = new Transaction();
    chainTx.version = 2;
    chainTx.lockTime = 0;
    chainTx.addInput({
      sourceTransaction: prevTx,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromHex(scriptSigHex),
      sequence: 0xffffffff,
    });
    chainTx.addOutput({ lockingScript: buildChainLockScript(3, newScore, compiledAsm), satoshis: 1 });

    try {
      const chainTxid = regtest.broadcastOnly(chainTx);
      txsSinceLastMine++;
      prevTx = chainTx;
      currentTxid = chainTxid;
      currentScore = newScore;
    } catch (err: any) {
      const msg = err.message.split('\n').filter((l: string) => l.includes('error') || l.includes('mandatory')).join(' | ');
      console.log(`\nFAIL: molecule #${i} step ${step + 1}`);
      console.log(`  Error: ${msg}`);
      console.log(`  batchTotal=${batch.batchTotal}, newScore=${newScore}`);
      console.log(`  Pairs:`);
      for (const [j, p] of batch.pairs.entries()) {
        console.log(`    atom${j+1}: dsq=${p.dsq} dist=${p.dist} vdw=${p.vdw} elec=${p.elec} hbond=${p.hbond}`);
        // Check each push
        const pushes = [p.hbond, p.elec, p.vdw, p.dist, p.dsq];
        for (const v of pushes) {
          const enc = pushScriptNum(v);
          const hex = Buffer.from(enc).toString('hex');
          if (enc.length === 2 && enc[0] === 1) {
            const val = enc[1];
            if ((val >= 1 && val <= 16) || val === 0x81) {
              console.log(`    *** NON-MINIMAL: value=${v} encoded as ${hex} but should use OP_N`);
            }
          }
        }
      }
      console.log(`  scriptSig (${scriptSigHex.length/2} bytes): ${scriptSigHex.substring(0, 100)}...`);
      failed = true;
      break;
    }
  }

  if (txsSinceLastMine >= 10) {
    regtest.mine(1);
    txsSinceLastMine = 0;
  }

  if (!failed && i % 20 === 0) process.stdout.write(`${i}..`);
}

regtest.mine(1);
console.log('\nDone');
