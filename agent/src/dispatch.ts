/**
 * Dispatch system: manages remote agents, distributes work packages,
 * verifies results, and funds fee UTXOs for chain broadcasting.
 */
import { Transaction, Script, SatoshisPerKilobyte, P2PKH } from '@bsv/sdk';
import { Wallet, type UTXO } from './wallet.js';
import { getCompiledAsm } from './chainBuilder.js';
import { buildChainLockScript } from './genesis.js';
import { computeBatchEnergy } from './energy.js';
import { generateMolecule, generateReceptorSite, getRealMolecules } from './generate.js';
import { getNetwork, type NetworkAdapter } from './network.js';
import type { Molecule, ReceptorSite } from './types.js';
import { bulkFundWalletP2PK } from './chainBuilder.js';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = resolve(__dirname, '../../.moldock-state.json');

interface PersistedResult {
  moleculeId: string;      // full ID including pose suffix
  baseMoleculeId: string;  // base drug name (without random pose suffix)
  agentName: string;
  passed: boolean;
  finalScore: number;
  totalTxs: number;
  receptorName: string;
  chainSteps: number;
}

/** Max results to persist — keeps only the best score per base molecule */
const MAX_PERSISTED_RESULTS = 200;

interface PersistedState {
  cumulativeTxs: number;
  cumulativeRewardsSats: number;
  cumulativeProcessed: number;
  cumulativePassed: number;
  cumulativeFailed: number;
  /** Best result per base molecule (capped at MAX_PERSISTED_RESULTS) */
  results?: PersistedResult[];
  /** "baseMoleculeId::receptorId" keys already tested — for dedup */
  testedKeys?: string[];
  /** Outpoints spent in previous sessions ("txid:vout") — prevents reloading from WoC */
  spentOutpoints?: string[];
}

const EMPTY_STATE: PersistedState = {
  cumulativeTxs: 0, cumulativeRewardsSats: 0,
  cumulativeProcessed: 0, cumulativePassed: 0, cumulativeFailed: 0,
  results: [], testedKeys: [], spentOutpoints: [],
};

