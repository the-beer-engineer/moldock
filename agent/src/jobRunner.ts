/**
 * Job runner: manages docking job lifecycle, worker dispatch, and continuous mode.
 * Extracted from server.ts for maintainability.
 */
import { randomUUID } from 'crypto';
import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import { bulkFundWalletP2PK, getCompiledAsm, type ChainEvent, type ChainResult } from './chainBuilder.js';
import { buildChainLockScript } from './genesis.js';
import { generateMolecule, generateReceptorSite, getRealMolecules } from './generate.js';
import * as regtest from './regtest.js';
import type { Molecule, ReceptorSite } from './types.js';
import { verifyBatch } from './verifier.js';
import {
  AGENT_PROFILES,
  createWorker,
  resetWorkerStats,
  runWorker,
  PercentileTracker,
  type WorkerAgent,
  type WorkerResult,
  type QueuedWork,
} from './worker.js';
import { BroadcastAgent } from './broadcastAgent.js';

// --- Job types ---
export type JobStatus = 'preparing' | 'running' | 'completed' | 'failed';

export interface DockingJob {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  config: { numMolecules: number; numAtoms: number; numReceptorAtoms: number; useReal?: boolean };
  totalMolecules: number;
  genesisCreated: number;
  results: WorkerResult[];
  error?: string;
  verification?: { rankCorrelation: number; activesScoredBetter: boolean };
}

// --- Shared state ---
export const jobs = new Map<string, DockingJob>();
export const workers: WorkerAgent[] = [];
export const recentEvents: Array<ChainEvent & { agentName?: string }> = [];
export const MAX_EVENTS = 500;

export let activeJob: DockingJob | null = null;
export let aborted = false;
export let startTime = 0;
let txsSinceLastMine = 0;

export const parentWallet = new Wallet(undefined, 'regtest');
export const percentileTracker = new PercentileTracker();

// Continuous mode
export let continuousMode = false;
export let continuousTarget = 0;
export let continuousTotalTxs = 0;
export let continuousBatch = 0;
export let continuousConfig = { numMolecules: 20, numAtoms: 3, numReceptorAtoms: 3 };

// Setters for mutable state
export function setActiveJob(j: DockingJob | null) { activeJob = j; }
export function setAborted(v: boolean) { aborted = v; }
export function setContinuousMode(v: boolean) { continuousMode = v; }
export function setContinuousTarget(v: number) { continuousTarget = v; }
export function setContinuousTotalTxs(v: number) { continuousTotalTxs = v; }
export function setContinuousBatch(v: number) { continuousBatch = v; }
export function setContinuousConfig(c: typeof continuousConfig) { continuousConfig = c; }

// Initialize workers
for (let i = 0; i < AGENT_PROFILES.length; i++) {
  workers.push(createWorker(i, AGENT_PROFILES[i]));
}

// Initialize broadcast agent
export const broadcastAgent = new BroadcastAgent({
  onBroadcast: (molId, idx, total, txid) => {
    recentEvents.push({ type: 'step', moleculeId: molId, step: idx, totalSteps: total, txid, score: 0, agentName: 'Broadcaster' });
    if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
  },
  onError: (molId, idx, error) => {
    recentEvents.push({ type: 'error', moleculeId: molId, step: idx, error, agentName: 'Broadcaster' });
    if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
  },
});
broadcastAgent.start();

