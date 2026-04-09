/**
 * Dispatch system: manages remote agents, distributes work packages,
 * verifies results, and funds fee UTXOs for chain broadcasting.
 */
import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet, type UTXO } from './wallet.js';
import { getCompiledAsm } from './chainBuilder.js';
import { buildChainLockScript } from './genesis.js';
import { computeBatchEnergy } from './energy.js';
import { generateMolecule, generateReceptorSite, getRealMolecules } from './generate.js';
import * as regtest from './regtest.js';
import type { Molecule, ReceptorSite } from './types.js';
import { bulkFundWalletP2PK } from './chainBuilder.js';

// --- Types ---

const REWARD_PER_WORK_SATS = 100;      // 100 sats per completed work (pass or fail)

export interface RemoteAgent {
  id: string;
  name: string;
  pubkey: string;          // agent's public key (for P2PK fee UTXOs)
  paymail: string | null;  // Handcash handle ($handle) or BSV address for rewards
  registeredAt: string;
  trustLevel: number;      // 0=new, 1=proven, 2=trusted
  totalProcessed: number;
  totalPassed: number;
  totalFailed: number;
  totalTxsBroadcast: number;
  totalBytes: number;      // cumulative chain data bytes
  totalRewardsSats: number; // cumulative sats earned
  currentWorkId: string | null;
  currentMoleculeId: string | null;
  lastSeen: string;
}

export interface DispatchEvent {
  type: 'registered' | 'assigned' | 'pass' | 'fail' | 'confirmed' | 'reward' | 'spot_check_fail';
  agentName: string;
  agentId: string;
  moleculeId?: string;
  score?: number;
  rewardSats?: number;
  timestamp: string;
}

export interface WorkPackage {
  id: string;
  agentId: string;
  molecule: Molecule;
  receptor: ReceptorSite;
  compiledAsm: string;
  genesisTxHex: string;     // serialized genesis TX
  genesisTxid: string;
  numSteps: number;         // receptor.atoms.length
  status: 'assigned' | 'processing' | 'pass' | 'fail' | 'verified' | 'expired';
  assignedAt: string;
  completedAt?: string;
  finalScore?: number;
  chainTxids?: string[];    // submitted chain txids
  batchId?: string;         // links to dashboard-initiated job
}

export interface FeePackage {
  workId: string;
  utxos: Array<{
    txid: string;
    vout: number;
    satoshis: number;
    scriptHex: string;
    sourceTxHex: string;    // full source TX hex for spending
  }>;
}

// --- Dispatch Manager ---

const WORK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min timeout for work
const SPOT_CHECK_RATE = 0.05;            // 5% of submissions get spot-checked
const FEE_RATE_SATS_PER_KB = 100;       // BSV fee rate: 100 sats/kB
const FEE_PER_STEP_SATS = 200;          // default estimate: ~1.65KB chain TX × 100 sats/kB ≈ 165, rounded up

export class DispatchManager {
  private agents = new Map<string, RemoteAgent>();
  private agentsByName = new Map<string, string>(); // name → id
  private work = new Map<string, WorkPackage>();
  private dispatchWallet: Wallet;

  // Pre-compiled ASM cache
  private asmCache = new Map<number, string>();

  // Default receptor for work generation
  private receptor: ReceptorSite;
  private molecules: Molecule[] = [];
  private moleculeQueue: Molecule[] = [];

  // External work queue (from dashboard job triggers)
  private externalQueue: Array<{
    molecule: Molecule;
    receptor: ReceptorSite;
    compiledAsm: string;
    genesisTxHex: string;
    genesisTxid: string;
    batchId: string;
  }> = [];

  // Batch tracking for dashboard-initiated jobs
  private batches = new Map<string, { total: number; completed: number; onComplete?: () => void }>();

  // Event log
  private recentEvents: DispatchEvent[] = [];
  private maxEvents = 500;

  // Timing
  startTime = 0;