function loadState(): PersistedState {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return { ...EMPTY_STATE, ...raw };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function saveState(state: PersistedState): void {
  try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch { /* ignore */ }
}

/** Extract the base molecule name (strip the random pose suffix like "-a3xf") */
function baseMolId(moleculeId: string): string {
  return moleculeId.replace(/-[a-z0-9]{4}$/, '');
}

/** Deduplicate results: keep only the best (lowest) score per base molecule, cap at N */
function deduplicateResults(results: PersistedResult[]): PersistedResult[] {
  const best = new Map<string, PersistedResult>();
  for (const r of results) {
    const key = r.baseMoleculeId || baseMolId(r.moleculeId);
    const existing = best.get(key);
    // Lower score = better docking. Prefer passes over fails.
    if (!existing ||
        (r.passed && !existing.passed) ||
        (r.passed === existing.passed && r.finalScore < existing.finalScore)) {
      best.set(key, { ...r, baseMoleculeId: key });
    }
  }
  // Sort by score ascending (best first), cap at MAX
  return [...best.values()]
    .sort((a, b) => a.finalScore - b.finalScore)
    .slice(0, MAX_PERSISTED_RESULTS);
}

// --- Types ---

const REWARD_BASE_SATS = 100;           // base reward (paid for both pass and fail)
const REWARD_PER_CHAIN_TX_SATS = 10;   // additional per chain TX for passes

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
  chainTxHexes?: string[];  // full chain hex (genesis + steps) submitted by browser for rebroadcast insurance
  broadcastAt?: number;     // performance.now() when agent reported broadcast
  rebroadcastCount?: number;// how many times dispatch has re-broadcast this chain
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
  private network: NetworkAdapter;

  // Pre-compiled ASM cache
  private asmCache = new Map<number, string>();

  // Receptor sites (multi-target support)
  private receptors: Map<string, ReceptorSite>;
  private receptor: ReceptorSite; // first/default receptor for backward compat
  private molecules: Array<Molecule & { receptorId?: string }> = [];
  private moleculeQueue: Array<Molecule & { receptorId?: string }> = [];

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

  // Event log — sessionEvents tracks new events this session; full log = persisted + session
  private sessionEvents: DispatchEvent[] = [];
  private maxEvents = 500;

  // Dedup: "baseMoleculeId::receptorId" keys already tested (persisted + session)
  private testedKeys = new Set<string>();
  private sessionTestedKeys: string[] = [];

  // Timing & limits
  startTime = 0;
  readonly MAX_RUN_MS = 24 * 60 * 60 * 1000; // 24 hours
  readonly TX_TARGET = 1_500_000;

  // Balance cache (avoid WoC rate-limiting from 500ms dashboard polls)
  private _balanceCacheOnChain = 0;
  private _balanceCacheTime = 0;

  // Track spent outpoints this session (persisted so WoC reloads don't inflate balance)
  private spentOutpoints = new Set<string>();
  private sessionSpentOutpoints: string[] = [];

  // Persisted cumulative state (survives restarts)
  private persistedState: PersistedState;

  constructor(wallet: Wallet) {
    this.dispatchWallet = wallet;
    this.network = getNetwork();
    this.persistedState = loadState();
    if (this.persistedState.cumulativeTxs > 0) {
      console.log(`[dispatch] Restored state: ${this.persistedState.cumulativeTxs} cumulative TXs, ${this.persistedState.cumulativeProcessed} processed, ${(this.persistedState.results ?? []).length} results`);
    }

    // Restore dedup keys from persisted state
    for (const key of this.persistedState.testedKeys ?? []) {
      this.testedKeys.add(key);
    }

    // Restore spent outpoints — prevents reloading already-spent UTXOs from WoC
    for (const op of this.persistedState.spentOutpoints ?? []) {
      this.spentOutpoints.add(op);
    }

    // Track future spends via wallet callback
    wallet.onSpend = (txid, vout) => {
      const key = `${txid}:${vout}`;
      this.spentOutpoints.add(key);
      this.sessionSpentOutpoints.push(key);
    };

    // Load real molecules or generate synthetic ones
    const real = getRealMolecules(100);
    this.receptors = real.receptors;
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

  /** Scan on-chain for all dispatch wallet TXs and reconcile balance + TX count */
  async scanOnChainState(): Promise<void> {
    if (this.network.getNetwork() === 'regtest') return;

    try {
      // 1. Get on-chain P2PKH balance (incoming funds not yet spent by the wallet)
      const p2pkhBalance = await this.network.getBalance(this.dispatchWallet.address);
      this._balanceCacheOnChain = p2pkhBalance;
      this._balanceCacheTime = Date.now();

      // 1b. Load P2PKH UTXOs into wallet (with full source TXs for spending)
      const wocBase = this.network.getNetwork() === 'mainnet'
        ? 'https://api.whatsonchain.com/v1/bsv/main'
        : 'https://api.whatsonchain.com/v1/bsv/test';
      if (p2pkhBalance > 0) {
        const p2pkhUtxos = await this.network.fetchUtxos(this.dispatchWallet.address);
        let p2pkhLoaded = 0;
        for (const u of p2pkhUtxos) {
          if (this.spentOutpoints.has(`${u.txid}:${u.vout}`)) continue; // already spent
          try {
            const resp = await fetch(`${wocBase}/tx/${u.txid}/hex`);
            if (!resp.ok) continue;
            const txHex = await resp.text();
            const sourceTx = Transaction.fromHex(txHex);
            const actualScript = sourceTx.outputs[u.vout].lockingScript!.toHex();
            this.dispatchWallet.addUtxo({
              txid: u.txid, vout: u.vout, satoshis: u.satoshis,
              script: actualScript, sourceTransaction: sourceTx,
            });
            p2pkhLoaded++;
          } catch { /* skip */ }
        }
        console.log(`[dispatch] Loaded ${p2pkhLoaded}/${p2pkhUtxos.length} P2PKH UTXOs (${this.spentOutpoints.size} known spent)`);
      }

      // 2. Count on-chain TXs from address history
      const addrHistory = await this.network.getAddressHistory?.(this.dispatchWallet.address) ?? [];
      console.log(`[dispatch] On-chain: ${addrHistory.length} P2PKH TXs, ${p2pkhBalance} sats available`);

      // 3. Check P2PK script for mined TXs (may be empty if TXs are still in mempool)
      const p2pkScript = this.dispatchWallet.p2pkLockingScript().toHex();
      const scriptHistory = await this.network.getScriptHistory?.(p2pkScript) ?? [];
      if (scriptHistory.length > 0) {
        console.log(`[dispatch] On-chain: ${scriptHistory.length} P2PK TXs found`);
      }

      // 4. Merge unique on-chain txids
      const allTxids = new Set<string>();
      for (const tx of addrHistory) allTxids.add(tx.tx_hash);
      for (const tx of scriptHistory) allTxids.add(tx.tx_hash);
      const onChainTxCount = allTxids.size;

      // 5. Use the higher of on-chain count or persisted count
      // (persisted count includes mempool TXs from previous sessions)
      if (onChainTxCount > this.persistedState.cumulativeTxs) {
        console.log(`[dispatch] Updating TX count from ${this.persistedState.cumulativeTxs} → ${onChainTxCount} (on-chain higher)`);
        this.persistedState.cumulativeTxs = onChainTxCount;
        saveState(this.persistedState);
      } else {
        console.log(`[dispatch] Persisted TX count (${this.persistedState.cumulativeTxs}) ≥ on-chain (${onChainTxCount}) — keeping persisted`);
      }

      // 6. Load P2PK unspent UTXOs into wallet if any are mined
      // Filter out UTXOs that were spent in previous sessions (mempool spends invisible to WoC)
      const p2pkUtxos = await this.network.fetchScriptUtxos?.(p2pkScript) ?? [];
      if (p2pkUtxos.length > 0) {
        let loaded = 0;
        let skipped = 0;
        let p2pkBal = 0;
        for (const u of p2pkUtxos) {
          if (this.spentOutpoints.has(`${u.txid}:${u.vout}`)) { skipped++; continue; }
          try {
            const resp = await fetch(`${wocBase}/tx/${u.txid}/hex`);
            if (!resp.ok) continue;
            const txHex = await resp.text();
            const sourceTx = Transaction.fromHex(txHex);
            this.dispatchWallet.addUtxo({
              txid: u.txid,
              vout: u.vout,
              satoshis: u.satoshis,
              script: p2pkScript,
              sourceTransaction: sourceTx,
            });
            p2pkBal += u.satoshis;
            loaded++;
          } catch { /* skip this UTXO */ }
        }
        if (loaded > 0 || skipped > 0) {
          console.log(`[dispatch] P2PK UTXOs: loaded ${loaded} (${p2pkBal} sats), skipped ${skipped} known-spent`);
        }
      }

      const internalBal = this.dispatchWallet.balance;
      console.log(`[dispatch] Wallet: ${internalBal > 0 ? internalBal : p2pkhBalance} sats spendable`);
    } catch (err: any) {
      console.log(`[dispatch] On-chain scan failed (continuing with persisted state): ${err.message}`);
    }
  }

  private pushEvent(event: Omit<DispatchEvent, 'timestamp'>): void {
    const full = { ...event, timestamp: new Date().toISOString() };
    this.sessionEvents.push(full);
    if (this.sessionEvents.length > this.maxEvents) this.sessionEvents.shift();
  }

  getRecentEvents(): DispatchEvent[] {
    return this.sessionEvents;
  }

  /** Mark a molecule+receptor as tested (for dedup across sessions) */
  private markTested(work: WorkPackage): void {
    const key = `${baseMolId(work.molecule.id)}::${work.receptor.id || work.receptor.name}`;
    this.testedKeys.add(key);
    this.sessionTestedKeys.push(key);
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

    // Refill default queue if empty — prioritize untested molecule+receptor combos
    if (this.moleculeQueue.length === 0) {
      // First: find molecules that haven't been tested against their receptor yet
      const untested = this.molecules.filter(m => {
        const receptor = (m.receptorId && this.receptors.get(m.receptorId)) || this.receptor;
        const key = `${baseMolId(m.id)}::${receptor.id || receptor.name}`;
        return !this.testedKeys.has(key);
      });

      if (untested.length > 0) {
        this.moleculeQueue = untested;
        console.log(`[dispatch] Queue refilled: ${untested.length} untested molecules (${this.testedKeys.size} already tested)`);
      } else {
        // All molecules tested at least once — generate new poses (perturbed coordinates)
        this.moleculeQueue = this.molecules.map(m => ({
          ...m,
          id: `${baseMolId(m.id)}-${Math.random().toString(36).slice(2, 6)}`,
          atoms: m.atoms.map(a => ({
            ...a,
            x: a.x + Math.floor(Math.random() * 40 - 20),
            y: a.y + Math.floor(Math.random() * 40 - 20),
            z: a.z + Math.floor(Math.random() * 40 - 20),
          })),
        }));
        console.log(`[dispatch] All ${this.molecules.length} molecules tested — generating new poses`);
      }
    }

    const molecule = this.moleculeQueue.shift()!;
    const numAtoms = molecule.atoms.length;
    let compiledAsm = this.asmCache.get(numAtoms);
    if (!compiledAsm) {
      compiledAsm = getCompiledAsm(numAtoms);
      this.asmCache.set(numAtoms, compiledAsm);
    }

    // Look up the receptor for this molecule (fall back to default)
    const molReceptor = (molecule.receptorId && this.receptors.get(molecule.receptorId)) || this.receptor;

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

      const genesisTxid = await this.network.broadcast(genesisTx);
      await this.network.mine(1);

      const workId = Math.random().toString(36).slice(2, 10);
      const work: WorkPackage = {
        id: workId,
        agentId,
        molecule,
        receptor: molReceptor,
        compiledAsm,
        genesisTxHex: genesisTx.toHex(),
        genesisTxid,
        numSteps: molReceptor.atoms.length,
        status: 'assigned',
        assignedAt: new Date().toISOString(),
      };

      this.work.set(workId, work);
      agent.currentWorkId = workId;
      agent.currentMoleculeId = molecule.id;
      agent.lastSeen = new Date().toISOString();
      this.pushEvent({ type: 'assigned', agentName: agent.name, agentId, moleculeId: molecule.id });

      console.log(`[dispatch] Work ${workId} assigned to ${agent.name}: ${molecule.id} (${numAtoms} atoms, ${molReceptor.atoms.length} steps, receptor=${molReceptor.id})`);
      return { work };
    } catch (err: any) {
      return { error: `Genesis creation failed: ${err.message}` };
    }
  }

  // --- Result Submission ---

  async submitFail(agentId: string, workId: string, finalScore: number): Promise<{ ok: boolean; reward?: number; error?: string; nextWork?: WorkPackage }> {
    const agent = this.agents.get(agentId);
    const work = this.work.get(workId);
    if (!agent || !work) return { ok: false, error: 'Not found' };
    if (work.agentId !== agentId) return { ok: false, error: 'Work not assigned to this agent' };

    work.status = 'fail';
    work.completedAt = new Date().toISOString();
    work.finalScore = finalScore;
    agent.totalProcessed++;
    agent.totalFailed++;
    agent.totalTxsBroadcast += 1; // genesis TX was broadcast when work was created
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

    // Pay base reward for completed work (fail = base only)
    let rewardTxid: string | null = null;
    try {
      rewardTxid = await this.payReward(agent, REWARD_BASE_SATS);
    } catch (err: any) {
      console.log(`[dispatch] Reward payment failed for ${agent.name}: ${err.message}`);
    }

    this.markTested(work);
    this.pushEvent({ type: 'fail', agentName: agent.name, agentId, moleculeId: work.molecule.id, score: finalScore });
    this.trackBatchCompletion(work.batchId);
    this.persistState();
    console.log(`[dispatch] ${agent.name} reported FAIL for ${workId} (score=${finalScore})${rewardTxid ? ` reward=${rewardTxid}` : ''}`);

    // Auto-assign next work
    const next = await this.createWorkPackage(agentId);
    return { ok: true, reward: REWARD_BASE_SATS, nextWork: next.work };
  }

  async submitPass(
    agentId: string, workId: string, finalScore: number,
    chainTxHexes: string[],
    alreadyBroadcast: boolean = false,
  ): Promise<{ ok: boolean; reward?: number; feePackage?: FeePackage; error?: string }> {
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

    // Browser-agent fast path: agent already broadcast chain directly.
    // Skip fee UTXO creation entirely (browser uses 1-sat simple chain on regtest
    // or pays its own fees on testnet/mainnet via ARC).
    if (alreadyBroadcast) {
      // Store full chain hex so dispatch can re-broadcast later if TXs are lost.
      work.chainTxHexes = chainTxHexes;
      work.broadcastAt = performance.now();
      work.rebroadcastCount = 0;
      work.status = 'verified';
      // chainTxHexes includes genesis, so total TXs = chainTxHexes.length
      // chain steps (excluding genesis) = chainTxHexes.length - 1
      agent.totalTxsBroadcast += chainTxHexes.length;
      if (agent.totalPassed >= 5 && agent.trustLevel < 1) agent.trustLevel = 1;
      if (agent.totalPassed >= 20 && agent.trustLevel < 2) agent.trustLevel = 2;
      // Pass reward: base + per-chain-step bonus (genesis is not a step)
      const chainSteps = chainTxHexes.length - 1;
      const passReward = REWARD_BASE_SATS + (REWARD_PER_CHAIN_TX_SATS * chainSteps);
      try { await this.payReward(agent, passReward); } catch (err: any) {
        console.log(`[dispatch] Reward payment failed for ${agent.name}: ${err.message}`);
      }
      this.markTested(work);
      this.pushEvent({ type: 'pass', agentName: agent.name, agentId, moleculeId: work.molecule.id, score: finalScore, rewardSats: passReward });
      this.persistState();
      console.log(`[dispatch] ${agent.name} PASS verified for ${workId} (score=${finalScore}) reward=${passReward} sats [browser-broadcast]`);
      return { ok: true, reward: passReward };
    }

    // Create fee UTXOs for the agent to broadcast the chain
    // chainTxHexes includes genesis at index 0 — fee UTXOs only needed for chain steps
    const chainSteps = chainTxHexes.length - 1;
    const feePerStep = this.estimateFeePerStep(chainTxHexes);

    try {
      const feeUtxos = await this.createFeeUtxos(agent.pubkey, chainSteps, feePerStep);

      const feePackage: FeePackage = {
        workId,
        utxos: feeUtxos,
      };

      work.status = 'verified';
      agent.totalTxsBroadcast += chainTxHexes.length; // genesis + chain steps

      // Bump trust for consistent passes
      if (agent.totalPassed >= 5 && agent.trustLevel < 1) agent.trustLevel = 1;
      if (agent.totalPassed >= 20 && agent.trustLevel < 2) agent.trustLevel = 2;

      // Pass reward: base + per-chain-step bonus (genesis is not a step)
      const passReward = REWARD_BASE_SATS + (REWARD_PER_CHAIN_TX_SATS * chainSteps);
      try {
        await this.payReward(agent, passReward);
      } catch (err: any) {
        console.log(`[dispatch] Reward payment failed for ${agent.name}: ${err.message}`);
      }

      this.markTested(work);
      this.pushEvent({ type: 'pass', agentName: agent.name, agentId, moleculeId: work.molecule.id, score: finalScore, rewardSats: passReward });
      this.persistState();
      console.log(`[dispatch] ${agent.name} PASS verified for ${workId} (score=${finalScore}) reward=${passReward} sats. ${chainSteps} fee UTXOs created.`);
      return { ok: true, reward: passReward, feePackage };
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

    // Agent fee UTXOs as P2PK
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

    const feeTxid = await this.network.broadcast(feeTx);
    await this.network.mine(1);

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

  // Check if a string looks like a BSV address (1... or base58, 25-34 chars)
  private isBsvAddress(str: string): boolean {
    return /^[1mn][a-km-zA-HJ-NP-Z1-9]{24,33}$/.test(str);
  }

  // --- Reward Payment ---
  // Pay to: BSV address (P2PKH), or fallback to agent's registered pubkey (P2PK)
  // rewardSats: pass = REWARD_BASE_SATS + (REWARD_PER_CHAIN_TX_SATS × chainSteps), fail = REWARD_BASE_SATS
  private async payReward(agent: RemoteAgent, rewardSats: number = REWARD_BASE_SATS): Promise<string> {
    let agentLockScript: Script;
    const destination = agent.paymail; // now always a plain BSV address (or empty)

    if (!destination || !this.isBsvAddress(destination)) {
      // No valid BSV address — skip payout, just log it
      console.log(`[dispatch] No payout address for ${agent.name} — skipping ${rewardSats} sats reward`);
      agent.totalRewardsSats += rewardSats; // still track as earned
      this.pushEvent({ type: 'reward', agentName: agent.name, agentId: agent.id, rewardSats });
      return 'no-address';
    }

    // BSV address — pay to P2PKH
    agentLockScript = new P2PKH().lock(destination);
    console.log(`[dispatch] Paying ${agent.name} ${rewardSats} sats → ${destination}`);

    const fundingUtxos = await bulkFundWalletP2PK(this.dispatchWallet, 1, rewardSats + 500);
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
    rewardTx.addOutput({ lockingScript: agentLockScript, satoshis: rewardSats });
    rewardTx.addOutput({ lockingScript: this.dispatchWallet.p2pkLockingScript(), change: true });
    await rewardTx.fee(new SatoshisPerKilobyte(FEE_RATE_SATS_PER_KB));
    await rewardTx.sign();

    const txid = await this.network.broadcast(rewardTx);
    await this.network.mine(1);
    agent.totalRewardsSats += rewardSats;
    const dest = destination || `P2PK(${agent.pubkey.slice(0, 8)}...)`;
    console.log(`[dispatch] Paid ${rewardSats} sats to ${agent.name} → ${dest} (total: ${agent.totalRewardsSats} sats) txid=${txid}`);
    this.pushEvent({ type: 'reward', agentName: agent.name, agentId: agent.id, rewardSats });
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

  // --- Chain verification / rebroadcast insurance ---
  //
  // The browser compute agents broadcast chains directly, then submit the full hex
  // back to dispatch. Dispatch periodically checks whether the head TX of each recently
  // verified chain is actually in the mempool or confirmed. If the node has no record
  // of it (dropped, rejected silently, node restart, etc.) dispatch re-broadcasts the
  // whole chain using its own broadcaster.
  async verifyAndRebroadcastRecent(opts: { ageMsMin?: number; maxPerRun?: number } = {}): Promise<{ checked: number; rebroadcast: number; dropped: number }> {
    const ageMsMin = opts.ageMsMin ?? 5_000;   // give node a few seconds to accept
    const maxPerRun = opts.maxPerRun ?? 50;
    const now = performance.now();
    let checked = 0, rebroadcast = 0, dropped = 0;

    for (const work of this.work.values()) {
      if (checked >= maxPerRun) break;
      if (work.status !== 'verified') continue;
      if (!work.chainTxHexes || work.chainTxHexes.length === 0) continue;
      if (!work.broadcastAt || (now - work.broadcastAt) < ageMsMin) continue;
      if ((work.rebroadcastCount ?? 0) >= 3) continue; // give up after 3 attempts

      // Check the HEAD of the chain — if the head is in mempool or mined, the whole chain is fine.
      const headTxid = work.chainTxids?.[work.chainTxids.length - 1];
      if (!headTxid) continue;
      checked++;

      // Re-broadcast the chain proactively (on mainnet we can't check mempool status easily)
      // Just attempt to replay — ARC/node will reject already-known TXs harmlessly
      if (this.network.getNetwork() !== 'regtest') {
        // On mainnet/testnet: re-broadcast entire chain via ARC
        work.rebroadcastCount = (work.rebroadcastCount ?? 0) + 1;
        let replayed = 0;
        for (const hex of work.chainTxHexes) {
          try {
            await this.network.broadcastHex(hex);
            replayed++;
          } catch (err: any) {
            if (/already|duplicate|known/i.test(err.message)) { replayed++; continue; }
            break;
          }
        }
        if (replayed > 0) rebroadcast++;
        else dropped++;
        work.broadcastAt = performance.now();
      } else {
        // On regtest: check mempool status via bitcoin-cli
        let regtest: typeof import('./regtest.js') | null = null;
        try { regtest = await import('./regtest.js'); } catch { continue; }
        let status;
        try { status = regtest!.getTxStatus(headTxid); } catch { continue; }
        if (status.confirmations === null) {
          work.rebroadcastCount = (work.rebroadcastCount ?? 0) + 1;
          let replayed = 0;
          for (const hex of work.chainTxHexes) {
            try {
              regtest!.sendRawTx(hex);
              replayed++;
            } catch (err: any) {
              if (/already.known|txn.already/i.test(err.message)) { replayed++; continue; }
              break;
            }
          }
          if (replayed > 0) rebroadcast++;
          else dropped++;
          work.broadcastAt = performance.now();
        } else if (status.confirmations > 0) {
          delete work.chainTxHexes;
        }
      }
    }

    return { checked, rebroadcast, dropped };
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
  /** Persist cumulative state to disk (snapshot = base + session) */
  private persistState(): void {
    const agents = [...this.agents.values()];
    const sessionTxs = agents.reduce((s, a) => s + a.totalTxsBroadcast, 0);
    const sessionProcessed = agents.reduce((s, a) => s + a.totalProcessed, 0);
    const sessionPassed = agents.reduce((s, a) => s + a.totalPassed, 0);
    const sessionFailed = agents.reduce((s, a) => s + a.totalFailed, 0);
    const sessionRewards = agents.reduce((s, a) => s + a.totalRewardsSats, 0);

    // Merge session results with persisted, deduplicate (best per base molecule), cap size
    const sessionResults = this.getSessionResults();
    const allResults = deduplicateResults([
      ...(this.persistedState.results ?? []),
      ...sessionResults,
    ]);

    // Merge tested keys (for dedup across restarts)
    const testedKeys = [...new Set([
      ...(this.persistedState.testedKeys ?? []),
      ...this.sessionTestedKeys,
    ])];

    saveState({
      cumulativeTxs: this.persistedState.cumulativeTxs + sessionTxs,
      cumulativeRewardsSats: this.persistedState.cumulativeRewardsSats + sessionRewards,
      cumulativeProcessed: this.persistedState.cumulativeProcessed + sessionProcessed,
      cumulativePassed: this.persistedState.cumulativePassed + sessionPassed,
      cumulativeFailed: this.persistedState.cumulativeFailed + sessionFailed,
      results: allResults,
      testedKeys,
      spentOutpoints: [...this.spentOutpoints],
    });
  }

  /** Get results from this session only (not previously persisted) */
  private getSessionResults(): PersistedResult[] {
    const results: PersistedResult[] = [];
    for (const w of this.work.values()) {
      if (w.status === 'pass' || w.status === 'verified' || w.status === 'fail') {
        const agent = this.agents.get(w.agentId);
        results.push({
          moleculeId: w.molecule.id,
          baseMoleculeId: baseMolId(w.molecule.id),
          agentName: agent?.name ?? 'unknown',
          passed: w.status === 'pass' || w.status === 'verified',
          finalScore: w.finalScore ?? 0,
          totalTxs: w.numSteps + 1,
          receptorName: w.receptor.name ?? '',
          chainSteps: w.numSteps,
        });
      }
    }
    return results;
  }

  async getUnifiedStats() {
    const agents = [...this.agents.values()];
    const workItems = [...this.work.values()];
    const sessionProcessed = agents.reduce((s, a) => s + a.totalProcessed, 0);
    const sessionPassed = agents.reduce((s, a) => s + a.totalPassed, 0);
    const sessionFailed = agents.reduce((s, a) => s + a.totalFailed, 0);
    const sessionTxs = agents.reduce((s, a) => s + a.totalTxsBroadcast, 0);
    const totalBytes = agents.reduce((s, a) => s + a.totalBytes, 0);
    const sessionRewards = agents.reduce((s, a) => s + a.totalRewardsSats, 0);

    // Cumulative = persisted from previous sessions + current session
    const totalProcessed = this.persistedState.cumulativeProcessed + sessionProcessed;
    const totalPassed = this.persistedState.cumulativePassed + sessionPassed;
    const totalFailed = this.persistedState.cumulativeFailed + sessionFailed;
    const totalTxs = this.persistedState.cumulativeTxs + sessionTxs;
    const totalRewards = this.persistedState.cumulativeRewardsSats + sessionRewards;

    const elapsed = this.startTime > 0 ? performance.now() - this.startTime : 0;

    const txsPerSecond = elapsed > 0 ? sessionTxs / (elapsed / 1000) : 0;
    const avgTxsPerMol = totalProcessed > 0 ? Math.round(totalTxs / totalProcessed) : 21;

    // Time remaining estimate based on current rate
    const txsRemaining = Math.max(0, this.TX_TARGET - totalTxs);
    const etaMs = txsPerSecond > 0 ? (txsRemaining / txsPerSecond) * 1000 : 0;
    const timeRemainingMs = Math.max(0, this.MAX_RUN_MS - elapsed);

    // Wallet balance — use internal UTXO set as authoritative source.
    // On-chain P2PKH balance may overlap with internal UTXOs (child TXs not yet mined).
    // Cache WoC balance for the funding display; use wallet.balance for operational decisions.
    const now = Date.now();
    if (now - this._balanceCacheTime > 30000) {
      try {
        this._balanceCacheOnChain = await this.network.getBalance(this.dispatchWallet.address);
        this._balanceCacheTime = now;
      } catch { /* keep stale cache */ }
    }
    // Internal balance = spendable UTXOs the wallet knows about
    // If wallet has no UTXOs yet (fresh start), fall back to on-chain balance
    const internalBal = this.dispatchWallet.balance;
    const walletBalanceSats = Math.max(internalBal, this._balanceCacheOnChain);

    // Run status flags
    const targetReached = totalTxs >= this.TX_TARGET;
    const timeExpired = elapsed > 0 && elapsed >= this.MAX_RUN_MS;
    const fundsExhausted = walletBalanceSats < 500; // less than 500 sats = effectively empty

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
      txsPerSecond,
      avgTxsPerMol,
      queueDepth: this.externalQueue.length + this.moleculeQueue.length,
      workCreated: workItems.length,
      // Enhanced metrics
      txTarget: this.TX_TARGET,
      txsRemaining,
      etaMs,
      timeRemainingMs,
      maxRunMs: this.MAX_RUN_MS,
      walletBalanceSats,
      targetReached,
      timeExpired,
      fundsExhausted,
      moleculeCount: this.molecules.length,
      receptorCount: this.receptors.size,
      receptorAtoms: this.receptors.size > 0
        ? Math.round([...this.receptors.values()].reduce((s, r) => s + r.atoms.length, 0) / this.receptors.size)
        : this.receptor.atoms.length,
    };
  }

  /** Check if the run should auto-stop */
  async shouldStop(): Promise<{ stop: boolean; reason: string }> {
    const stats = await this.getUnifiedStats();
    if (stats.targetReached) return { stop: true, reason: 'TX target reached (' + stats.totalTxs.toLocaleString() + ')' };
    if (stats.timeExpired) return { stop: true, reason: '24h run duration expired' };
    if (stats.fundsExhausted) return { stop: true, reason: 'Wallet funds exhausted (' + stats.walletBalanceSats + ' sats remaining)' };
    return { stop: false, reason: '' };
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

  /** Get completed work items with scores for the leaderboard (persisted + session) */
  getResults(): Array<PersistedResult & { totalBytes: number }> {
    const persisted = (this.persistedState.results ?? []).map(r => ({ ...r, totalBytes: 0 }));
    const session = this.getSessionResults().map(r => ({ ...r, totalBytes: 0 }));
    return [...persisted, ...session];
  }
}
