/**
 * Worker management: spawns worker_threads for parallel chain building.
 * Each worker thread runs chainWorkerThread.ts which handles the actual
 * computation. The same protocol is used by remote agents over HTTP.
 */
import { Worker } from 'worker_threads';
import { Transaction } from '@bsv/sdk';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, writeFileSync } from 'fs';
import type { ChainEvent, ChainResult } from './chainBuilder.js';
import type { Molecule, ReceptorSite, ChainState } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Worker shim: registers tsx loader then imports the actual worker thread code.
// This is needed because tsx's ESM loader doesn't auto-register in worker_threads.
const WORKER_SHIM_PATH = join(__dirname, '.workerShim.mjs');
const WORKER_THREAD_PATH = join(__dirname, 'chainWorkerThread.ts');

function ensureWorkerShim(): void {
  if (!existsSync(WORKER_SHIM_PATH)) {
    writeFileSync(WORKER_SHIM_PATH, `
import { register } from 'tsx/esm/api';
register();
const workerPath = process.env.MOLDOCK_WORKER_PATH;
await import(workerPath);
`);
  }
}

// --- Agent profiles with personality ---
export const AGENT_PROFILES = [
  { name: 'Curie',      speedFactor: 0.4, desc: 'fast' },
  { name: 'Pauling',    speedFactor: 0.7, desc: 'quick' },
  { name: 'Hodgkin',    speedFactor: 1.0, desc: 'steady' },
  { name: 'Franklin',   speedFactor: 1.5, desc: 'careful' },
  { name: 'Mendeleev',  speedFactor: 2.2, desc: 'thorough' },
];

const SHARES_PER_MILESTONE = 100;
const PASS_PERCENTILE = 0.20;
const BASE_DELAY_MS = 80;

export interface WorkerStats {
  processed: number;
  passed: number;
  failed: number;
  errors: number;
  totalTxs: number;
  totalBytes: number;
  totalChainSteps: number;
  shares: number;
  passedSinceLastShare: number;
  currentMolecule: string | null;
  currentStep: number;
  totalSteps: number;
  idle: boolean;
}

export interface WorkerAgent {
  id: number;
  name: string;
  speedFactor: number;
  desc: string;
  stats: WorkerStats;
  shareHistory: ShareMilestone[];
  thread?: Worker; // worker_thread handle
}

export interface ShareMilestone {
  shareNumber: number;
  earnedAt: string;
  moleculesVerified: number;
  passesAtMilestone: number;
  totalTxsAtMilestone: number;
  totalBytesAtMilestone: number;
}

export interface QueuedWork {
  molecule: Molecule;
  genesisTx: Transaction;
  genesisTxid: string;
}

export interface WorkerResult extends ChainResult {
  agentName: string;
  agentId: number;
  passed: boolean;
}

// --- Percentile-based pass/fail ---
export class PercentileTracker {
  private scores: number[] = [];
  private threshold: number = -Infinity;

  addScore(score: number): void {
    this.scores.push(score);
    this.recalculate();
  }

  private recalculate(): void {
    if (this.scores.length < 5) {
      this.threshold = Infinity;
      return;
    }
    const sorted = [...this.scores].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * PASS_PERCENTILE);
    this.threshold = sorted[idx];
  }

  isPassing(score: number): boolean {
    return score <= this.threshold;
  }

  getThreshold(): number {
    return this.threshold;
  }

  getCount(): number {
    return this.scores.length;
  }
}

export function createWorker(id: number, profile: typeof AGENT_PROFILES[0]): WorkerAgent {
  return {
    id,
    name: profile.name,
    speedFactor: profile.speedFactor,
    desc: profile.desc,
    stats: {
      processed: 0, passed: 0, failed: 0, errors: 0,
      totalTxs: 0, totalBytes: 0, totalChainSteps: 0,
      shares: 0, passedSinceLastShare: 0,
      currentMolecule: null, currentStep: 0, totalSteps: 0, idle: true,
    },
    shareHistory: [],
  };
}

export function resetWorkerStats(agent: WorkerAgent): void {
  agent.stats = {
    processed: 0, passed: 0, failed: 0, errors: 0,
    totalTxs: 0, totalBytes: 0, totalChainSteps: 0,
    shares: agent.stats.shares,
    passedSinceLastShare: agent.stats.passedSinceLastShare,
    currentMolecule: null, currentStep: 0, totalSteps: 0, idle: true,
  };
}

