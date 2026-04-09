import { EventEmitter } from 'events';
import { Wallet } from './wallet.js';
import { executeChain, fundWalletP2PK, bulkFundWalletP2PK, getCompiledAsm, type ChainResult, type ChainEvent, type FundingUtxo } from './chainBuilder.js';
import * as regtest from './regtest.js';
import type { Molecule, ReceptorSite } from './types.js';

export interface RunStats {
  totalMolecules: number;
  completedMolecules: number;
  failedMolecules: number;
  totalTxsBroadcast: number;
  totalChainSteps: number;
  startTime: number;
  elapsedMs: number;
  txsPerSecond: number;
  currentMolecule: string;
  currentStep: number;
  currentTotalSteps: number;
  blockHeight: number;
  results: ChainResult[];
}

export class Orchestrator extends EventEmitter {
  private stats: RunStats;
  private running = false;
  private aborted = false;

  constructor() {
    super();
    this.stats = this.initStats();
  }

  private initStats(): RunStats {
    return {
      totalMolecules: 0,
      completedMolecules: 0,
      failedMolecules: 0,
      totalTxsBroadcast: 0,
      totalChainSteps: 0,
      startTime: 0,
      elapsedMs: 0,
      txsPerSecond: 0,
      currentMolecule: '',
      currentStep: 0,
      currentTotalSteps: 0,
      blockHeight: 0,
      results: [],
    };
  }

  getStats(): RunStats {
    if (this.stats.startTime > 0) {
      this.stats.elapsedMs = performance.now() - this.stats.startTime;
      this.stats.txsPerSecond = this.stats.elapsedMs > 0
        ? (this.stats.totalTxsBroadcast / (this.stats.elapsedMs / 1000))
        : 0;
    }
    return { ...this.stats };
  }

  abort() {
    this.aborted = true;
  }

  async run(
    molecules: Molecule[],
    receptor: ReceptorSite,
    opts: { fundingAmountBsv?: number; wif?: string; fast?: boolean; mineEvery?: number } = {},
  ): Promise<RunStats> {
    this.running = true;
    this.aborted = false;
    this.stats = this.initStats();
    this.stats.totalMolecules = molecules.length;
    this.stats.startTime = performance.now();

    const numAtoms = molecules[0]?.atoms.length ?? 3;
    const numSteps = receptor.atoms.length;

    // Compile chain script once
    this.emit('status', 'Compiling chain script...');
    const compiledAsm = getCompiledAsm(numAtoms);
    this.emit('status', `Compiled (${numAtoms} atoms, ${compiledAsm.length} chars ASM)`);

    // Create wallet
    const wallet = new Wallet(opts.wif, 'regtest');
    this.emit('status', `Wallet: ${wallet.address}`);

    // Get initial block height
    this.stats.blockHeight = regtest.getBlockCount();
    const fast = opts.fast ?? false;
    const mineEvery = opts.mineEvery ?? 10; // mine a block every N molecules in fast mode
    let txsSinceLastMine = 0;

    // Pre-fund all molecules in fast mode
    let fundingUtxos: FundingUtxo[] = [];
    if (fast && molecules.length > 1) {
      this.emit('status', `Bulk-funding ${molecules.length} UTXOs...`);
      try {
        fundingUtxos = await bulkFundWalletP2PK(wallet, molecules.length, 10000);
        this.stats.totalTxsBroadcast += 2; // sendtoaddress + fanout
        this.emit('status', `Funded ${fundingUtxos.length} UTXOs in 1 TX`);
      } catch (err: any) {
        this.emit('status', `Bulk funding failed: ${err.message}, falling back to individual`);
      }
    }

    // Process molecules sequentially
    for (let i = 0; i < molecules.length; i++) {
      if (this.aborted) break;

      const mol = molecules[i];
      this.stats.currentMolecule = mol.id;
      this.stats.currentStep = 0;
      this.stats.currentTotalSteps = numSteps;

      // Get funding UTXO
      let fundingUtxo: FundingUtxo;
      if (fundingUtxos.length > i) {
        fundingUtxo = fundingUtxos[i];
      } else {
        this.emit('status', `Funding molecule ${i + 1}/${molecules.length} (${mol.id})...`);
        try {
          fundingUtxo = await fundWalletP2PK(wallet, opts.fundingAmountBsv ?? 0.01);
          this.stats.totalTxsBroadcast += 2;
        } catch (err: any) {
          this.stats.failedMolecules++;
          this.stats.results.push({
            moleculeId: mol.id, genesisTxid: '', stepTxids: [], states: [],
            finalScore: 0, totalTxs: 0, totalBytes: 0, status: 'failed',
            error: `Funding failed: ${err.message}`, durationMs: 0,
          });
          this.emit('moleculeError', { moleculeId: mol.id, error: err.message });
          continue;
        }
      }

      // Execute chain
      const result = await executeChain(
        mol, receptor, wallet, compiledAsm, fundingUtxo,
        (event: ChainEvent) => {
          if (event.type === 'genesis') {
            this.stats.totalTxsBroadcast++;
            txsSinceLastMine++;
          } else if (event.type === 'step') {
            this.stats.totalTxsBroadcast++;
            this.stats.totalChainSteps++;
            this.stats.currentStep = event.step;
            txsSinceLastMine++;
          }
          this.emit('chainEvent', event);
          this.emit('statsUpdate', this.getStats());
        },
        fast,
      );

      // Batch mine in fast mode
      if (fast && txsSinceLastMine >= mineEvery) {
        regtest.mine(1);
        txsSinceLastMine = 0;
        this.stats.blockHeight = regtest.getBlockCount();
      }

      this.stats.results.push(result);
      if (result.status === 'completed') {
        this.stats.completedMolecules++;
      } else {
        this.stats.failedMolecules++;
      }

      this.emit('moleculeComplete', result);
      this.emit('statsUpdate', this.getStats());
    }

    // Mine remaining unconfirmed TXs
    if (fast && txsSinceLastMine > 0) {
      regtest.mine(1);
      this.stats.blockHeight = regtest.getBlockCount();
    }

    this.stats.elapsedMs = performance.now() - this.stats.startTime;
    this.running = false;
    this.emit('done', this.getStats());
    return this.getStats();
  }
}