  constructor(wallet: Wallet) {
    this.dispatchWallet = wallet;

    // Load real molecules or generate synthetic ones
    const real = getRealMolecules(100);
    this.receptor = real.receptor;
    this.molecules = real.molecules;
    this.moleculeQueue = [...this.molecules];

    // Pre-compile ASM for all atom counts
    const atomCounts = [...new Set(this.molecules.map(m => m.atoms.length))];
    for (const ac of atomCounts) {
      this.asmCache.set(ac, getCompiledAsm(ac));
    }
    console.log(`[dispatch] Loaded ${this.molecules.length} molecules, ${atomCounts.length} atom counts compiled`);
  }

  private pushEvent(event: Omit<DispatchEvent, 'timestamp'>): void {
    this.recentEvents.push({ ...event, timestamp: new Date().toISOString() });
    if (this.recentEvents.length > this.maxEvents) this.recentEvents.shift();
  }

  getRecentEvents(): DispatchEvent[] {
    return this.recentEvents;
  }

  // --- Agent Registration ---

  registerAgent(name: string, pubkey: string, paymail?: string | null): { agent: RemoteAgent; error?: string } {
    // Check name uniqueness
    if (this.agentsByName.has(name.toLowerCase())) {
      return { agent: null as any, error: `Name "${name}" is already taken` };
    }

    const id = Math.random().toString(36).slice(2, 10);
    const agent: RemoteAgent = {
      id,
      name,
      pubkey,
      paymail: paymail ?? null,
      registeredAt: new Date().toISOString(),
      trustLevel: 0,
      totalProcessed: 0,
      totalPassed: 0,
      totalFailed: 0,
      totalTxsBroadcast: 0,
      totalBytes: 0,
      totalRewardsSats: 0,
      currentWorkId: null,
      currentMoleculeId: null,
      lastSeen: new Date().toISOString(),
    };

    this.agents.set(id, agent);
    this.agentsByName.set(name.toLowerCase(), id);
    this.pushEvent({ type: 'registered', agentName: name, agentId: id });
    console.log(`[dispatch] Agent registered: ${name} (${id})`);
    return { agent };
  }

  getAgent(id: string): RemoteAgent | undefined {
    return this.agents.get(id);
  }

  getAllAgents(): RemoteAgent[] {
    return [...this.agents.values()];
  }

  isNameTaken(name: string): boolean {
    return this.agentsByName.has(name.toLowerCase());
  }

  // --- Work Distribution ---

  /** Enqueue pre-built work items from dashboard-initiated jobs */
  enqueueExternalWork(
    items: Array<{ molecule: Molecule; receptor: ReceptorSite; compiledAsm: string; genesisTxHex: string; genesisTxid: string }>,
    batchId: string,
    onComplete?: () => void,
  ): void {
    for (const item of items) {
      this.externalQueue.push({ ...item, batchId });
    }
    this.batches.set(batchId, { total: items.length, completed: 0, onComplete });
    if (this.startTime === 0) this.startTime = performance.now();
    console.log(`[dispatch] Enqueued ${items.length} external work items (batch ${batchId})`);
  }

