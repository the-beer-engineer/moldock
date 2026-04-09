// All coordinates are fixed-point integers scaled ×100 (1.23 Å = 123)
// All energies are fixed-point integers scaled ×1000

export interface Atom {
  x: number;  // scaled ×100
  y: number;
  z: number;
  type: number;    // atom type: 1=C, 2=N, 3=O, 4=S, 5=H, 6=P, 7=F, 8=Cl
  charge: number;  // partial charge scaled ×1000
}

export interface Molecule {
  id: string;
  name?: string;
  atoms: Atom[];
}

export interface ReceptorSite {
  id: string;
  name?: string;
  atoms: Atom[];       // receptor atoms at the binding site
  threshold?: number;  // minimum score to pass (scaled ×1000)
}

export interface PairResult {
  dsq: number;     // dx² + dy² + dz²
  dist: number;    // floor(√dsq)
  vdw: number;     // van der Waals energy
  elec: number;    // electrostatic energy
  hbond: number;   // hydrogen bond energy
  total: number;   // vdw + elec + hbond
}

export interface BatchResult {
  pairs: PairResult[];
  batchTotal: number;
}

export interface ChainState {
  scoreIn: number;
  scoreOut: number;
  receptorIdx: number;
  txid?: string;
}

export interface ChainConfig {
  molecule: Molecule;
  receptorSite: ReceptorSite;
  numAtomsPerBatch: number;  // ligand atoms per batch TX
}
