import { writeFileSync, readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import type { Atom, Molecule, ReceptorSite } from './types.js';
import { CDK2_BINDING_SITE, dockMoleculeToSite } from './realMolecules.js';

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateAtom(bounds: { min: number; max: number }): Atom {
  return {
    x: randInt(bounds.min, bounds.max),
    y: randInt(bounds.min, bounds.max),
    z: randInt(bounds.min, bounds.max),
    type: randInt(1, 8),
    charge: randInt(-200, 200),
  };
}

export function generateMolecule(numAtoms: number): Molecule {
  return {
    id: randomUUID().slice(0, 8),
    atoms: Array.from({ length: numAtoms }, () =>
      generateAtom({ min: 200, max: 800 })
    ),
  };
}

export function generateReceptorSite(numAtoms: number): ReceptorSite {
  return {
    id: 'receptor-' + randomUUID().slice(0, 8),
    name: 'Synthetic Binding Site',
    atoms: Array.from({ length: numAtoms }, () =>
      generateAtom({ min: 300, max: 700 })
    ),
    threshold: -50000, // minimum score to "pass"
  };
}

// --- Real molecule library ---
interface LibraryData {
  receptor: ReceptorSite;
  molecules: Array<Molecule & { active?: boolean; category?: string }>;
}

let cachedLibrary: LibraryData | null = null;

/** Load the real molecule library (downloaded from PubChem) */
export function loadRealLibrary(): LibraryData | null {
  if (cachedLibrary) return cachedLibrary;
  const libPath = new URL('../data/cdk2/library.json', import.meta.url);
  try {
    cachedLibrary = JSON.parse(readFileSync(libPath, 'utf-8'));
    return cachedLibrary;
  } catch {
    return null;
  }
}

/** Get real molecules for docking. Returns numMolecules molecules from the
 *  library, cycling through if more are needed. Each cycle adds a small
 *  random perturbation to create unique conformations. */
export function getRealMolecules(numMolecules: number): { molecules: Molecule[]; receptor: ReceptorSite } {
  const lib = loadRealLibrary();
  if (!lib) {
    // Fallback to synthetic
    console.warn('[generate] No real library found, using synthetic molecules');
    return {
      molecules: Array.from({ length: numMolecules }, () => generateMolecule(5)),
      receptor: generateReceptorSite(8),
    };
  }

  const molecules: Molecule[] = [];
  for (let i = 0; i < numMolecules; i++) {
    const baseMol = lib.molecules[i % lib.molecules.length];
    if (i < lib.molecules.length) {
      // First pass: use original coordinates
      molecules.push({ ...baseMol, id: `${baseMol.id}-${randomUUID().slice(0, 4)}` });
    } else {
      // Subsequent passes: perturb coordinates slightly (simulate different conformations)
      const perturbation = Math.floor(i / lib.molecules.length);
      molecules.push({
        ...baseMol,
        id: `${baseMol.id}-p${perturbation}-${randomUUID().slice(0, 4)}`,
        atoms: baseMol.atoms.map(a => ({
          ...a,
          x: a.x + randInt(-20, 20) * perturbation,
          y: a.y + randInt(-20, 20) * perturbation,
          z: a.z + randInt(-20, 20) * perturbation,
        })),
      });
    }
  }

  return { molecules, receptor: lib.receptor };
}

// CLI: generate test data (only runs when executed directly)
if (process.argv[1]?.endsWith('generate.ts') || process.argv[1]?.endsWith('generate.js')) {
  const numMolecules = parseInt(process.argv[2] || '10');
  const atomsPerMolecule = parseInt(process.argv[3] || '3');
  const receptorAtoms = parseInt(process.argv[4] || '3');

  const receptor = generateReceptorSite(receptorAtoms);
  const molecules = Array.from({ length: numMolecules }, () =>
    generateMolecule(atomsPerMolecule)
  );

  writeFileSync(
    new URL('../data/receptor.json', import.meta.url),
    JSON.stringify(receptor, null, 2)
  );

  writeFileSync(
    new URL('../data/molecules/batch.json', import.meta.url),
    JSON.stringify(molecules, null, 2)
  );

  console.log(`Generated ${numMolecules} molecules (${atomsPerMolecule} atoms each)`);
  console.log(`Generated receptor site (${receptorAtoms} atoms)`);
  console.log(`Files: data/receptor.json, data/molecules/batch.json`);
}