  async createWorkPackage(agentId: string): Promise<{ work?: WorkPackage; error?: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    if (agent.currentWorkId) return { error: 'Agent already has work assigned' };

    // Try external queue first (dashboard-initiated jobs)
    if (this.externalQueue.length > 0) {
      const ext = this.externalQueue.shift()!;
      const workId = Math.random().toString(36).slice(2, 10);
      const work: WorkPackage = {
        id: workId,
        agentId,
        molecule: ext.molecule,
        receptor: ext.receptor,
        compiledAsm: ext.compiledAsm,
        genesisTxHex: ext.genesisTxHex,
        genesisTxid: ext.genesisTxid,
        numSteps: ext.receptor.atoms.length,
        status: 'assigned',
        assignedAt: new Date().toISOString(),
        batchId: ext.batchId,
      };
      this.work.set(workId, work);
      agent.currentWorkId = workId;
      agent.currentMoleculeId = ext.molecule.id;
      agent.lastSeen = new Date().toISOString();
      this.pushEvent({ type: 'assigned', agentName: agent.name, agentId, moleculeId: ext.molecule.id });
      console.log(`[dispatch] Work ${workId} assigned to ${agent.name}: ${ext.molecule.id} (batch ${ext.batchId})`);
      return { work };
    }

    // Refill default queue if empty
    if (this.moleculeQueue.length === 0) {
      this.moleculeQueue = this.molecules.map(m => ({
        ...m,
        id: `${m.id.split('-')[0]}-${Math.random().toString(36).slice(2, 6)}`,
        atoms: m.atoms.map(a => ({
          ...a,
          x: a.x + Math.floor(Math.random() * 40 - 20),
          y: a.y + Math.floor(Math.random() * 40 - 20),
          z: a.z + Math.floor(Math.random() * 40 - 20),
        })),
      }));
    }

    const molecule = this.moleculeQueue.shift()!;
    const numAtoms = molecule.atoms.length;
    let compiledAsm = this.asmCache.get(numAtoms);
    if (!compiledAsm) {
      compiledAsm = getCompiledAsm(numAtoms);
      this.asmCache.set(numAtoms, compiledAsm);
    }

    // Create genesis TX funded from dispatch wallet
    try {
      const fundingUtxos = await bulkFundWalletP2PK(this.dispatchWallet, 1, 2000);
      if (fundingUtxos.length === 0) return { error: 'No funding available' };

      const utxo = fundingUtxos[0];
      const genesisTx = new Transaction();
      genesisTx.version = 2;
      genesisTx.addInput({
        sourceTransaction: utxo.sourceTransaction,
        sourceOutputIndex: utxo.vout,
        unlockingScriptTemplate: this.dispatchWallet.p2pkUnlock(utxo.satoshis, Script.fromHex(utxo.script)),
      });
      genesisTx.addOutput({ lockingScript: buildChainLockScript(numAtoms, 0, compiledAsm), satoshis: 1 });
      genesisTx.addOutput({ lockingScript: this.dispatchWallet.p2pkLockingScript(), change: true });
      await genesisTx.fee(new SatoshisPerKilobyte(FEE_RATE_SATS_PER_KB));
      await genesisTx.sign();

      const genesisTxid = regtest.broadcastOnly(genesisTx);
      regtest.mine(1);

      const workId = Math.random().toString(36).slice(2, 10);
      const work: WorkPackage = {
        id: workId,
        agentId,
        molecule,
        receptor: this.receptor,
        compiledAsm,
        genesisTxHex: genesisTx.toHex(),
        genesisTxid,
        numSteps: this.receptor.atoms.length,
        status: 'assigned',
        assignedAt: new Date().toISOString(),
      };

      this.work.set(workId, work);
      agent.currentWorkId = workId;
      agent.currentMoleculeId = molecule.id;
      agent.lastSeen = new Date().toISOString();
      this.pushEvent({ type: 'assigned', agentName: agent.name, agentId, moleculeId: molecule.id });

      console.log(`[dispatch] Work ${workId} assigned to ${agent.name}: ${molecule.id} (${numAtoms} atoms, ${this.receptor.atoms.length} steps)`);
      return { work };
    } catch (err: any) {
      return { error: `Genesis creation failed: ${err.message}` };
    }
  }

  // --- Result Submission ---

