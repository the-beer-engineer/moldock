import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { generateChainSx, generateChainSxProj } from './chainTemplate.js';
import { computeBatchEnergy } from './energy.js';
import type { Molecule, ReceptorSite, BatchResult, ChainState } from './types.js';

const SXC_DIR = '/Users/reacher/workspace/projects/BitcoinSX';

interface PipelineResult {
  moleculeId: string;
  numAtoms: number;
  chainLength: number;
  finalScore: number;
  states: ChainState[];
  sxcVerified: boolean;
  compiledAsm?: string;
  error?: string;
}

// Full pipeline: generate script, compute energies, verify with sxc
export function runPipeline(
  molecule: Molecule,
  receptor: ReceptorSite,
): PipelineResult {
  const numAtoms = molecule.atoms.length;
  const chainLength = receptor.atoms.length;

  // Step 1: Compute all batch energies
  const batches: BatchResult[] = receptor.atoms.map(ra =>
    computeBatchEnergy(molecule.atoms, ra)
  );

  // Step 2: Generate .sx source for this atom count
  const sxSource = generateChainSx(numAtoms);

  // Step 3: Compile to verify syntax
  const sxPath = `/tmp/moldock_pipeline_${numAtoms}_${Date.now()}.sx`;
  writeFileSync(sxPath, sxSource);

  let compiledAsm: string | undefined;
  try {
    const compileOutput = execSync(`npx tsx cli/sxc.ts compile ${sxPath} --json`, {
      encoding: 'utf-8',
      cwd: SXC_DIR,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    });
    const compileResult = JSON.parse(compileOutput);
    if (!compileResult.success) {
      return {
        moleculeId: molecule.id,
        numAtoms,
        chainLength,
        finalScore: 0,
        states: [],
        sxcVerified: false,
        error: `Compile failed: ${JSON.stringify(compileResult.warnings)}`,
      };
    }
    compiledAsm = compileResult.lockingAsm;
  } catch (err: any) {
    return {
      moleculeId: molecule.id,
      numAtoms,
      chainLength,
      finalScore: 0,
      states: [],
      sxcVerified: false,
      error: `Compile error: ${err.message}`,
    };
  } finally {
    try { unlinkSync(sxPath); } catch {}
  }

  // Step 4: Build chain states
  const states: ChainState[] = [];
  let score = 0;
  for (let i = 0; i < chainLength; i++) {
    const newScore = score + batches[i].batchTotal;
    states.push({ scoreIn: score, scoreOut: newScore, receptorIdx: i });
    score = newScore;
  }

  // Step 5: Generate .sxProj.json and simulate with sxc
  const atomData = batches.map(b => ({
    pairs: b.pairs.map(p => ({
      dsq: p.dsq, dist: p.dist, vdw: p.vdw, elec: p.elec, hbond: p.hbond,
    })),
    batchTotal: b.batchTotal,
  }));

  const projJson = generateChainSxProj(numAtoms, chainLength, atomData);
  const projPath = `/tmp/moldock_pipeline_${numAtoms}_${Date.now()}.sxProj.json`;
  writeFileSync(projPath, projJson);

  let sxcVerified = false;
  try {
    const simOutput = execSync(`npx tsx cli/sxc.ts simulate ${projPath}`, {
      encoding: 'utf-8',
      cwd: SXC_DIR,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    });
    sxcVerified = simOutput.includes('Simulation Passed');
  } catch {
    sxcVerified = false;
  } finally {
    try { unlinkSync(projPath); } catch {}
  }

  return {
    moleculeId: molecule.id,
    numAtoms,
    chainLength,
    finalScore: score,
    states,
    sxcVerified,
    compiledAsm,
  };
}

// Run pipeline for multiple molecules
export function runBatchPipeline(
  molecules: Molecule[],
  receptor: ReceptorSite,
): PipelineResult[] {
  return molecules.map((mol, i) => {
    const result = runPipeline(mol, receptor);
    if (i % 10 === 0 && i > 0) {
      process.stdout.write(`  ${i}/${molecules.length}...\r`);
    }
    return result;
  });
}
