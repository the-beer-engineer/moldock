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
  genesisTxid?: string;    // for blockchain explorer links
  chainTxids?: string[];   // chain step TXIDs (if pass/verified)
}

/** Max results to persist — keeps only the best score per base molecule */
const MAX_PERSISTED_RESULTS = 200;

/** A UTXO persisted to disk (includes source TX hex for signing on reload) */
interface PersistedUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  script: string;
  sourceTxHex: string;
}

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
  /** The wallet's full UTXO set — this IS the balance */
  utxos?: PersistedUtxo[];
}

const EMPTY_STATE: PersistedState = {
  cumulativeTxs: 0, cumulativeRewardsSats: 0,
  cumulativeProcessed: 0, cumulativePassed: 0, cumulativeFailed: 0,
  results: [], testedKeys: [], utxos: [],
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
const FEE_RATE_SATS_PER_KB = parseInt(process.env.FEE_RATE_SATS_PER_KB || '100', 10); // sats/kB — ARC enforces 100 sats/kB minimum
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

  // Balance is simply the sum of persisted UTXOs — no WoC scanning needed

  // Spending lock — prevents concurrent wallet operations from picking the same UTXO
  private _spendLock: Promise<void> = Promise.resolve();

  // Persisted cumulative state (survives restarts)
  private persistedState: PersistedState;

  constructor(wallet: Wallet) {
    this.dispatchWallet = wallet;
    this.network = getNetwork();
    this.persistedState = loadState();
    // Restore persisted UTXOs into wallet
    const persistedUtxos = this.persistedState.utxos ?? [];
    if (persistedUtxos.length > 0) {
      for (const pu of persistedUtxos) {
        const sourceTx = Transaction.fromHex(pu.sourceTxHex);
        wallet.addUtxo({
          txid: pu.txid, vout: pu.vout, satoshis: pu.satoshis,
          script: pu.script, sourceTransaction: sourceTx,
        });
      }
      const bal = persistedUtxos.reduce((s, u) => s + u.satoshis, 0);
      console.log(`[dispatch] Restored ${persistedUtxos.length} UTXOs (${bal} sats) from state`);
    }

    if (this.persistedState.cumulativeTxs > 0) {
      console.log(`[dispatch] Restored state: ${this.persistedState.cumulativeTxs} cumulative TXs, ${this.persistedState.cumulativeProcessed} processed, ${(this.persistedState.results ?? []).length} results`);
    }

    // Restore dedup keys from persisted state
    for (const key of this.persistedState.testedKeys ?? []) {
      this.testedKeys.add(key);
    }

    // Persist UTXO set on every add/spend so balance is always accurate
    wallet.onSpend = () => this.persistUtxos();
    wallet.onAdd = () => this.persistUtxos();

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

  /**
   * Pick wallet UTXO(s) with at least `minSats` total.
   * Prefers a single UTXO if available, otherwise combines multiple.
   * Returns inputs ready to add to a Transaction.
   */
  private pickWalletUtxos(minSats: number): { utxos: UTXO[]; unlockTemplates: any[]; totalSats: number } | null {
    const available = this.dispatchWallet.getUtxos()
      .filter(u => u.sourceTransaction)
      .sort((a, b) => a.satoshis - b.satoshis); // smallest first — avoid wasting big UTXOs
    if (available.length === 0) return null;

    // Try single UTXO first (cheapest — fewer inputs = lower fee)
    const single = available.find(u => u.satoshis >= minSats);
    if (single) {
      const isP2PKH = single.script.length === 50 && single.script.startsWith('76a914');
      const unlock = isP2PKH
        ? new P2PKH().unlock(this.dispatchWallet.privateKey, 'all', false, single.satoshis, Script.fromHex(single.script))
        : this.dispatchWallet.p2pkUnlock(single.satoshis, Script.fromHex(single.script));
      return { utxos: [single], unlockTemplates: [unlock], totalSats: single.satoshis };
    }

    // Combine multiple UTXOs — use largest first to minimize input count
    const descending = [...available].reverse();
    const selected: UTXO[] = [];
    const unlocks: any[] = [];
    let total = 0;
    for (const u of descending) {
      const isP2PKH = u.script.length === 50 && u.script.startsWith('76a914');
      const unlock = isP2PKH
        ? new P2PKH().unlock(this.dispatchWallet.privateKey, 'all', false, u.satoshis, Script.fromHex(u.script))
        : this.dispatchWallet.p2pkUnlock(u.satoshis, Script.fromHex(u.script));
      selected.push(u);
      unlocks.push(unlock);
      total += u.satoshis;
      if (total >= minSats) break;
    }
    if (total < minSats) return null;
    return { utxos: selected, unlockTemplates: unlocks, totalSats: total };
  }

  /**
   * Serialize wallet spending: ensures only one operation picks + spends UTXOs at a time.
   * The callback should pick UTXOs, build+sign the TX, call spendUtxo, and return.
   * ARC broadcasting can happen outside the lock.
   */
  private async withSpendLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._spendLock;
    let resolve!: () => void;
    this._spendLock = new Promise(r => { resolve = r; });
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  /**
   * Run a wallet-spending TX with parallelism-safe semantics:
   *   1. Under the spend lock: pick UTXOs, build+sign TX, mark spent (PESSIMISTIC)
   *   2. Outside the lock: broadcast (allows parallel broadcasts across agents)
   *   3. On success: add change UTXO to wallet
   *   4. On failure: rollback (restore spent UTXOs)
   *
   * This allows N agents to have N broadcasts in flight simultaneously,
   * with only the ~10ms pick+sign step serialized.
   */
  private async walletTxWithRollback<T>(
    build: (picked: { utxos: UTXO[]; unlockTemplates: any[]; totalSats: number }) => Promise<{ tx: Transaction; walletOuts: number[]; result: T }>,
    minSats: number,
  ): Promise<{ tx: Transaction; txid: string; result: T }> {
    // Phase 1: pick + sign + mark spent (under lock)
    const { tx, walletOuts, result, snapshots } = await this.withSpendLock(async () => {
      const picked = this.pickWalletUtxos(minSats);
      if (!picked) throw new Error(`No funding available (need ${minSats} sats, have ${this.dispatchWallet.balance})`);
      const snapshots = picked.utxos.map(u => ({ ...u }));
      const { tx, walletOuts, result } = await build(picked);
      for (const u of picked.utxos) this.dispatchWallet.spendUtxo(u.txid, u.vout);
      return { tx, walletOuts, result, snapshots };
    });

    // Phase 2: broadcast (outside lock — parallel across agents)
    let txid: string;
    try {
      txid = await this.network.broadcast(tx);
    } catch (err) {
      await this.withSpendLock(async () => {
        for (const snap of snapshots) {
          this.dispatchWallet.addUtxo(snap);
        }
      });
      throw err;
    }

    // Phase 3: add output UTXOs back to wallet (under lock)
    if (walletOuts.length > 0) {
      await this.withSpendLock(async () => {
        const p2pkHex = this.dispatchWallet.p2pkLockingScript().toHex();
        for (const idx of walletOuts) {
          const out = tx.outputs[idx];
          if (out && out.satoshis && out.satoshis > 0) {
            this.dispatchWallet.addUtxo({
              txid, vout: idx, satoshis: out.satoshis,
              script: p2pkHex,
              sourceTransaction: tx,
            });
          }
        }
      });
    }

    return { tx, txid, result };
  }

  /**
   * Fan out a big UTXO into many smaller ones so parallel agents don't contend.
   * Called on startup when a single UTXO exceeds `threshold`.
   */
  async fanOutIfNeeded(threshold = 500000, numOutputs = 50, satsPerOutput = 300000): Promise<void> {
    if (this.network.getNetwork() === 'regtest') return;

    const utxos = this.dispatchWallet.getUtxos();
    const big = utxos.filter(u => u.satoshis >= threshold);
    if (big.length === 0) return;

    // Count how many small UTXOs we already have — if plenty, skip
    const smallEnough = utxos.filter(u => u.satoshis >= satsPerOutput && u.satoshis < threshold);
    if (smallEnough.length >= numOutputs) {
      console.log(`[fanout] Skipping — already have ${smallEnough.length} suitable UTXOs`);
      return;
    }

    const bigTotal = big.reduce((s, u) => s + u.satoshis, 0);
    const targetTotal = numOutputs * satsPerOutput + 5000; // +buffer for fee
    if (bigTotal < targetTotal) {
      console.log(`[fanout] Insufficient big UTXOs (${bigTotal} sats) to fan out to ${numOutputs} × ${satsPerOutput}`);
      return;
    }

    console.log(`[fanout] Fanning out ${big.length} big UTXO(s) (${bigTotal} sats) → ${numOutputs} × ${satsPerOutput} sats`);

    try {
      await this.walletTxWithRollback(async (picked) => {
        const tx = new Transaction();
        tx.version = 2;
        for (let i = 0; i < picked.utxos.length; i++) {
          tx.addInput({
            sourceTransaction: picked.utxos[i].sourceTransaction,
            sourceOutputIndex: picked.utxos[i].vout,
            unlockingScriptTemplate: picked.unlockTemplates[i],
          });
        }
        const lockScript = this.dispatchWallet.p2pkLockingScript();
        for (let i = 0; i < numOutputs; i++) {
          tx.addOutput({ lockingScript: lockScript, satoshis: satsPerOutput });
        }
        tx.addOutput({ lockingScript: lockScript, change: true });
        await tx.fee(new SatoshisPerKilobyte(FEE_RATE_SATS_PER_KB));
        await tx.sign();
        // walletOuts = all N fan-out outputs + change
        const outs = Array.from({ length: numOutputs + 1 }, (_, i) => i);
        return { tx, walletOuts: outs, result: null };
      }, targetTotal);

      // Also need to add the non-change fan-out outputs to the wallet
      // walletTxWithRollback only adds the changeOut index; we need to add all N outputs
      // Rebuild by querying the wallet for the tx we just created (it has the change UTXO)
      // Actually we need a different approach — let me track this manually

      console.log(`[fanout] Complete`);
    } catch (err: any) {
      console.log(`[fanout] Failed: ${err.message}`);
    }
  }

  /** Check for new incoming deposits (P2PKH + one-time P2PK bootstrap) */
  async scanForDeposits(): Promise<void> {
    if (this.network.getNetwork() === 'regtest') return;

    try {
      const wocBase = this.network.getNetwork() === 'mainnet'
        ? 'https://api.whatsonchain.com/v1/bsv/main'
        : 'https://api.whatsonchain.com/v1/bsv/test';

      const known = new Set(this.dispatchWallet.getUtxos().map(u => `${u.txid}:${u.vout}`));

      // One-time bootstrap: if wallet is empty (no persisted UTXOs), scan WoC for P2PK UTXOs
      if (this.dispatchWallet.getUtxos().length === 0) {
        console.log(`[dispatch] No persisted UTXOs — bootstrapping from WoC...`);
        const p2pkScript = this.dispatchWallet.p2pkLockingScript().toHex();
        const p2pkUtxos = await this.network.fetchScriptUtxos?.(p2pkScript) ?? [];
        for (const u of p2pkUtxos) {
          try {
            const resp = await fetch(`${wocBase}/tx/${u.txid}/hex`);
            if (!resp.ok) continue;
            const sourceTx = Transaction.fromHex(await resp.text());
            this.dispatchWallet.addUtxo({
              txid: u.txid, vout: u.vout, satoshis: u.satoshis,
              script: p2pkScript, sourceTransaction: sourceTx,
            });
            known.add(`${u.txid}:${u.vout}`);
          } catch { /* skip */ }
        }
        if (p2pkUtxos.length > 0) {
          console.log(`[dispatch] Bootstrapped ${p2pkUtxos.length} P2PK UTXOs from WoC`);
        }
      }

      // Check for new P2PKH deposits not already in our UTXO set
      const p2pkhUtxos = await this.network.fetchUtxos(this.dispatchWallet.address);
      let newDeposits = 0;
      let newSats = 0;
      for (const u of p2pkhUtxos) {
        if (known.has(`${u.txid}:${u.vout}`)) continue;
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
          newDeposits++;
          newSats += u.satoshis;
        } catch { /* skip */ }
      }
      if (newDeposits > 0) {
        console.log(`[dispatch] New deposits: ${newDeposits} UTXOs (${newSats} sats)`);
      }

      console.log(`[dispatch] Wallet: ${this.dispatchWallet.balance} sats, ${this.dispatchWallet.getUtxos().length} UTXOs`);
    } catch (err: any) {
      console.log(`[dispatch] Deposit scan failed: ${err.message}`);
    }
  }

  /** Persist the wallet's current UTXO set to disk (debounced — called on every add/spend) */
  private _persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistUtxos(): void {
    // Debounce: batch rapid add/spend calls into a single write
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.persistState();
    }, 2000); // 2s debounce — reduces disk writes under heavy load
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
    // If same name re-registers (stop/start), reuse the existing agent
    const existingId = this.agentsByName.get(name.toLowerCase());
    if (existingId) {
      const existing = this.agents.get(existingId)!;
      existing.pubkey = pubkey;
      existing.paymail = paymail ?? existing.paymail;
      existing.currentWorkId = null;
      existing.currentMoleculeId = null;
      existing.lastSeen = new Date().toISOString();
      console.log(`[dispatch] Agent re-registered: ${name} (${existingId})`);
      return { agent: existing };
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

  /**
   * Clean up stale work items from the in-memory work map.
   * - Verified/pass/fail work older than 10 min → removed (browsers won't re-submit)
   * - Assigned work older than WORK_TIMEOUT_MS (30 min) with no progress → removed
   * This prevents unbounded memory growth and keeps the chain verification ticker fast.
   */
  cleanupStaleWork(): { removed: number; remaining: number } {
    const now = Date.now();
    const TERMINAL_TTL = 10 * 60 * 1000; // 10 min after complete
    let removed = 0;
    for (const [id, work] of this.work.entries()) {
      const assignedAt = new Date(work.assignedAt).getTime();
      const age = now - assignedAt;
      // Terminal states: clean up after TERMINAL_TTL
      if ((work.status === 'verified' || work.status === 'pass' || work.status === 'fail') && age > TERMINAL_TTL) {
        this.work.delete(id);
        removed++;
        continue;
      }
      // Stuck assigned work: clean up after WORK_TIMEOUT_MS
      if (work.status === 'assigned' && age > WORK_TIMEOUT_MS) {
        this.work.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[dispatch] Cleaned up ${removed} stale work items (${this.work.size} remaining)`);
    }
    return { removed, remaining: this.work.size };
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

  /**
   * Create N work packages for an agent in parallel.
   * The wallet broadcasts run concurrently (via walletTxWithRollback's parallel pattern).
   */
  async createWorkBatch(agentId: string, count: number): Promise<{ works?: WorkPackage[]; error?: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    if (this.startTime === 0) this.startTime = performance.now();

    const promises: Promise<{ work?: WorkPackage; error?: string }>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(this.createWorkPackageInternal(agentId, true));
    }
    const results = await Promise.all(promises);
    const works = results.filter(r => r.work).map(r => r.work!);
    if (works.length === 0) {
      return { error: results[0]?.error || 'No work created' };
    }
    return { works };
  }

  async createWorkPackage(agentId: string): Promise<{ work?: WorkPackage; error?: string }> {
    return this.createWorkPackageInternal(agentId, false);
  }

  private async createWorkPackageInternal(agentId: string, allowConcurrent: boolean): Promise<{ work?: WorkPackage; error?: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    if (!allowConcurrent && agent.currentWorkId) return { error: 'Agent already has work assigned' };

    // Start the clock on first work assignment
    if (this.startTime === 0) this.startTime = performance.now();

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
      if (!allowConcurrent) {
        agent.currentWorkId = workId;
        agent.currentMoleculeId = ext.molecule.id;
      }
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

    // Create genesis TX — parallel-safe: pick+sign under lock, broadcast outside
    try {
      const { tx: genesisTx, txid: genesisTxid } = await this.walletTxWithRollback(async (picked) => {
        const tx = new Transaction();
        tx.version = 2;
        for (let i = 0; i < picked.utxos.length; i++) {
          tx.addInput({
            sourceTransaction: picked.utxos[i].sourceTransaction,
            sourceOutputIndex: picked.utxos[i].vout,
            unlockingScriptTemplate: picked.unlockTemplates[i],
          });
        }
        tx.addOutput({ lockingScript: buildChainLockScript(numAtoms, 0, compiledAsm), satoshis: 1 });
        tx.addOutput({ lockingScript: this.dispatchWallet.p2pkLockingScript(), change: true });
        await tx.fee(new SatoshisPerKilobyte(FEE_RATE_SATS_PER_KB));
        await tx.sign();
        return { tx, walletOuts: [1], result: null };
      }, 500);
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
      // In batch mode (allowConcurrent), browser tracks its own queue.
      // In single mode, we set currentWorkId to enforce one-at-a-time.
      if (!allowConcurrent) {
        agent.currentWorkId = workId;
        agent.currentMoleculeId = molecule.id;
      }
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

    // Fire-and-forget reward — walletTxWithRollback handles failure rollback internally
    this.payReward(agent, REWARD_BASE_SATS).catch(() => {/* logged inside payReward */});

    this.markTested(work);
    this.pushEvent({ type: 'fail', agentName: agent.name, agentId, moleculeId: work.molecule.id, score: finalScore });
    this.trackBatchCompletion(work.batchId);
    this.persistState();
    console.log(`[dispatch] ${agent.name} reported FAIL for ${workId} (score=${finalScore})`);

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
      // Fire-and-forget reward — walletTxWithRollback handles failure rollback internally
      this.payReward(agent, passReward).catch(() => {/* logged inside payReward */});
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
      // Fire-and-forget reward — walletTxWithRollback handles failure rollback internally
      this.payReward(agent, passReward).catch(() => {/* logged inside payReward */});

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
    // Estimate from actual TX sizes — add ~150 bytes for fee input (txid+vout+sig+sequence)
    const avgBytes = chainTxHexes.reduce((s, h) => s + h.length / 2, 0) / chainTxHexes.length;
    const withFeeInput = avgBytes + 150;
    // 100 sats/kB, round up with small margin
    return Math.ceil((withFeeInput * FEE_RATE_SATS_PER_KB) / 1000) + 5;
  }

  private async createFeeUtxos(
    agentPubkey: string, count: number, satsEach: number,
  ): Promise<FeePackage['utxos']> {
    // Build + sign under spend lock
    const totalNeeded = count * satsEach + 500;

    const agentPubkeyBytes = Buffer.from(agentPubkey, 'hex');
    const agentLockScript = new Script([
      { op: agentPubkeyBytes.length, data: [...agentPubkeyBytes] },
      { op: 0xac }, // OP_CHECKSIG
    ]).toHex();
    const agentLock = Script.fromHex(agentLockScript);

    // Parallel-safe: pick+sign under lock, broadcast outside
    const { tx: feeTx, txid: feeTxid } = await this.walletTxWithRollback(async (picked) => {
      const tx = new Transaction();
      tx.version = 2;
      for (let i = 0; i < picked.utxos.length; i++) {
        tx.addInput({
          sourceTransaction: picked.utxos[i].sourceTransaction,
          sourceOutputIndex: picked.utxos[i].vout,
          unlockingScriptTemplate: picked.unlockTemplates[i],
        });
      }
      for (let i = 0; i < count; i++) {
        tx.addOutput({ lockingScript: agentLock, satoshis: satsEach });
      }
      tx.addOutput({ lockingScript: this.dispatchWallet.p2pkLockingScript(), change: true });
      await tx.fee(new SatoshisPerKilobyte(FEE_RATE_SATS_PER_KB));
      await tx.sign();
      return { tx, walletOuts: [count], result: null };
    }, totalNeeded);
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

    try {
      const { txid } = await this.walletTxWithRollback(async (picked) => {
        const tx = new Transaction();
        tx.version = 2;
        for (let i = 0; i < picked.utxos.length; i++) {
          tx.addInput({
            sourceTransaction: picked.utxos[i].sourceTransaction,
            sourceOutputIndex: picked.utxos[i].vout,
            unlockingScriptTemplate: picked.unlockTemplates[i],
          });
        }
        tx.addOutput({ lockingScript: agentLockScript, satoshis: rewardSats });
        tx.addOutput({ lockingScript: this.dispatchWallet.p2pkLockingScript(), change: true });
        await tx.fee(new SatoshisPerKilobyte(FEE_RATE_SATS_PER_KB));
        await tx.sign();
        return { tx, walletOuts: [1], result: null };
      }, rewardSats + 200);
      await this.network.mine(1);
      agent.totalRewardsSats += rewardSats;
      console.log(`[dispatch] Paid ${rewardSats} sats to ${agent.name} → ${destination} (total: ${agent.totalRewardsSats} sats) txid=${txid}`);
      this.pushEvent({ type: 'reward', agentName: agent.name, agentId: agent.id, rewardSats });
      return txid;
    } catch (err: any) {
      console.log(`[dispatch] Reward payment failed for ${agent.name}: ${err.message}`);
      throw err;
    }
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
      activeAgents: agents.filter(a => (Date.now() - new Date(a.lastSeen).getTime() < 60000)).length,
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
      utxos: this.dispatchWallet.getUtxos().map(u => ({
        txid: u.txid, vout: u.vout, satoshis: u.satoshis, script: u.script,
        sourceTxHex: u.sourceTransaction ? u.sourceTransaction.toHex() : '',
      })).filter(u => u.sourceTxHex.length > 0),
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
          genesisTxid: w.genesisTxid,
          chainTxids: w.chainTxids,
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

    // Wallet balance = sum of persisted UTXOs. Simple and accurate.
    const walletBalanceSats = this.dispatchWallet.balance;
    const walletUtxoCount = this.dispatchWallet.getUtxos().length;

    // Run status flags
    const targetReached = totalTxs >= this.TX_TARGET;
    const timeExpired = elapsed > 0 && elapsed >= this.MAX_RUN_MS;
    const fundsExhausted = walletBalanceSats < 500; // less than 500 sats = effectively empty

    return {
      totalAgents: agents.length,
      activeAgents: agents.filter(a => (Date.now() - new Date(a.lastSeen).getTime() < 60000)).length,
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
      walletUtxoCount,
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
    const WORKING_MS = 60 * 1000;     // within 60s = actively working
    const OFFLINE_MS = 5 * 60 * 1000; // > 5 min = offline
    return [...this.agents.values()].map(a => {
      const sinceLastSeen = now - new Date(a.lastSeen).getTime();
      let status: string;
      if (sinceLastSeen < WORKING_MS) {
        status = 'working';
      } else if (sinceLastSeen < OFFLINE_MS) {
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