// --- Job runner ---
export async function runJob(job: DockingJob): Promise<void> {
  activeJob = job;
  aborted = false;
  job.status = 'preparing';
  job.startedAt = new Date().toISOString();
  startTime = performance.now();

  for (const w of workers) { resetWorkerStats(w); }

  const { numMolecules, numAtoms, numReceptorAtoms, useReal } = job.config;

  let molecules: Molecule[];
  let receptor: ReceptorSite;

  if (useReal) {
    const real = getRealMolecules(numMolecules);
    molecules = real.molecules;
    receptor = real.receptor;
    console.log(`[parent] Using ${molecules.length} real molecules against ${receptor.name}`);
  } else {
    molecules = Array.from({ length: numMolecules }, () => generateMolecule(numAtoms));
    receptor = generateReceptorSite(numReceptorAtoms);
  }

  // Pre-compile scripts for all unique atom counts
  const atomCounts = [...new Set(molecules.map(m => m.atoms.length))].sort((a, b) => a - b);
  const compiledAsmMap = new Map<number, string>();
  console.log(`[parent] Compiling chain scripts for ${atomCounts.length} atom counts: ${atomCounts.join(', ')}...`);
  for (const ac of atomCounts) {
    compiledAsmMap.set(ac, getCompiledAsm(ac));
  }
  console.log(`[parent] All scripts compiled`);

  // Bulk fund
  console.log(`[parent] Bulk-funding ${numMolecules} UTXOs...`);
  const fundingUtxos = await bulkFundWalletP2PK(parentWallet, numMolecules, 10000);
  console.log(`[parent] Funded ${fundingUtxos.length} UTXOs`);

  // Create all genesis TXs
  console.log(`[parent] Creating ${numMolecules} genesis TXs...`);
  const queue: QueuedWork[] = [];

  for (let i = 0; i < numMolecules; i++) {
    if (aborted) break;

    const mol = molecules[i];
    const utxo = fundingUtxos[i];
    const molAtomCount = mol.atoms.length;
    const compiledAsm = compiledAsmMap.get(molAtomCount)!;

    const genesisTx = new Transaction();
    genesisTx.version = 2;
    genesisTx.addInput({
      sourceTransaction: utxo.sourceTransaction,
      sourceOutputIndex: utxo.vout,
      unlockingScriptTemplate: parentWallet.p2pkUnlock(utxo.satoshis, Script.fromHex(utxo.script)),
    });
    genesisTx.addOutput({ lockingScript: buildChainLockScript(molAtomCount, 0, compiledAsm), satoshis: 1 });
    genesisTx.addOutput({ lockingScript: parentWallet.p2pkLockingScript(), change: true });
    await genesisTx.fee(new SatoshisPerKilobyte(1));
    await genesisTx.sign();

    const genesisTxid = regtest.broadcastOnly(genesisTx);
    txsSinceLastMine++;
    job.genesisCreated++;

    queue.push({ molecule: mol, genesisTx, genesisTxid });

    if (txsSinceLastMine >= 25) {
      regtest.mine(1);
      txsSinceLastMine = 0;
    }
  }

  if (txsSinceLastMine > 0) {
    regtest.mine(1);
    txsSinceLastMine = 0;
  }

  console.log(`[parent] ${queue.length} genesis TXs created. Dispatching to ${workers.length} workers...`);
  job.status = 'running';

  const onEvent = (agent: WorkerAgent, event: ChainEvent) => {
    recentEvents.push({ ...event, agentName: agent.name });
    if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
  };

  const onResult = (agent: WorkerAgent, result: WorkerResult) => {
    job.results.push(result);
    const icon = result.passed ? 'PASS' : 'FAIL';
    console.log(`  [${agent.name}] ${icon} ${result.moleculeId}: score=${result.finalScore} (${result.totalTxs} txs)`);

    if (result.txChain && result.txChain.length > 0) {
      broadcastAgent.enqueue({ moleculeId: result.moleculeId, txs: result.txChain });
    }
  };

  await Promise.all(
    workers.map(w => runWorker(w, queue, receptor, compiledAsmMap, percentileTracker, onEvent, onResult))
  );

  console.log(`[parent] Workers done. Flushing ${broadcastAgent.getStats().queueDepth} chains to broadcast agent...`);
  await broadcastAgent.flush();

  job.status = 'completed';
  job.completedAt = new Date().toISOString();
  activeJob = null;

  const passed = job.results.filter(r => r.passed).length;
  const failed = job.results.length - passed;
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  const batchTxs = job.results.reduce((s: number, r) => s + r.totalTxs, 0) + numMolecules;
  continuousTotalTxs += batchTxs;
  console.log(`\n=== Job ${job.id} Complete (batch ${continuousBatch}) ===`);
  console.log(`Molecules: ${passed} passed, ${failed} failed (${job.results.length} total)`);
  console.log(`TXs: ${batchTxs} (cumulative: ${continuousTotalTxs}) in ${elapsed}s`);
  console.log(`Percentile threshold: ${percentileTracker.getThreshold()} (${percentileTracker.getCount()} samples)`);

  if (useReal && molecules.length > 0) {
    try {
      const vr = verifyBatch(molecules as any, receptor);
      job.verification = { rankCorrelation: vr.rankCorrelation, activesScoredBetter: vr.activesScoredBetter };
      console.log(`Verification: rank correlation=${vr.rankCorrelation.toFixed(4)}, actives better=${vr.activesScoredBetter}`);
    } catch {}
  }

  // Continuous mode: auto-launch next batch
  if (continuousMode && !aborted && continuousTotalTxs < continuousTarget) {
    console.log(`[continuous] ${continuousTotalTxs}/${continuousTarget} TXs — launching next batch...`);
    continuousBatch++;
    const nextJob: DockingJob = {
      id: randomUUID().slice(0, 8),
      status: 'preparing',
      createdAt: new Date().toISOString(),
      config: { ...continuousConfig },
      totalMolecules: continuousConfig.numMolecules,
      genesisCreated: 0,
      results: [],
    };
    jobs.set(nextJob.id, nextJob);
    runJob(nextJob).catch(err => {
      nextJob.status = 'failed';
      nextJob.error = err.message;
      activeJob = null;
      continuousMode = false;
      console.error('Continuous batch failed:', err);
    });
  } else if (continuousMode && continuousTotalTxs >= continuousTarget) {
    console.log(`[continuous] TARGET REACHED: ${continuousTotalTxs} TXs (target: ${continuousTarget})`);
    continuousMode = false;
  }
}