  async submitFail(agentId: string, workId: string, finalScore: number): Promise<{ ok: boolean; error?: string; nextWork?: WorkPackage }> {
    const agent = this.agents.get(agentId);
    const work = this.work.get(workId);
    if (!agent || !work) return { ok: false, error: 'Not found' };
    if (work.agentId !== agentId) return { ok: false, error: 'Work not assigned to this agent' };

    work.status = 'fail';
    work.completedAt = new Date().toISOString();
    work.finalScore = finalScore;
    agent.totalProcessed++;
    agent.totalFailed++;
    agent.currentWorkId = null;
    agent.currentMoleculeId = null;
    agent.lastSeen = new Date().toISOString();

    // Spot-check: re-execute and verify the score
    const verified = this.spotCheckScore(work);
    if (!verified) {
      console.log(`[dispatch] SPOT CHECK FAILED for ${agent.name} on ${workId}! Score mismatch.`);
      agent.trustLevel = Math.max(0, agent.trustLevel - 1);
      this.pushEvent({ type: 'spot_check_fail', agentName: agent.name, agentId, moleculeId: work.molecule.id });
    }

    // Pay 100 sats reward for completed work
    let rewardTxid: string | null = null;
    try {
      rewardTxid = await this.payReward(agent);
    } catch (err: any) {
      console.log(`[dispatch] Reward payment failed for ${agent.name}: ${err.message}`);
    }

    this.pushEvent({ type: 'fail', agentName: agent.name, agentId, moleculeId: work.molecule.id, score: finalScore });
    this.trackBatchCompletion(work.batchId);
    console.log(`[dispatch] ${agent.name} reported FAIL for ${workId} (score=${finalScore})${rewardTxid ? ` reward=${rewardTxid}` : ''}`);

    // Auto-assign next work
    const next = await this.createWorkPackage(agentId);
    return { ok: true, nextWork: next.work };
  }

  async submitPass(
    agentId: string, workId: string, finalScore: number,
    chainTxHexes: string[],
  ): Promise<{ ok: boolean; feePackage?: FeePackage; error?: string }> {
    const agent = this.agents.get(agentId);
    const work = this.work.get(workId);
    if (!agent || !work) return { ok: false, error: 'Not found' };
    if (work.agentId !== agentId) return { ok: false, error: 'Work not assigned to this agent' };

    work.status = 'pass';
    work.completedAt = new Date().toISOString();
    work.finalScore = finalScore;
    agent.totalProcessed++;
    agent.totalPassed++;
    agent.lastSeen = new Date().toISOString();

    // Track bytes from chain TX hexes
    const chainBytes = chainTxHexes.reduce((s, h) => s + Math.floor(h.length / 2), 0);
    agent.totalBytes += chainBytes;

    // Spot-check: re-execute the energy calculation
    const verified = this.spotCheckScore(work);
    if (!verified) {
      console.log(`[dispatch] SPOT CHECK FAILED for ${agent.name} on ${workId}! Rejecting pass.`);
      agent.trustLevel = Math.max(0, agent.trustLevel - 1);
      work.status = 'fail';
      agent.currentWorkId = null;
      agent.currentMoleculeId = null;
      this.pushEvent({ type: 'spot_check_fail', agentName: agent.name, agentId, moleculeId: work.molecule.id });
      return { ok: false, error: 'Spot check failed — score mismatch' };
    }

    // Create fee UTXOs for the agent to broadcast the chain
    const numSteps = chainTxHexes.length;
    const feePerStep = this.estimateFeePerStep(chainTxHexes);

    try {
      const feeUtxos = await this.createFeeUtxos(agent.pubkey, numSteps, feePerStep);

      const feePackage: FeePackage = {
        workId,
        utxos: feeUtxos,
      };

      work.status = 'verified';
      agent.totalTxsBroadcast += numSteps + 1; // chain steps + genesis

      // Bump trust for consistent passes
      if (agent.totalPassed >= 5 && agent.trustLevel < 1) agent.trustLevel = 1;
      if (agent.totalPassed >= 20 && agent.trustLevel < 2) agent.trustLevel = 2;

      // Pay 100 sats reward for completed work
      try {
        await this.payReward(agent);
      } catch (err: any) {
        console.log(`[dispatch] Reward payment failed for ${agent.name}: ${err.message}`);
      }

      this.pushEvent({ type: 'pass', agentName: agent.name, agentId, moleculeId: work.molecule.id, score: finalScore });
      console.log(`[dispatch] ${agent.name} PASS verified for ${workId} (score=${finalScore}). ${numSteps} fee UTXOs created.`);
      return { ok: true, feePackage };
    } catch (err: any) {
      return { ok: false, error: `Fee UTXO creation failed: ${err.message}` };
    }
  }

