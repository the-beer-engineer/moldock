import { Orchestrator } from './orchestrator.js';
import { generateMolecule, generateReceptorSite } from './generate.js';
import * as regtest from './regtest.js';

// Parse CLI args
const args = process.argv.slice(2);
const numMolecules = parseInt(args.find(a => a.startsWith('--molecules='))?.split('=')[1] ?? '10');
const numLigandAtoms = parseInt(args.find(a => a.startsWith('--atoms='))?.split('=')[1] ?? '3');
const numReceptorAtoms = parseInt(args.find(a => a.startsWith('--receptor='))?.split('=')[1] ?? '3');
const noDash = args.includes('--no-dashboard');
const fast = args.includes('--fast');

console.log('=== MolDock Regtest Runner ===');
console.log(`Molecules: ${numMolecules}, Ligand atoms: ${numLigandAtoms}, Receptor atoms: ${numReceptorAtoms}`);
console.log(`Expected TXs: ${numMolecules * (numReceptorAtoms + 1 + 2)} (chains + funding)`);
if (fast) console.log(`Fast mode: broadcast without mining, batch mine periodically`);
console.log();

// Check regtest node
try {
  const height = regtest.getBlockCount();
  const balance = regtest.getBalance();
  console.log(`Regtest node: height=${height}, balance=${balance} BSV`);
} catch (err: any) {
  console.error('Regtest node not available:', err.message);
  process.exit(1);
}

// Generate test data
const molecules = Array.from({ length: numMolecules }, () => generateMolecule(numLigandAtoms));
const receptor = generateReceptorSite(numReceptorAtoms);
console.log(`Generated ${molecules.length} molecules, receptor with ${receptor.atoms.length} atoms\n`);

// Set up orchestrator
const orchestrator = new Orchestrator();

orchestrator.on('status', (msg: string) => {
  console.log(`[status] ${msg}`);
});

orchestrator.on('moleculeComplete', (result: any) => {
  const icon = result.status === 'completed' ? '✓' : '✗';
  console.log(`  ${icon} ${result.moleculeId}: score=${result.finalScore} (${result.totalTxs} txs, ${result.durationMs.toFixed(0)}ms)`);
  if (result.error) {
    const lines = result.error.split('\n');
    const errLines = lines.filter((l: string) => l.startsWith('error') || l.includes('mandatory') || l.includes('non-mandatory') || l.includes('mempool'));
    console.log(`    ERROR: ${errLines.join(' | ') || lines.slice(0, 3).join(' | ')}`);
    // Show the failing step
    console.log(`    Failed at: genesis=${result.genesisTxid ? 'ok' : 'FAILED'}, steps=${result.stepTxids?.length ?? 0}`);
  }
});

orchestrator.on('moleculeError', (info: any) => {
  console.log(`  ✗ ${info.moleculeId}: ${info.error}`);
});

orchestrator.on('done', (stats: any) => {
  console.log('\n=== Run Complete ===');
  console.log(`Molecules: ${stats.completedMolecules}/${stats.totalMolecules} completed, ${stats.failedMolecules} failed`);
  console.log(`TXs broadcast: ${stats.totalTxsBroadcast}`);
  console.log(`Chain steps: ${stats.totalChainSteps}`);
  console.log(`Duration: ${(stats.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`Rate: ${stats.txsPerSecond.toFixed(1)} tx/s`);
  console.log(`Block height: ${stats.blockHeight}`);

  // Top 5 results
  const ranked = [...stats.results]
    .filter((r: any) => r.status === 'completed')
    .sort((a: any, b: any) => a.finalScore - b.finalScore);

  if (ranked.length > 0) {
    console.log('\nTop 5:');
    for (let i = 0; i < Math.min(5, ranked.length); i++) {
      const r = ranked[i];
      console.log(`  #${i + 1} ${r.moleculeId}: score=${r.finalScore}`);
    }
  }
});

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\nAborting...');
  orchestrator.abort();
  setTimeout(() => process.exit(0), 500);
});

// Run
orchestrator.run(molecules, receptor, { fast }).then(() => {
  console.log(`\nUse 'npm run serve' for the full dashboard.`);
}).catch(err => {
  console.error('Run failed:', err);
  process.exit(1);
});
