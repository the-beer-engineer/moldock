import { runPipeline, runBatchPipeline } from './pipeline.js';
import { generateMolecule, generateReceptorSite } from './generate.js';

console.log('=== MolDock Full Pipeline Test ===\n');

// Test 1: Single molecule, multiple sizes
const sizes = [3, 10, 30];
const receptor3 = generateReceptorSite(3);

console.log('--- Test 1: Variable atom counts, 3-step chain ---');
for (const n of sizes) {
  const mol = generateMolecule(n);
  const t0 = performance.now();
  const result = runPipeline(mol, receptor3);
  const dt = (performance.now() - t0).toFixed(0);

  const icon = result.sxcVerified ? '✓' : '✗';
  console.log(`  ${icon} ${n} atoms: score=${result.finalScore}, sxc=${result.sxcVerified ? 'PASS' : 'FAIL'} (${dt}ms)`);
  if (!result.sxcVerified) {
    console.log(`    Error: ${result.error}`);
  }
}

// Test 2: Batch of 20 molecules (3 atoms each), ranked by score
console.log('\n--- Test 2: Batch of 20 molecules, 3 receptor atoms ---');
const molecules20 = Array.from({ length: 20 }, () => generateMolecule(3));
const t0 = performance.now();
const results = runBatchPipeline(molecules20, receptor3);
const dt = (performance.now() - t0).toFixed(0);

const verified = results.filter(r => r.sxcVerified).length;
const ranked = [...results].sort((a, b) => a.finalScore - b.finalScore);

console.log(`  Verified: ${verified}/${results.length} (${dt}ms total)`);
console.log(`  Top 5:`);
for (let i = 0; i < Math.min(5, ranked.length); i++) {
  const r = ranked[i];
  console.log(`    #${i + 1} ${r.moleculeId}: score=${r.finalScore} sxc=${r.sxcVerified ? '✓' : '✗'}`);
}

// Test 3: Longer chain (5 receptor atoms)
console.log('\n--- Test 3: 10 atoms, 5-step chain ---');
const receptor5 = generateReceptorSite(5);
const mol10 = generateMolecule(10);
const t1 = performance.now();
const result5 = runPipeline(mol10, receptor5);
const dt1 = (performance.now() - t1).toFixed(0);

console.log(`  ${result5.sxcVerified ? '✓' : '✗'} score=${result5.finalScore} steps=${result5.chainLength} (${dt1}ms)`);
for (const s of result5.states) {
  console.log(`    step ${s.receptorIdx}: ${s.scoreIn} → ${s.scoreOut} (batch=${s.scoreOut - s.scoreIn})`);
}

// Summary
const allPassed = results.every(r => r.sxcVerified) &&
  sizes.every(n => {
    const mol = generateMolecule(n);
    return runPipeline(mol, receptor3).sxcVerified;
  }) &&
  result5.sxcVerified;

console.log(`\n=== ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'} ===`);
if (!allPassed) process.exit(1);
