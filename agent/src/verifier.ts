/**
 * Floating-point reference scorer for verifying integer on-chain calculations.
 * Runs the same energy computations with full float precision and compares
 * results against the integer-scaled Bitcoin Script outputs.
 */
import type { Atom, Molecule, ReceptorSite, PairResult, BatchResult } from './types.js';
import { computePairEnergy, computeBatchEnergy } from './energy.js';

// --- Floating-point energy functions (no integer truncation) ---

const VDW_RADIUS_F: Record<number, number> = {
  1: 1.70, 2: 1.55, 3: 1.52, 4: 1.80, 5: 1.20, 6: 1.80, 7: 1.47, 8: 1.75,
};

const VDW_EPSILON_F: Record<number, number> = {
  1: 0.150, 2: 0.200, 3: 0.210, 4: 0.250,
  5: 0.050, 6: 0.200, 7: 0.180, 8: 0.300,
};

const HBOND_TYPES = new Set([2, 3, 4]);

export interface FloatPairResult {
  distance: number;    // Angstroms (true float)
  vdw: number;         // kcal/mol (float)
  elec: number;        // kcal/mol (float)
  hbond: number;       // kcal/mol (float)
  total: number;
}

export interface VerificationResult {
  moleculeId: string;
  moleculeName?: string;
  active: boolean;

  // Integer-scaled results (from on-chain or energy.ts)
  integerScore: number;
  integerPairCount: number;

  // Float reference results
  floatScore: number;

  // Comparison
  scoreDelta: number;       // integer - float
  scoreRatio: number;       // integer / float
  rankPreserved: boolean;   // does the ranking order match?

  // Per-step breakdown
  steps: StepVerification[];
}

export interface StepVerification {
  receptorIdx: number;
  integerBatchTotal: number;
  floatBatchTotal: number;
  delta: number;
  maxPairDelta: number;  // worst individual pair deviation
}

/** Compute full floating-point energy for a ligand-receptor pair */
function floatPairEnergy(ligand: Atom, receptor: Atom): FloatPairResult {
  // Real coordinates in Angstroms (our format is ×100)
  const dx = (ligand.x - receptor.x) / 100;
  const dy = (ligand.y - receptor.y) / 100;
  const dz = (ligand.z - receptor.z) / 100;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (distance < 0.01) return { distance, vdw: 0, elec: 0, hbond: 0, total: 0 };

  // VdW: Lennard-Jones
  const sigma = (VDW_RADIUS_F[ligand.type] ?? 1.70) + (VDW_RADIUS_F[receptor.type] ?? 1.70);
  const eps = ((VDW_EPSILON_F[ligand.type] ?? 0.15) + (VDW_EPSILON_F[receptor.type] ?? 0.15)) / 2;
  const ratio = sigma / distance;
  const r6 = Math.pow(ratio, 6);
  const r12 = r6 * r6;
  let vdw = eps * (r12 - 2 * r6);
  vdw = Math.max(-10, Math.min(10, vdw)); // cap like integer version

  // Electrostatic: Coulomb with distance-dependent dielectric
  const qL = ligand.charge / 1000;   // unscale charges
  const qR = receptor.charge / 1000;
  const elec = (332 * qL * qR) / (4 * distance * distance);

  // H-bond
  let hbond = 0;
  if (HBOND_TYPES.has(ligand.type) && HBOND_TYPES.has(receptor.type)) {
    if (distance >= 2.0 && distance <= 4.0) {
      const optimal = 3.0;
      const deviation = Math.abs(distance - optimal);
      const maxDev = 1.2;
      if (deviation < maxDev) {
        hbond = -0.5 * (1 - deviation / maxDev); // favorable = negative
      }
    }
  }

  return { distance, vdw, elec, hbond, total: vdw + elec + hbond };
}