  // Called by the agent after it broadcasts all chain TXs
  async confirmBroadcast(agentId: string, workId: string, txids: string[]): Promise<{ ok: boolean; nextWork?: WorkPackage; error?: string }> {
    const agent = this.agents.get(agentId);
    const work = this.work.get(workId);
    if (!agent || !work) return { ok: false, error: 'Not found' };

    work.chainTxids = txids;
    agent.currentWorkId = null;
    agent.currentMoleculeId = null;

    this.pushEvent({ type: 'confirmed', agentName: agent.name, agentId, moleculeId: work.molecule.id });
    this.trackBatchCompletion(work.batchId);
    console.log(`[dispatch] ${agent.name} confirmed broadcast of ${txids.length} TXs for ${workId}`);

    // Auto-assign next work
    const next = await this.createWorkPackage(agentId);
    return { ok: true, nextWork: next.work };
  }

  // --- Fee UTXO Creation ---

  private estimateFeePerStep(chainTxHexes: string[]): number {
    if (chainTxHexes.length === 0) return FEE_PER_STEP_SATS;
    // Estimate from actual TX sizes — add ~150 bytes for the fee input (txid+vout+sig+sequence)
    const avgBytes = chainTxHexes.reduce((s, h) => s + h.length / 2, 0) / chainTxHexes.length;
    const withFeeInput = avgBytes + 150; // extra input overhead
    // 100 sats/kB = 0.1 sats/byte, round up with margin
    return Math.ceil((withFeeInput * FEE_RATE_SATS_PER_KB) / 1000) + 1;
  }

  private async createFeeUtxos(
    agentPubkey: string, count: number, satsEach: number,
  ): Promise<FeePackage['utxos']> {
    // Create a single TX with `count` outputs, each paying to the agent's pubkey
    const totalNeeded = count * satsEach + 500; // extra for fees
    const fundingAmount = parseFloat((totalNeeded / 1e8 + 0.001).toFixed(8));

    const fundingUtxos = await bulkFundWalletP2PK(this.dispatchWallet, 1, totalNeeded + 1000);
    if (fundingUtxos.length === 0) throw new Error('No funding for fee UTXOs');

    const feeTx = new Transaction();
    feeTx.version = 2;
    feeTx.addInput({
      sourceTransaction: fundingUtxos[0].sourceTransaction,
      sourceOutputIndex: fundingUtxos[0].vout,
      unlockingScriptTemplate: this.dispatchWallet.p2pkUnlock(
        fundingUtxos[0].satoshis, Script.fromHex(fundingUtxos[0].script),
      ),
    });

    // Agent's P2PK locking script
    const agentPubkeyBytes = Buffer.from(agentPubkey, 'hex');
    const agentLockScript = new Script([
      { op: agentPubkeyBytes.length, data: [...agentPubkeyBytes] },
      { op: 0xac }, // OP_CHECKSIG
    ]).toHex();
    const agentLock = Script.fromHex(agentLockScript);

    for (let i = 0; i < count; i++) {
      feeTx.addOutput({ lockingScript: agentLock, satoshis: satsEach });
    }
    // Change back to dispatch
    feeTx.addOutput({ lockingScript: this.dispatchWallet.p2pkLockingScript(), change: true });
    await feeTx.fee(new SatoshisPerKilobyte(FEE_RATE_SATS_PER_KB));
    await feeTx.sign();

    const feeTxid = regtest.broadcastOnly(feeTx);
    regtest.mine(1);

    const result: FeePackage['utxos'] = [];
    for (let i = 0; i < count; i++) {
      result.push({
        txid: feeTxid,
        vout: i,
        satoshis: satsEach,
        scriptHex: agentLockScript,
        sourceTxHex: feeTx.toHex(),
      });
    }

    return result;
  }

