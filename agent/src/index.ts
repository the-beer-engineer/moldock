import { readFileSync } from 'fs';
import { computeBatchEnergy } from './energy.js';
import type { Molecule, ReceptorSite } from './types.js';

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.log(`
moldock agent — molecular docking on BSV

Commands:
  rank <molecules.json> <receptor.json>   Score and rank molecules off-chain
  energy <molecule.json> <receptor.json>  Show per-atom energy breakdown
  serve                                   Start the multi-agent HTTP server

Options:
  --top N    Show top N results (default: 10)
`);
}

if (!command || command === '--help') {
  usage();
  process.exit(0);
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Score a molecule against all receptor atoms, return total score */
function scoreMolecule(mol: Molecule, receptor: ReceptorSite): number {
  let total = 0;
  for (const rAtom of receptor.atoms) {
    total += computeBatchEnergy(mol.atoms, rAtom).batchTotal;
  }
  return total;
}

switch (command) {
  case 'rank': {
    const molPath = args[1];
    const recPath = args[2];
    if (!molPath || !recPath) {
      console.error('Usage: moldock rank <molecules.json> <receptor.json>');
      process.exit(1);
    }

    const molecules = loadJson<Molecule[]>(molPath);
    const receptor = loadJson<ReceptorSite>(recPath);
    const topN = parseInt(args.find(a => a.startsWith('--top'))?.split('=')[1] || '10');

    console.log(`Scoring ${molecules.length} molecules against ${receptor.atoms.length} receptor atoms...`);

    const scored = molecules
      .map(mol => ({ id: mol.id, name: mol.name, score: scoreMolecule(mol, receptor) }))
      .sort((a, b) => a.score - b.score);

    console.log(`\nTop ${Math.min(topN, scored.length)} results:`);
    console.log('─'.repeat(60));

    for (let i = 0; i < Math.min(topN, scored.length); i++) {
      const r = scored[i];
      const passStr = receptor.threshold && r.score <= receptor.threshold ? ' PASS' : '';
      console.log(`  #${i + 1} ${r.name ?? r.id} → score: ${r.score}${passStr}`);
    }

    const totalTxs = molecules.length * (receptor.atoms.length + 1);
    console.log(`\nTotal on-chain TXs needed: ${totalTxs}`);
    break;
  }

  case 'energy': {
    const molPath = args[1];
    const recPath = args[2];
    if (!molPath || !recPath) {
      console.error('Usage: moldock energy <molecule.json> <receptor.json>');
      process.exit(1);
    }

    const molecule = loadJson<Molecule>(molPath);
    const receptor = loadJson<ReceptorSite>(recPath);

    console.log(`Molecule: ${molecule.id} (${molecule.atoms.length} atoms)`);
    console.log(`Receptor: ${receptor.id} (${receptor.atoms.length} atoms)\n`);

    let totalScore = 0;
    for (let r = 0; r < receptor.atoms.length; r++) {
      const batch = computeBatchEnergy(molecule.atoms, receptor.atoms[r]);
      console.log(`Receptor atom ${r}: batchTotal = ${batch.batchTotal}`);
      for (const [i, p] of batch.pairs.entries()) {
        console.log(`  L${i}→R${r}: dsq=${p.dsq} dist=${p.dist} vdw=${p.vdw} elec=${p.elec} hbond=${p.hbond} = ${p.total}`);
      }
      totalScore += batch.batchTotal;
    }
    console.log(`\nFinal score: ${totalScore}`);
    break;
  }

  case 'serve': {
    // Dynamically import server to start it
    await import('./server.js');
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}