/** Compute float batch energy (one receptor atom vs all ligand atoms) */
function floatBatchEnergy(ligandAtoms: Atom[], receptorAtom: Atom): { total: number; pairs: FloatPairResult[] } {
  const pairs = ligandAtoms.map(la => floatPairEnergy(la, receptorAtom));
  const total = pairs.reduce((s, p) => s + p.total, 0);
  return { total, pairs };
}

/** Full float scoring of a molecule against a receptor */
export function floatScoreMolecule(molecule: Molecule, receptor: ReceptorSite): number {
  let score = 0;
  for (const rAtom of receptor.atoms) {
    const batch = floatBatchEnergy(molecule.atoms, rAtom);
    score += batch.total;
  }
  return score;
}

/** Verify integer results against float reference for a single molecule */
export function verifyMolecule(
  molecule: Molecule & { active?: boolean },
  receptor: ReceptorSite,
  integerScore: number,
): VerificationResult {
  const steps: StepVerification[] = [];
  let floatScore = 0;

  for (let i = 0; i < receptor.atoms.length; i++) {
    const rAtom = receptor.atoms[i];
    const intBatch = computeBatchEnergy(molecule.atoms, rAtom);
    const fltBatch = floatBatchEnergy(molecule.atoms, rAtom);

    // Per-pair deviation
    let maxPairDelta = 0;
    for (let j = 0; j < molecule.atoms.length; j++) {
      const intPair = intBatch.pairs[j];
      const fltPair = fltBatch.pairs[j];
      // Scale float to integer format (×1000) for comparison
      const fltScaled = Math.round(fltPair.total * 1000);
      const delta = Math.abs(intPair.total - fltScaled);
      if (delta > maxPairDelta) maxPairDelta = delta;
    }

    floatScore += fltBatch.total;

    steps.push({
      receptorIdx: i,
      integerBatchTotal: intBatch.batchTotal,
      floatBatchTotal: fltBatch.total,
      delta: Math.abs(intBatch.batchTotal - Math.round(fltBatch.total * 1000)),
      maxPairDelta,
    });
  }

  // Scale float score to integer format for comparison
  const floatScoreScaled = floatScore * 1000;
  const delta = integerScore - floatScoreScaled;

  return {
    moleculeId: molecule.id,
    moleculeName: molecule.name,
    active: molecule.active ?? false,
    integerScore,
    integerPairCount: molecule.atoms.length * receptor.atoms.length,
    floatScore: floatScoreScaled,
    scoreDelta: delta,
    scoreRatio: floatScoreScaled !== 0 ? integerScore / floatScoreScaled : 1,
    rankPreserved: true, // set by batch comparison
    steps,
  };
}

/** Verify an entire batch: check if integer ranking matches float ranking */
export function verifyBatch(
  molecules: Array<Molecule & { active?: boolean }>,
  receptor: ReceptorSite,
): { results: VerificationResult[]; rankCorrelation: number; activesScoredBetter: boolean } {
  // Compute integer scores
  const intScores = molecules.map(mol => {
    let score = 0;
    for (const rAtom of receptor.atoms) {
      score += computeBatchEnergy(mol.atoms, rAtom).batchTotal;
    }
    return score;
  });

  // Verify each molecule
  const results = molecules.map((mol, i) => verifyMolecule(mol, receptor, intScores[i]));

  // Check rank correlation: sort by integer score and float score, compare ordering
  const intRanked = results.map((r, i) => ({ i, score: r.integerScore })).sort((a, b) => a.score - b.score);
  const fltRanked = results.map((r, i) => ({ i, score: r.floatScore })).sort((a, b) => a.score - b.score);

  // Spearman rank correlation
  let d2Sum = 0;
  const n = results.length;
  for (let rank = 0; rank < n; rank++) {
    const intIdx = intRanked[rank].i;
    const fltRank = fltRanked.findIndex(f => f.i === intIdx);
    const d = rank - fltRank;
    d2Sum += d * d;
  }
  const rankCorrelation = n > 1 ? 1 - (6 * d2Sum) / (n * (n * n - 1)) : 1;

  // Mark rank preservation
  for (let rank = 0; rank < n; rank++) {
    const intIdx = intRanked[rank].i;
    const fltRank = fltRanked.findIndex(f => f.i === intIdx);
    results[intIdx].rankPreserved = Math.abs(rank - fltRank) <= 2; // within 2 positions
  }

  // Check: do known actives score better (lower = better) than decoys on average?
  const activeScores = results.filter(r => r.active).map(r => r.integerScore);
  const decoyScores = results.filter(r => !r.active).map(r => r.integerScore);
  const avgActive = activeScores.length > 0 ? activeScores.reduce((a, b) => a + b, 0) / activeScores.length : 0;
  const avgDecoy = decoyScores.length > 0 ? decoyScores.reduce((a, b) => a + b, 0) / decoyScores.length : 0;
  const activesScoredBetter = activeScores.length > 0 && decoyScores.length > 0 && avgActive < avgDecoy;

  return { results, rankCorrelation, activesScoredBetter };
}