  // --- Reward Payment ---
  // Send REWARD_PER_WORK_SATS to the agent's P2PK pubkey for each completed work
  private async payReward(agent: RemoteAgent): Promise<string> {
    const agentPubkeyBytes = Buffer.from(agent.pubkey, 'hex');
    const agentLockScript = new Script([
      { op: agentPubkeyBytes.length, data: [...agentPubkeyBytes] },
      { op: 0xac }, // OP_CHECKSIG
    ]);

    const fundingUtxos = await bulkFundWalletP2PK(this.dispatchWallet, 1, REWARD_PER_WORK_SATS + 500);
    if (fundingUtxos.length === 0) throw new Error('No funding for reward');

    const rewardTx = new Transaction();
    rewardTx.version = 2;
    rewardTx.addInput({
      sourceTransaction: fundingUtxos[0].sourceTransaction,
      sourceOutputIndex: fundingUtxos[0].vout,
      unlockingScriptTemplate: this.dispatchWallet.p2pkUnlock(
        fundingUtxos[0].satoshis, Script.fromHex(fundingUtxos[0].script),
      ),
    });
    rewardTx.addOutput({ lockingScript: agentLockScript, satoshis: REWARD_PER_WORK_SATS });
    rewardTx.addOutput({ lockingScript: this.dispatchWallet.p2pkLockingScript(), change: true });
    await rewardTx.fee(new SatoshisPerKilobyte(FEE_RATE_SATS_PER_KB));
    await rewardTx.sign();

    const txid = regtest.broadcastOnly(rewardTx);
    regtest.mine(1);
    agent.totalRewardsSats += REWARD_PER_WORK_SATS;
    console.log(`[dispatch] Paid ${REWARD_PER_WORK_SATS} sats to ${agent.name} (total: ${agent.totalRewardsSats} sats) txid=${txid}`);
    return txid;
  }

  // --- Spot-check Verification ---

  private spotCheckScore(work: WorkPackage): boolean {
    // Always check new agents, random sample for trusted ones
    const agent = this.agents.get(work.agentId);
    if (!agent) return false;

    const shouldCheck = agent.trustLevel === 0 || Math.random() < SPOT_CHECK_RATE;
    if (!shouldCheck) return true; // skip check for trusted agents (probabilistic)

    // Re-execute energy calculation
    let expectedScore = 0;
    for (const rAtom of work.receptor.atoms) {
      expectedScore += computeBatchEnergy(work.molecule.atoms, rAtom).batchTotal;
    }

    const reportedScore = work.finalScore ?? 0;
    const tolerance = Math.abs(expectedScore) * 0.01 + 10; // 1% + 10 absolute tolerance
    const match = Math.abs(reportedScore - expectedScore) <= tolerance;

    if (!match) {
      console.log(`[dispatch] Score mismatch: expected=${expectedScore} reported=${reportedScore} (tolerance=${tolerance.toFixed(0)})`);
    }

    return match;
  }

  // --- Batch tracking ---

  private trackBatchCompletion(batchId?: string): void {
    if (!batchId) return;
    const batch = this.batches.get(batchId);
    if (!batch) return;
    batch.completed++;
    if (batch.completed >= batch.total && batch.onComplete) {
      batch.onComplete();
    }
  }

  getBatchProgress(batchId: string): { total: number; completed: number } | null {
    return this.batches.get(batchId) ?? null;
  }

  // --- Stats ---

