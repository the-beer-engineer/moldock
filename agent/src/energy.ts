import type { Atom, PairResult, BatchResult } from './types.js';

// Van der Waals radius table (scaled ×100)
// Index = atom type (1=C, 2=N, 3=O, 4=S, 5=H, 6=P, 7=F, 8=Cl)
const VDW_RADIUS: Record<number, number> = {
  1: 170, // C: 1.70 Å
  2: 155, // N: 1.55 Å
  3: 152, // O: 1.52 Å
  4: 180, // S: 1.80 Å
  5: 120, // H: 1.20 Å
  6: 180, // P: 1.80 Å
  7: 147, // F: 1.47 Å
  8: 175, // Cl: 1.75 Å
};

// Well depth epsilon (scaled ×1000) — simplified LJ parameter
const VDW_EPSILON: Record<number, number> = {
  1: 150, 2: 200, 3: 210, 4: 250,
  5: 50,  6: 200, 7: 180, 8: 300,
};

// H-bond donor/acceptor types (N, O, S can participate)
const HBOND_TYPES = new Set([2, 3, 4]);

export function computeDsq(l: Atom, r: Atom): number {
  const dx = l.x - r.x;
  const dy = l.y - r.y;
  const dz = l.z - r.z;
  return dx * dx + dy * dy + dz * dz;
}

export function computeIsqrt(dsq: number): number {
  if (dsq <= 0) return 0;
  const dist = Math.floor(Math.sqrt(dsq));
  // Verify: dist² ≤ dsq < (dist+1)²
  if (dist * dist > dsq) return dist - 1;
  if ((dist + 1) * (dist + 1) <= dsq) return dist + 1;
  return dist;
}

export function computeVdw(dist: number, typeL: number, typeR: number): number {
  // Simplified Lennard-Jones: ε * [(σ/r)^12 - 2(σ/r)^6]
  // Using integer approximation with sigma = sum of VdW radii
  const sigma = (VDW_RADIUS[typeL] || 170) + (VDW_RADIUS[typeR] || 170);
  const eps = Math.floor(((VDW_EPSILON[typeL] || 150) + (VDW_EPSILON[typeR] || 150)) / 2);

  if (dist <= 0) return 0;

  // σ/r ratio (both scaled ×100, so ratio is dimensionless ×100)
  const ratio100 = Math.floor((sigma * 100) / dist);

  // (σ/r)^6 scaled: ratio100^6 / 100^6 → too large, use float then convert
  const ratio = ratio100 / 100;
  const r6 = Math.pow(ratio, 6);
  const r12 = r6 * r6;

  // LJ energy = ε * (r12 - 2*r6), capped to prevent overflow
  const lj = eps * (r12 - 2 * r6);
  const clamped = Math.max(-10000, Math.min(10000, Math.round(lj)));
  return clamped;
}

export function computeElec(dist: number, chargeL: number, chargeR: number): number {
  // Coulomb: k * qL * qR / r
  // charges scaled ×1000, dist scaled ×100
  // Result scaled ×1000
  if (dist <= 0) return 0;

  // 332 is the Coulomb constant in kcal/mol·Å·e² units
  // Simplified: energy = 332 * qL * qR / (ε * r)
  // With dielectric ε = 4r (distance-dependent dielectric)
  const q = chargeL * chargeR; // scaled ×10^6
  const denom = 4 * dist * dist; // 4r² scaled ×10^4
  if (denom === 0) return 0;

  // Scale: (332 * q) / denom, adjust for our scaling
  const raw = Math.round((332 * q) / (denom * 100));
  return Math.max(-5000, Math.min(5000, raw));
}

export function computeHbond(dist: number, typeL: number, typeR: number): number {
  // H-bond scoring: only between donor/acceptor pairs (N, O, S)
  if (!HBOND_TYPES.has(typeL) || !HBOND_TYPES.has(typeR)) return 0;

  // Optimal H-bond distance: 2.8-3.2 Å (280-320 scaled ×100)
  // Score peaks at 300 (3.0 Å), falls off linearly
  if (dist < 200 || dist > 400) return 0;

  const optimal = 300;
  const deviation = Math.abs(dist - optimal);
  const maxDev = 120;

  if (deviation >= maxDev) return 0;

  // Linear falloff: max energy at optimal, zero at ±maxDev
  const score = Math.round(500 * (1 - deviation / maxDev));
  return -score; // negative = favorable
}

export function computePairEnergy(ligand: Atom, receptor: Atom): PairResult {
  const dsq = computeDsq(ligand, receptor);
  const dist = computeIsqrt(dsq);
  const vdw = computeVdw(dist, ligand.type, receptor.type);
  const elec = computeElec(dist, ligand.charge, receptor.charge);
  const hbond = computeHbond(dist, ligand.type, receptor.type);
  const total = vdw + elec + hbond;
  return { dsq, dist, vdw, elec, hbond, total };
}

export function computeBatchEnergy(ligandAtoms: Atom[], receptorAtom: Atom): BatchResult {
  const pairs = ligandAtoms.map(la => computePairEnergy(la, receptorAtom));
  const batchTotal = pairs.reduce((sum, p) => sum + p.total, 0);
  return { pairs, batchTotal };
}
