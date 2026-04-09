import { Transaction } from '@bsv/sdk';
import * as regtest from './regtest.js';

const CHUNK_SIZE = 25; // max unconfirmed ancestor chain length

export interface BroadcastStats {
  totalBroadcast: number;
  totalMined: number;
  blocksCreated: number;
  errors: number;
  queueDepth: number;
  running: boolean;
}

export interface BroadcastChain {
  moleculeId: string;
  txs: Transaction[];
}

/**
 * BroadcastAgent: receives completed TX chains from worker agents and
 * broadcasts them to the network in chunks, mining between chunks to
 * stay within the mempool ancestor limit (default 25).
 *
 * Workers build chains entirely in memory — this agent is the only
 * process that touches the network.
 */
export class BroadcastAgent {
  private queue: BroadcastChain[] = [];
  private running = false;
  private stats: BroadcastStats = {
    totalBroadcast: 0,
    totalMined: 0,
    blocksCreated: 0,
    errors: 0,
    queueDepth: 0,
    running: false,
  };
  private onBroadcast?: (moleculeId: string, txIdx: number, totalTxs: number, txid: string) => void;
  private onError?: (moleculeId: string, txIdx: number, error: string) => void;

  constructor(opts?: {
    onBroadcast?: (moleculeId: string, txIdx: number, totalTxs: number, txid: string) => void;
    onError?: (moleculeId: string, txIdx: number, error: string) => void;
  }) {
    this.onBroadcast = opts?.onBroadcast;
    this.onError = opts?.onError;
  }

  /** Enqueue a completed chain for broadcasting */
  enqueue(chain: BroadcastChain): void {
    this.queue.push(chain);
    this.stats.queueDepth = this.queue.length;
  }

  /** Enqueue multiple chains at once */
  enqueueAll(chains: BroadcastChain[]): void {
    this.queue.push(...chains);
    this.stats.queueDepth = this.queue.length;
  }

  getStats(): BroadcastStats {
    return { ...this.stats, queueDepth: this.queue.length, running: this.running };
  }

  /** Start the broadcast loop. Runs until stopped or queue empty. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stats.running = true;

    while (this.running) {
      const chain = this.queue.shift();
      if (!chain) {
        // Nothing to broadcast — wait briefly then check again
        await new Promise(r => setTimeout(r, 50));
        continue;
      }

      this.stats.queueDepth = this.queue.length;
      await this.broadcastChain(chain);
    }

    this.stats.running = false;
  }

  /** Stop the broadcast loop after current chain finishes */
  stop(): void {
    this.running = false;
  }

  /** Broadcast a single chain in chunks */
  private async broadcastChain(chain: BroadcastChain): Promise<void> {
    const { moleculeId, txs } = chain;
    let sinceLastMine = 0;

    for (let i = 0; i < txs.length; i++) {
      try {
        const txid = regtest.broadcastOnly(txs[i]);
        this.stats.totalBroadcast++;
        sinceLastMine++;
        this.onBroadcast?.(moleculeId, i, txs.length, txid);

        // Mine a block every CHUNK_SIZE TXs to stay within ancestor limits
        if (sinceLastMine >= CHUNK_SIZE) {
          regtest.mine(1);
          this.stats.blocksCreated++;
          this.stats.totalMined += sinceLastMine;
          sinceLastMine = 0;
        }
      } catch (err: any) {
        this.stats.errors++;
        this.onError?.(moleculeId, i, err.message);
        // On error, mine what we have and try to continue
        if (sinceLastMine > 0) {
          try {
            regtest.mine(1);
            this.stats.blocksCreated++;
            this.stats.totalMined += sinceLastMine;
            sinceLastMine = 0;
          } catch {}
        }
      }
    }

    // Mine remaining TXs from this chain
    if (sinceLastMine > 0) {
      try {
        regtest.mine(1);
        this.stats.blocksCreated++;
        this.stats.totalMined += sinceLastMine;
      } catch {}
    }
  }

  /** Flush: broadcast everything in the queue and return when done */
  async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const chain = this.queue.shift()!;
      this.stats.queueDepth = this.queue.length;
      await this.broadcastChain(chain);
    }
  }
}