  getStats() {
    const agents = [...this.agents.values()];
    const workItems = [...this.work.values()];
    return {
      totalAgents: agents.length,
      activeAgents: agents.filter(a => a.currentWorkId).length,
      totalWorkCreated: workItems.length,
      totalPassed: workItems.filter(w => w.status === 'pass' || w.status === 'verified').length,
      totalFailed: workItems.filter(w => w.status === 'fail').length,
      totalTxsBroadcast: agents.reduce((s, a) => s + a.totalTxsBroadcast, 0),
      moleculesRemaining: this.moleculeQueue.length,
    };
  }

  /** Unified stats for the dashboard — replaces the old local-worker stats */
  getUnifiedStats() {
    const agents = [...this.agents.values()];
    const workItems = [...this.work.values()];
    const totalProcessed = agents.reduce((s, a) => s + a.totalProcessed, 0);
    const totalPassed = agents.reduce((s, a) => s + a.totalPassed, 0);
    const totalFailed = agents.reduce((s, a) => s + a.totalFailed, 0);
    const totalTxs = agents.reduce((s, a) => s + a.totalTxsBroadcast, 0);
    const totalBytes = agents.reduce((s, a) => s + a.totalBytes, 0);
    const totalRewards = agents.reduce((s, a) => s + a.totalRewardsSats, 0);
    const elapsed = this.startTime > 0 ? performance.now() - this.startTime : 0;

    return {
      totalAgents: agents.length,
      activeAgents: agents.filter(a => a.currentWorkId).length,
      processed: totalProcessed,
      passed: totalPassed,
      failed: totalFailed,
      totalTxs,
      totalBytes,
      totalRewards,
      elapsedMs: elapsed,
      txsPerSecond: elapsed > 0 ? totalTxs / (elapsed / 1000) : 0,
      queueDepth: this.externalQueue.length + this.moleculeQueue.length,
      workCreated: workItems.length,
    };
  }

  /** Agent data formatted for dashboard display */
  getAgentsForDashboard(): Array<{
    id: string; name: string; status: string; trustLevel: number;
    processed: number; passed: number; failed: number;
    totalTxs: number; totalBytes: number; totalRewards: number;
    currentMoleculeId: string | null; paymail: string | null;
    registeredAt: string;
  }> {
    const now = Date.now();
    const OFFLINE_MS = 5 * 60 * 1000; // 5 min
    return [...this.agents.values()].map(a => {
      let status: string;
      if (a.currentWorkId) {
        status = 'working';
      } else if (now - new Date(a.lastSeen).getTime() < OFFLINE_MS) {
        status = 'idle';
      } else {
        status = 'offline';
      }
      return {
        id: a.id,
        name: a.name,
        status,
        trustLevel: a.trustLevel,
        processed: a.totalProcessed,
        passed: a.totalPassed,
        failed: a.totalFailed,
        totalTxs: a.totalTxsBroadcast,
        totalBytes: a.totalBytes,
        totalRewards: a.totalRewardsSats,
        currentMoleculeId: a.currentMoleculeId,
        paymail: a.paymail,
        registeredAt: a.registeredAt,
      };
    });
  }

  /** Get completed work items with scores for the leaderboard */
  getResults(): Array<{
    moleculeId: string; agentName: string; passed: boolean;
    finalScore: number; totalTxs: number; totalBytes: number;
  }> {
    const results: Array<{
      moleculeId: string; agentName: string; passed: boolean;
      finalScore: number; totalTxs: number; totalBytes: number;
    }> = [];
    for (const w of this.work.values()) {
      if (w.status === 'pass' || w.status === 'verified' || w.status === 'fail') {
        const agent = this.agents.get(w.agentId);
        results.push({
          moleculeId: w.molecule.id,
          agentName: agent?.name ?? 'unknown',
          passed: w.status === 'pass' || w.status === 'verified',
          finalScore: w.finalScore ?? 0,
          totalTxs: w.numSteps + 1,
          totalBytes: 0, // individual bytes not tracked per work item
        });
      }
    }
    return results;
  }
}
