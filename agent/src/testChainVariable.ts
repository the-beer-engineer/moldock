import { writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { generateChainSx, generateChainSxProj } from './chainTemplate.js';
import { computeBatchEnergy } from './energy.js';
import { generateMolecule, generateReceptorSite } from './generate.js';

const SXC = `tsx ${process.env.SXC_PATH || '/Users/reacher/workspace/projects/BitcoinSX/cli/sxc.ts'}`;

const SXC_DIR = process.env.SXC_DIR || '/Users/reacher/workspace/projects/BitcoinSX';

function sxcSimulate(projPath: string): { success: boolean; output: string } {
  try {
    const output = execSync(`npx tsx cli/sxc.ts simulate ${projPath}`, {
      encoding: 'utf-8',
      cwd: SXC_DIR,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    });
    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: (err.stdout || '') + (err.stderr || '') };
  }
}

function sxcCompile(sxPath: string): { success: boolean; output: string } {
  try {
    const output = execSync(`npx tsx cli/sxc.ts compile ${sxPath}`, {
      encoding: 'utf-8',
      cwd: SXC_DIR,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    });
    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: (err.stdout || '') + (err.stderr || '') };
  }
}

interface TestCase {
  numAtoms: number;
  chainLength: number;
  description: string;
}

const testCases: TestCase[] = [
  { numAtoms: 1,  chainLength: 2, description: '1 atom, 2-step chain' },
  { numAtoms: 3,  chainLength: 3, description: '3 atoms, 3-step chain' },
  { numAtoms: 10, chainLength: 2, description: '10 atoms, 2-step chain' },
  { numAtoms: 30, chainLength: 2, description: '30 atoms, 2-step chain' },
];

console.log('=== Variable Atom Count Chain Tests ===\n');

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  console.log(`--- Test: ${tc.description} ---`);

  // Generate molecule and receptor with random data
  const molecule = generateMolecule(tc.numAtoms);
  const receptor = generateReceptorSite(tc.chainLength);

  // Compute energy for each chain step
  const atomData = receptor.atoms.map(ra => computeBatchEnergy(molecule.atoms, ra));

  // Generate .sx source
  const sx = generateChainSx(tc.numAtoms);
  const sxPath = `/tmp/atomChain_${tc.numAtoms}.sx`;
  writeFileSync(sxPath, sx);

  // Compile
  const compileResult = sxcCompile(sxPath);
  if (!compileResult.success) {
    console.log(`  COMPILE FAILED:`);
    console.log(`  ${compileResult.output.split('\n').slice(0, 3).join('\n  ')}`);
    failed++;
    continue;
  }
  console.log(`  Compile: OK`);

  // Generate .sxProj.json with simulation data
  const projJson = generateChainSxProj(tc.numAtoms, tc.chainLength, atomData);
  const projPath = `/tmp/atomChain_${tc.numAtoms}_${tc.chainLength}.sxProj.json`;
  writeFileSync(projPath, projJson);

  // Simulate
  const simResult = sxcSimulate(projPath);
  if (!simResult.success) {
    console.log(`  SIMULATE FAILED:`);
    console.log(`  ${simResult.output.split('\n').slice(0, 5).join('\n  ')}`);
    failed++;
    continue;
  }

  // Parse results
  const passCount = (simResult.output.match(/✅/g) || []).length;
  const failCount = (simResult.output.match(/❌/g) || []).length;
  const timeMatch = simResult.output.match(/\((\d+\.\d+)ms\)/);
  const timeMs = timeMatch ? timeMatch[1] : '?';

  // Expected: chainLength passes (one per chain step, genesis doesn't count)
  const expectedPasses = tc.chainLength; // each step is a pass

  let runningScore = 0;
  const scoreTrace = atomData.map(d => {
    const old = runningScore;
    runningScore += d.batchTotal;
    return `${old}→${runningScore}`;
  });

  console.log(`  Simulate: ${passCount} passes, ${failCount} fails (${timeMs}ms)`);
  console.log(`  Score chain: ${scoreTrace.join(', ')} = ${runningScore}`);

  if (failCount === 0 && passCount >= tc.chainLength) {
    console.log(`  PASS ✓`);
    passed++;
  } else {
    console.log(`  FAIL ✗`);
    failed++;
  }

  // Cleanup
  try { unlinkSync(sxPath); } catch {}
  try { unlinkSync(projPath); } catch {}

  console.log('');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
