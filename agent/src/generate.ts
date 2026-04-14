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

/** Raw JSON shape: single-receptor (old) format */
interface OldLibraryData {
  receptor: ReceptorSite;
  molecules: Array<Molecule & { active?: boolean; category?: string }>;
}

/** Raw JSON shape: multi-receptor (new) format */
interface NewLibraryData {
  receptors: ReceptorSite[];
  molecules: Array<Molecule & { active?: boolean; category?: string; receptorId?: string }>;
}

/** Normalized internal representation — always multi-receptor */
interface LibraryData {
  receptors: Map<string, ReceptorSite>;
  molecules: Array<Molecule & { active?: boolean; category?: string; receptorId?: string }>;
}

let cachedLibrary: LibraryData | null = null;

/** Load the real molecule library (downloaded from PubChem).
 *  Tries the new multi-receptor `data/library.json` first,
 *  falls back to old single-receptor `data/cdk2/library.json`. */
export function loadRealLibrary(): LibraryData | null {
  if (cachedLibrary) return cachedLibrary;

  // Try new multi-receptor format first
  const newLibPath = new URL('../data/library.json', import.meta.url);
  try {
    const raw: NewLibraryData = JSON.parse(readFileSync(newLibPath, 'utf-8'));
    if (raw.receptors && Array.isArray(raw.receptors)) {
      const receptors = new Map<string, ReceptorSite>();
      for (const r of raw.receptors) {
        receptors.set(r.id, r);
      }
      cachedLibrary = { receptors, molecules: raw.molecules };
      return cachedLibrary;
    }
  } catch {
    // new format not available — fall through
  }

  // Fall back to old single-receptor format
  const oldLibPath = new URL('../data/cdk2/library.json', import.meta.url);
  try {
    const raw: OldLibraryData = JSON.parse(readFileSync(oldLibPath, 'utf-8'));
    const receptors = new Map<string, ReceptorSite>();
    receptors.set(raw.receptor.id, raw.receptor);
    // Tag all molecules with the single receptor's ID
    const molecules = raw.molecules.map(m => ({ ...m, receptorId: raw.receptor.id }));
    cachedLibrary = { receptors, molecules };
    return cachedLibrary;
  } catch {
    return null;
  }
}

/** Get real molecules for docking. Returns numMolecules molecules from the
 *  library, cycling through if more are needed. Each cycle adds a small
 *  random perturbation to create unique conformations.
 *
 *  Multi-receptor: each molecule carries its `receptorId` and the `receptors`
 *  map contains all binding sites. `receptor` returns the first for backward compat. */
export function getRealMolecules(numMolecules: number): {
  molecules: Array<Molecule & { receptorId?: string }>;
  receptors: Map<string, ReceptorSite>;
  receptor: ReceptorSite; // backward compat — first receptor
} {
  const lib = loadRealLibrary();
  if (!lib) {
    throw new Error('[generate] Real drug library not found! Run: npx tsx src/realMolecules.ts to download from PubChem. Synthetic fallback disabled for production.');
  }

  const molecules: Array<Molecule & { receptorId?: string }> = [];
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

  // First receptor for backward compat
  const firstReceptor = lib.receptors.values().next().value!;

  return { molecules, receptors: lib.receptors, receptor: firstReceptor };
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