/**
 * Run a worker agent using a worker_thread.
 * The thread handles chain building in parallel; results come back via messages.
 */
export async function runWorker(
  agent: WorkerAgent,
  queue: QueuedWork[],
  receptor: ReceptorSite,
  compiledAsmOrMap: string | Map<number, string>,
  percentileTracker: PercentileTracker,
  onEvent: (agent: WorkerAgent, event: ChainEvent) => void,
  onResult: (agent: WorkerAgent, result: WorkerResult) => void,
): Promise<void> {
  const stepDelay = Math.floor(BASE_DELAY_MS * agent.speedFactor);

  // Try to use worker_threads; fall back to inline execution if it fails
  const useThreads = true;

  if (useThreads) {
    try {
      await runWorkerThreaded(agent, queue, receptor, compiledAsmOrMap, percentileTracker, onEvent, onResult, stepDelay);
      return;
    } catch (err: any) {
      console.log(`[${agent.name}] Thread mode failed (${err.message}), falling back to inline`);
    }
  }

  // Inline fallback
  await runWorkerInline(agent, queue, receptor, compiledAsmOrMap, percentileTracker, onEvent, onResult, stepDelay);
}

/** Worker_thread-based execution — true parallelism */
async function runWorkerThreaded(
  agent: WorkerAgent,
  queue: QueuedWork[],
  receptor: ReceptorSite,
  compiledAsmOrMap: string | Map<number, string>,
  percentileTracker: PercentileTracker,
  onEvent: (agent: WorkerAgent, event: ChainEvent) => void,
  onResult: (agent: WorkerAgent, result: WorkerResult) => void,
  stepDelay: number,
): Promise<void> {
  // Create the shim file that registers tsx loader for worker threads
  ensureWorkerShim();

  const workerUrl = 'file://' + WORKER_THREAD_PATH;

  return new Promise<void>((resolvePromise, reject) => {
    const thread = new Worker(WORKER_SHIM_PATH, {
      workerData: { workerId: agent.id, workerName: agent.name },
      env: { ...process.env, MOLDOCK_WORKER_PATH: workerUrl },
    });

    agent.thread = thread;
    let workIndex = 0;

    function sendNextWork() {
      const work = queue.shift();
      if (!work) {
        // No more work — shut down thread
        thread.postMessage({ type: 'shutdown' });
        agent.stats.idle = true;
        agent.stats.currentMolecule = null;
        resolvePromise();
        return;
      }

      agent.stats.idle = false;
      agent.stats.currentMolecule = work.molecule.id;
      agent.stats.currentStep = 0;
      agent.stats.totalSteps = receptor.atoms.length;

      const compiledAsm = typeof compiledAsmOrMap === 'string'
        ? compiledAsmOrMap
        : compiledAsmOrMap.get(work.molecule.atoms.length)!;

      thread.postMessage({
        type: 'work',
        molecule: work.molecule,
        receptor,
        compiledAsm,
        genesisTxHex: work.genesisTx.toHex(),
        genesisTxid: work.genesisTxid,
        stepDelayMs: stepDelay,
      });
    }

    thread.on('message', (msg: any) => {
      if (msg.type === 'ready') {
        // Thread is ready — send first work item
        sendNextWork();
        return;
      }

      if (msg.type === 'event') {
        const event = msg.event as ChainEvent;
        if (event.type === 'step') {
          agent.stats.currentStep = event.step;
        }
        onEvent(agent, event);
        return;
      }

      if (msg.type === 'result') {
        const result = msg as any;

        // Reconstruct Transaction objects from hex strings for broadcasting
        const txChain = (result.txHexes as string[]).map((hex: string) => Transaction.fromHex(hex));

        let passed = false;
        if (result.status === 'completed') {
          percentileTracker.addScore(result.finalScore);
          passed = percentileTracker.isPassing(result.finalScore);
        }

        // Update agent stats
        agent.stats.processed++;
        if (result.status === 'completed') {
          if (passed) {
            agent.stats.passed++;
            agent.stats.passedSinceLastShare++;
            if (agent.stats.passedSinceLastShare >= SHARES_PER_MILESTONE) {
              agent.stats.shares++;
              agent.stats.passedSinceLastShare = 0;
              agent.shareHistory.push({
                shareNumber: agent.stats.shares,
                earnedAt: new Date().toISOString(),
                moleculesVerified: agent.stats.processed,
                passesAtMilestone: agent.stats.passed,
                totalTxsAtMilestone: agent.stats.totalTxs,
                totalBytesAtMilestone: agent.stats.totalBytes,
              });
            }
          } else {
            agent.stats.failed++;
          }
        } else {
          agent.stats.errors++;
        }
        agent.stats.totalTxs += result.totalTxs;
        agent.stats.totalBytes += result.totalBytes;
        agent.stats.totalChainSteps += result.stepTxids.length;

        const workerResult: WorkerResult = {
          moleculeId: result.moleculeId,
          genesisTxid: result.genesisTxid,
          stepTxids: result.stepTxids,
          states: result.states,
          finalScore: result.finalScore,
          totalTxs: result.totalTxs,
          totalBytes: result.totalBytes,
          status: result.status,
          error: result.error,
          durationMs: result.durationMs,
          txChain,
          agentName: agent.name,
          agentId: agent.id,
          passed,
        };

        onResult(agent, workerResult);

        // Send next work item
        sendNextWork();
      }
    });

    thread.on('error', (err: Error) => {
      console.error(`[${agent.name}] Thread error:`, err.message);
      agent.stats.idle = true;
      reject(err);
    });

    thread.on('exit', (code) => {
      agent.thread = undefined;
      if (code !== 0 && code !== null) {
        console.log(`[${agent.name}] Thread exited with code ${code}`);
      }
    });
  });
}