// --- CLI: run verification on the real molecule library ---
async function main() {
  const { readFileSync } = await import('fs');

  let data: any;
  try {
    data = JSON.parse(readFileSync('data/cdk2/library.json', 'utf-8'));
  } catch {
    console.error('No library.json found. Run: npx tsx src/realMolecules.ts');
    process.exit(1);
  }

  const receptor: ReceptorSite = data.receptor;
  const molecules: Array<Molecule & { active?: boolean; category?: string }> = data.molecules;

  console.log(`Verifying ${molecules.length} molecules against ${receptor.name}`);
  console.log(`Receptor atoms: ${receptor.atoms.length}`);
  console.log('');

  const { results, rankCorrelation, activesScoredBetter } = verifyBatch(molecules, receptor);

  // Print results table
  console.log('Molecule                   | Active | Int Score | Float Score | Delta     | Ratio  | Rank OK');
  console.log('---------------------------+--------+-----------+-------------+-----------+--------+--------');
  for (const r of results.sort((a, b) => a.integerScore - b.integerScore)) {
    const name = (r.moleculeName ?? r.moleculeId).padEnd(26);
    const active = r.active ? ' YES  ' : '  no  ';
    const intS = r.integerScore.toString().padStart(9);
    const fltS = r.floatScore.toFixed(0).padStart(11);
    const delta = r.scoreDelta.toFixed(0).padStart(9);
    const ratio = r.scoreRatio.toFixed(3).padStart(6);
    const rank = r.rankPreserved ? '  OK  ' : ' DIFF ';
    console.log(`${name} | ${active} | ${intS} | ${fltS} | ${delta} | ${ratio} | ${rank}`);
  }

  console.log('');
  console.log(`Rank correlation (Spearman): ${rankCorrelation.toFixed(4)}`);
  console.log(`Actives score better than decoys: ${activesScoredBetter ? 'YES' : 'NO'}`);

  const activeScores = results.filter(r => r.active).map(r => r.integerScore);
  const decoyScores = results.filter(r => !r.active).map(r => r.integerScore);
  if (activeScores.length > 0 && decoyScores.length > 0) {
    const avgActive = activeScores.reduce((a, b) => a + b, 0) / activeScores.length;
    const avgDecoy = decoyScores.reduce((a, b) => a + b, 0) / decoyScores.length;
    console.log(`  Active avg: ${avgActive.toFixed(0)}, Decoy avg: ${avgDecoy.toFixed(0)}`);
  }

  // Step-level analysis
  const maxDeltas = results.map(r => Math.max(...r.steps.map(s => s.delta)));
  console.log(`\nMax per-step delta: ${Math.max(...maxDeltas)}`);
  console.log(`Avg per-step delta: ${(maxDeltas.reduce((a, b) => a + b, 0) / maxDeltas.length).toFixed(1)}`);
}

if (process.argv[1]?.endsWith('verifier.ts') || process.argv[1]?.endsWith('verifier.js')) {
  main().catch(console.error);
}
