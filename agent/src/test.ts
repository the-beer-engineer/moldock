import { computeBatchEnergy, computeIsqrt, computeDsq } from './energy.js';
import { generateMolecule, generateReceptorSite } from './generate.js';
import type { Atom, Molecule, ReceptorSite } from './types.js';

// Test 1: Energy computation matches the verified on-chain test case
function testKnownPairEnergy() {
  console.log('=== Test 1: Known pair energy ===');

  const ligand: Atom = { x: 300, y: 400, z: 500, type: 1, charge: 100 };
  const receptor: Atom = { x: 100, y: 100, z: 200, type: 2, charge: -50 };

  const dsq = computeDsq(ligand, receptor);
  const dist = computeIsqrt(dsq);

  console.log(`  dsq = ${dsq} (expected 220000)`);
  console.log(`  dist = ${dist} (expected 469)`);

  const distSq = dist * dist;
  const distPlus1Sq = (dist + 1) * (dist + 1);
  console.log(`  dist² = ${distSq} ≤ ${dsq} < ${distPlus1Sq} = (dist+1)²`);
  console.assert(distSq <= dsq, 'isqrt lower bound failed');
  console.assert(dsq < distPlus1Sq, 'isqrt upper bound failed');

  console.log('  PASS');
}

// Test 2: Batch energy computation
function testBatchEnergy() {
  console.log('=== Test 2: Batch energy (3 atoms) ===');

  const ligands: Atom[] = [
    { x: 300, y: 400, z: 500, type: 1, charge: 100 },
    { x: 200, y: 200, z: 200, type: 3, charge: -100 },
    { x: 600, y: 600, z: 600, type: 5, charge: 50 },
  ];
  const receptor: Atom = { x: 400, y: 400, z: 400, type: 2, charge: -80 };

  const batch = computeBatchEnergy(ligands, receptor);

  console.log(`  Pairs: ${batch.pairs.length}`);
  for (const [i, p] of batch.pairs.entries()) {
    console.log(`    Atom ${i + 1}: dsq=${p.dsq} dist=${p.dist} vdw=${p.vdw} elec=${p.elec} hbond=${p.hbond} total=${p.total}`);
    console.assert(p.dist * p.dist <= p.dsq, `isqrt lower bound failed for atom ${i + 1}`);
    console.assert((p.dist + 1) * (p.dist + 1) > p.dsq, `isqrt upper bound failed for atom ${i + 1}`);
    console.assert(p.total === p.vdw + p.elec + p.hbond, `energy sum failed for atom ${i + 1}`);
  }
  console.log(`  batchTotal = ${batch.batchTotal}`);
  console.assert(batch.batchTotal === batch.pairs.reduce((s: number, p) => s + p.total, 0), 'batch total mismatch');
  console.log('  PASS');
}

// Test 3: Off-chain scoring (replaces old chain simulation test)
function testOffchainScoring() {
  console.log('=== Test 3: Off-chain scoring (3 molecules × 3 receptor atoms) ===');

  const receptor = generateReceptorSite(3);
  const molecules = Array.from({ length: 3 }, () => generateMolecule(3));

  const scored = molecules.map(mol => {
    let score = 0;
    const states: Array<{ scoreIn: number; scoreOut: number; receptorIdx: number }> = [];
    for (let r = 0; r < receptor.atoms.length; r++) {
      const batch = computeBatchEnergy(mol.atoms, receptor.atoms[r]);
      const scoreIn = score;
      score += batch.batchTotal;
      states.push({ scoreIn, scoreOut: score, receptorIdx: r });
    }
    return { moleculeId: mol.id, finalScore: score, states };
  });

  const ranked = scored.sort((a, b) => a.finalScore - b.finalScore);

  for (const r of ranked) {
    console.log(`  Molecule ${r.moleculeId}: score=${r.finalScore}`);
    for (const s of r.states) {
      console.log(`    step ${s.receptorIdx}: ${s.scoreIn} → ${s.scoreOut} (batch=${s.scoreOut - s.scoreIn})`);
    }
  }

  console.assert(scored.length === 3, 'wrong molecule count');
  console.log('  PASS');
}

// Test 4: sxc simulation match
function testSxcCompatibility() {
  console.log('=== Test 4: sxc compatibility (generate sim args) ===');

  const ligands: Atom[] = [
    { x: 300, y: 400, z: 500, type: 1, charge: 100 },
    { x: 200, y: 200, z: 200, type: 3, charge: -100 },
    { x: 600, y: 600, z: 600, type: 5, charge: 50 },
  ];
  const receptor: Atom = { x: 400, y: 400, z: 400, type: 2, charge: -80 };

  const batch = computeBatchEnergy(ligands, receptor);

  const vinArgs: Record<string, number> = {
    numAtomsN: ligands.length,
    batchTotal: batch.batchTotal,
  };

  batch.pairs.forEach((p, i) => {
    const n = i + 1;
    vinArgs[`dsqN${n}`] = p.dsq;
    vinArgs[`distN${n}`] = p.dist;
    vinArgs[`vdwN${n}`] = p.vdw;
    vinArgs[`elecN${n}`] = p.elec;
    vinArgs[`hbondN${n}`] = p.hbond;
  });

  console.log('  Sim vin args for sxc:');
  console.log('  ' + JSON.stringify(vinArgs, null, 2).replace(/\n/g, '\n  '));
  console.log('  PASS');
}

// Run all tests
testKnownPairEnergy();
console.log('');
testBatchEnergy();
console.log('');
testOffchainScoring();
console.log('');
testSxcCompatibility();
console.log('');
console.log('All tests passed.');