/** Inline fallback — no threading, sequential execution */
async function runWorkerInline(
  agent: WorkerAgent,
  queue: QueuedWork[],
  receptor: ReceptorSite,
  compiledAsmOrMap: string | Map<number, string>,
  percentileTracker: PercentileTracker,
  onEvent: (agent: WorkerAgent, event: ChainEvent) => void,
  onResult: (agent: WorkerAgent, result: WorkerResult) => void,
  stepDelay: number,
): Promise<void> {
  // Dynamic import to avoid circular deps at module level
  const { executeChainSteps } = await import('./chainBuilder.js');

  while (true) {
    const work = queue.shift();
    if (!work) break;

    agent.stats.idle = false;
    agent.stats.currentMolecule = work.molecule.id;
    agent.stats.currentStep = 0;
    agent.stats.totalSteps = receptor.atoms.length;

    const compiledAsm = typeof compiledAsmOrMap === 'string'
      ? compiledAsmOrMap
      : compiledAsmOrMap.get(work.molecule.atoms.length)!;

    const result = await executeChainSteps(
      work.molecule, receptor, compiledAsm,
      work.genesisTx, work.genesisTxid,
      {
        onEvent: (event: ChainEvent) => {
          if (event.type === 'step') agent.stats.currentStep = event.step;
          onEvent(agent, event);
        },
        stepDelayMs: stepDelay,
      },
    );

    let passed = false;
    if (result.status === 'completed') {
      percentileTracker.addScore(result.finalScore);
      passed = percentileTracker.isPassing(result.finalScore);
    }

    agent.stats.processed++;
    if (result.status === 'completed') {
      if (passed) {
        agent.stats.passed++;
        agent.stats.passedSinceLastShare++;
        if (agent.stats.passedSinceLastShare >= SHARES_PER_MILESTONE) {
          agent.stats.shares++;
          agent.stats.passedSinceLastShare = 0;
          agent.shareHistory.push({
            shareNumber: agent.stats.shares,
            earnedAt: new Date().toISOString(),
            moleculesVerified: agent.stats.processed,
            passesAtMilestone: agent.stats.passed,
            totalTxsAtMilestone: agent.stats.totalTxs,
            totalBytesAtMilestone: agent.stats.totalBytes,
          });
        }
      } else {
        agent.stats.failed++;
      }
    } else {
      agent.stats.errors++;
    }
    agent.stats.totalTxs += result.totalTxs;
    agent.stats.totalBytes += result.totalBytes;
    agent.stats.totalChainSteps += result.stepTxids.length;
    agent.stats.currentMolecule = null;
    agent.stats.idle = true;

    onResult(agent, {
      ...result,
      agentName: agent.name,
      agentId: agent.id,
      passed,
    });
  }
}
