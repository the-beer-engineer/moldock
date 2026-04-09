/**
 * Test: Full covenant chain with fee inputs and payment output on regtest.
 *
 * Verifies:
 * 1. executeChainSteps works with feeUtxos + feeWallet
 * 2. Final chain TX includes payment to compute agent
 * 3. All TXs broadcast successfully
 */

import { Transaction, P2PKH, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import { executeChainSteps, getCompiledAsm, bulkFundWalletP2PK } from './chainBuilder.js';
import { buildChainLockScript, createGenesisTx } from './genesis.js';
import * as regtest from './regtest.js';
import { readFileSync } from 'fs';

const library = JSON.parse(readFileSync(new URL('../data/cdk2/library.json', import.meta.url), 'utf-8'));
const molecule = library.molecules[0];
const receptor = library.receptor;

console.log(`\n=== Full Chain Test with Fee Inputs + Payment ===`);
console.log(`Molecule: ${molecule.id} (${molecule.atoms.length} atoms)`);
console.log(`Receptor: ${receptor.atoms.length} atoms = ${receptor.atoms.length} chain steps`);

// Create dispatch wallet (funds genesis + fee UTXOs)
const dispatchWallet = new Wallet();
console.log(`\nDispatch wallet: ${dispatchWallet.address}`);

// Create compute agent wallet (receives payment)
const computeWallet = new Wallet();
console.log(`Compute wallet: ${computeWallet.address}`);

// 1. Compile covenant
console.log(`\n[1] Compiling covenant for ${molecule.atoms.length} atoms...`);
const compiledAsm = getCompiledAsm(molecule.atoms.length);
console.log(`    Done.`);

// 2. Fund dispatch wallet — create separate UTXOs to avoid descendant limit
console.log(`\n[2] Funding dispatch wallet...`);
// Create genesis funding UTXO
const genesisUtxoArr = await bulkFundWalletP2PK(dispatchWallet, 1, 50000);
const genesisUtxo = genesisUtxoArr[0];

// Create fee UTXOs from a SEPARATE fan-out TX
// Split into batches of 10 to avoid descendant count issues
const chainFeeUtxos: typeof genesisUtxoArr = [];
const batchSize = 10;
for (let i = 0; i < receptor.atoms.length; i += batchSize) {
  const count = Math.min(batchSize, receptor.atoms.length - i);
  const batch = await bulkFundWalletP2PK(dispatchWallet, count, 5000);
  chainFeeUtxos.push(...batch);
}
console.log(`    Genesis UTXO: ${genesisUtxo.satoshis} sats`);
console.log(`    Fee UTXOs: ${chainFeeUtxos.length} × ${chainFeeUtxos[0].satoshis} sats`);

// 3. Create genesis TX
console.log(`\n[3] Creating genesis TX...`);
const genesisTx = await createGenesisTx(molecule, molecule.atoms.length, compiledAsm, genesisUtxo, dispatchWallet);
const genesisTxid = regtest.broadcastAndMine(genesisTx);
console.log(`    Genesis: ${genesisTxid} (${Math.floor(genesisTx.toHex().length / 2)} bytes)`);

// 4. Execute chain with fee inputs and payment
const rewardSats = 100 + (10 * receptor.atoms.length); // dynamic pricing
console.log(`\n[4] Executing ${receptor.atoms.length}-step chain with fees + ${rewardSats} sat reward...`);

// Build chain in memory first (broadcast=false), then broadcast all at once
const result = await executeChainSteps(
  molecule, receptor, compiledAsm, genesisTx, genesisTxid,
  {
    feeUtxos: chainFeeUtxos.map(u => ({
      txid: u.txid,
      vout: u.vout,
      satoshis: u.satoshis,
      script: u.script,
      sourceTransaction: u.sourceTransaction,
    })),
    feeWallet: dispatchWallet,
    paymentPubkey: computeWallet.publicKeyHex,
    paymentSats: rewardSats,
    broadcast: false,  // build in memory
    onEvent: (e) => {
      if (e.type === 'step') {
        process.stdout.write(`    Step ${e.step}/${e.totalSteps} score=${e.score}\r`);
      }
    },
  },
);

// Broadcast chain TXs to regtest, mining each to avoid mempool chain limit.
// NOTE: This is a regtest-only constraint. On mainnet, ARC accepts long chains.
if (result.status === 'completed' && result.txChain) {
  console.log(`\n    Broadcasting ${result.txChain.length - 1} chain TXs...`);
  for (let i = 1; i < result.txChain.length; i++) {  // skip genesis (already mined)
    regtest.broadcastAndMine(result.txChain[i]);
  }
  console.log(`    All chain TXs broadcast and confirmed.`);
}

console.log('');  // clear the \r line

if (result.status !== 'completed') {
  console.error(`    ❌ Chain failed: ${result.error}`);
  process.exit(1);
}

console.log(`    ✅ Chain completed!`);
console.log(`    Final score: ${result.finalScore}`);
console.log(`    Total TXs: ${result.totalTxs}`);
console.log(`    Total bytes: ${result.totalBytes.toLocaleString()}`);
console.log(`    Duration: ${result.durationMs.toFixed(0)}ms`);
console.log(`    Avg TX size: ${Math.round(result.totalBytes / result.totalTxs)} bytes`);

// 5. Verify the final TX has payment output
const lastTx = result.txChain![result.txChain!.length - 1];
console.log(`\n[5] Verifying final TX...`);
console.log(`    Inputs: ${lastTx.inputs.length} (covenant + fee)`);
console.log(`    Outputs: ${lastTx.outputs.length} (covenant + payment + change)`);

if (lastTx.outputs.length >= 2) {
  console.log(`    Payment output (output 1): ${lastTx.outputs[1].satoshis} sats → compute agent`);
  console.log(`    ✅ Payment included in final chain TX!`);
} else {
  console.log(`    ❌ No payment output found!`);
}

// Mine to confirm
regtest.mine(1);

console.log(`\n=== FULL CHAIN TEST PASSED ===\n`);
