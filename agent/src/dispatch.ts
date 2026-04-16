/**
 * Dispatch system: manages remote agents, distributes work packages,
 * verifies results, and funds fee UTXOs for chain broadcasting.
 */
import { Transaction, Script, SatoshisPerKilobyte, P2PKH, Hash } from '@bsv/sdk';
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
  genesisVout: number;      // which output of the genesis TX is THIS molecule's covenant (default 0)
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
const FEE_RATE_SATS_PER_KB = parseInt(process.env.FEE_RATE_SATS_PER_KB || '150', 10); // sats/kB — Arcade 465 errors say required is ~100-150
const FEE_PER_STEP_SATS = 200;          // default estimate: ~1.65KB chain TX × 100 sats/kB ≈ 165, rounded up

export class DispatchManager {
  private agents = new Map<string, RemoteAgent>();
  private agentsByName = new Map<string, string>(); // name → id
  private work = new Map<string, WorkPackage>();
  public dispatchWallet: Wallet;
  private network: NetworkAdapter;

  // Pre-compiled ASM cache
  private asmCache = new Map<number, string>();

  // Rolling 60-second TX rate tracker
  private _txSnapshots: Array<{ time: number; txs: number }> = [];
  // Last-known chain balance (from scanForDeposits or reconcile). Stable, doesn't flicker.
  public lastChainBalanceSats = 0;

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

    // Seed verify-tx tracker with all loaded UTXOs so verifyWalletTxs() will
    // sweep any ghosts left over from previous runs. We mark them as "broadcast"
    // long ago so they're checked immediately. Each unique parent txid is tracked
    // once with all its vouts, so verification removes all change in one go.
    const parentTxs = new Map<string, Set<number>>();
    for (const u of wallet.getUtxos()) {
      if (!parentTxs.has(u.txid)) parentTxs.set(u.txid, new Set());
      parentTxs.get(u.txid)!.add(u.vout);
    }
    // Mark loaded UTXOs as already verified — they were checked against Arcade
    // during scanForDeposits. Don't re-verify (Arcade's broken Teranode returns
    // errors for valid TXs, causing false ghost detection).
    for (const [txid, vouts] of parentTxs) {
      this._recentWalletTxs.set(txid, {
        broadcastAt: Date.now(),
        walletOuts: [...vouts],
        verified: true,  // already verified by scanForDeposits
      });
    }
    if (parentTxs.size > 0) {
      console.log(`[dispatch] Marked ${parentTxs.size} loaded UTXOs as pre-verified`);
    }

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
   * prefer: 'smallest' picks the smallest sufficient UTXO (for genesis — preserve big ones for fees).
   *         'largest' picks the largest (for fee TXs — more change for future use).
   * Returns inputs ready to add to a Transaction.
   */
  private pickWalletUtxos(minSats: number, prefer: 'smallest' | 'largest' | 'median' = 'largest', pool?: 'genesis' | 'fee'): { utxos: UTXO[]; unlockTemplates: any[]; totalSats: number } | null {
    // Expire failed-UTXO blacklist entries older than 2 min (was 10 min — too sticky)
    const now = Date.now();
    const BLACKLIST_TTL = 2 * 60 * 1000;
    for (const [k, t] of this._failedUtxos.entries()) {
      if (now - t > BLACKLIST_TTL) this._failedUtxos.delete(k);
    }
    // Check for new block — clears mempool-conflict blacklist
    this._checkNewBlock().catch(() => {});

    // Filter: need sourceTransaction, not pending, P2PKH OR P2PK (both are valid inputs —
    // Teranode only rejects P2PK OUTPUTS, not inputs). Skip mempool-conflict UTXOs.
    const POOL_THRESHOLD = 50_000; // sats — genesis uses small, fee uses large
    let allUtxos = this.dispatchWallet.getUtxos()
      .filter(u => u.sourceTransaction && !u.pending)
      .filter(u => u.script && (u.script.startsWith('76a914') || u.script.startsWith('21')))
      .filter(u => !this._mempoolConflictUtxos.has(`${u.txid}:${u.vout}`));
    // Pool split: genesis picks small UTXOs, fee picks large — no lock contention
    if (pool === 'genesis') allUtxos = allUtxos.filter(u => u.satoshis < POOL_THRESHOLD);
    else if (pool === 'fee') allUtxos = allUtxos.filter(u => u.satoshis >= POOL_THRESHOLD);
    // Sort by preference:
    // 'smallest' — ascending (preserve big for fees)
    // 'largest' — descending (more change for future use)
    // 'median' — shuffle to pick from the middle (prevents deep ancestor chains)
    const sortFn = prefer === 'smallest'
      ? (a: UTXO, b: UTXO) => a.satoshis - b.satoshis
      : (a: UTXO, b: UTXO) => b.satoshis - a.satoshis;

    let available = allUtxos
      .filter(u => !this._failedUtxos.has(`${u.txid}:${u.vout}`))
      .sort(sortFn);

    // Safety valve: if blacklist starved us, clear it
    const availableTotal = available.reduce((s, u) => s + u.satoshis, 0);
    const allUtxosTotal = allUtxos.reduce((s, u) => s + u.satoshis, 0);
    if (availableTotal < minSats && allUtxosTotal >= minSats) {
      console.log(`[dispatch] Blacklist starved pick (${available.length}/${allUtxos.length} available). Clearing ${this._failedUtxos.size} entries.`);
      this._failedUtxos.clear();
      available = allUtxos.sort(sortFn);
    }
    if (available.length === 0) return null;

    // Try single UTXO first.
    // For 'median': pick from the middle of the sorted array to prevent deep ancestor chains.
    // Picking smallest creates a chain: small → smaller → smaller. Median spreads picks.
    let single: UTXO | undefined;
    if (prefer === 'median') {
      const eligible = available.filter(u => u.satoshis >= minSats);
      if (eligible.length > 0) {
        eligible.sort((a, b) => a.satoshis - b.satoshis);
        single = eligible[Math.floor(eligible.length / 2)];
      }
    } else {
      single = available.find(u => u.satoshis >= minSats);
    }
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
  // UTXOs that have recently failed broadcast — skipped on subsequent picks.
  // Cleared every 10 min so we eventually retry them.
  private _failedUtxos = new Map<string, number>();
  // UTXOs with mempool-conflict — a prior TX in mempool already spends them.
  // Cleared when a new block is detected (mempool settles). Never expire by time.
  private _mempoolConflictUtxos = new Set<string>();
  private _lastBlockHeight = 0;
  // Diagnostic: count of clearPending calls that didn't find their target UTXO
  private _clearMisses = 0;
  private _broadcastErrCount = 0;
  private _phase3Misses = 0;
  // Tracks wallet TXs we've broadcast that may still be unconfirmed.
  // Format: txid → { broadcastAt: ms, walletOuts: [vout], checkedAt?: ms }
  // Used by verifyWalletTxs() to detect ghosts (TXs we think succeeded but didn't).
  private _recentWalletTxs = new Map<string, { broadcastAt: number; walletOuts: number[]; verified?: boolean }>();

  /** Fan out into a varied pool of UTXOs — small ones for genesis, large ones for fees.
   *  Runs aggressively: triggers when < 30 P2PKH UTXOs and any UTXO > 500k sats exists. */
  async fanOutVaried(): Promise<void> {
    if (this.network.getNetwork() === 'regtest') return;
    const p2pkh = this.dispatchWallet.getUtxos().filter(u => u.script?.startsWith('76a914'));
    if (p2pkh.length >= 100) {
      return; // Enough UTXOs
    }
    const big = p2pkh.filter(u => u.satoshis >= 500_000);
    if (big.length === 0) {
      return; // No UTXO big enough to split
    }

    // Build output list: 50 small (10k) + 50 large (500k) = 100 outputs
    // 200 outputs got rejected by Teranode — keep at 100 which works
    const SMALL_COUNT = 50;
    const SMALL_SATS = 10_000;
    const LARGE_COUNT = 50;
    const LARGE_SATS = 500_000;
    const totalOutputSats = (SMALL_COUNT * SMALL_SATS) + (LARGE_COUNT * LARGE_SATS);
    const minInput = totalOutputSats + 10_000; // buffer for fee + change

    console.log(`[fanout] Creating ${SMALL_COUNT}×${SMALL_SATS} + ${LARGE_COUNT}×${LARGE_SATS} = ${totalOutputSats} sats (${(totalOutputSats/1e8).toFixed(4)} BSV)`);

    try {
      await this.walletTxWithRollback(async (picked) => {
        const lockScript = this.dispatchWallet.p2pkhLockingScript();
        const buildAndSign = async (changeSats: number) => {
          const tx = new Transaction();
          tx.version = 2;
          for (let i = 0; i < picked.utxos.length; i++) {
            tx.addInput({
              sourceTransaction: picked.utxos[i].sourceTransaction,
              sourceOutputIndex: picked.utxos[i].vout,
              unlockingScriptTemplate: picked.unlockTemplates[i],
            });
          }
          // Small outputs first (indices 0..49)
          for (let i = 0; i < SMALL_COUNT; i++) {
            tx.addOutput({ lockingScript: lockScript, satoshis: SMALL_SATS });
          }
          // Large outputs (indices 50..99)
          for (let i = 0; i < LARGE_COUNT; i++) {
            tx.addOutput({ lockingScript: lockScript, satoshis: LARGE_SATS });
          }
          // Change (index 100)
          tx.addOutput({ lockingScript: lockScript, satoshis: changeSats });
          await tx.sign();
          return tx;
        };
        let changeSats = picked.totalSats - totalOutputSats - 2000;
        if (changeSats < 1) throw new Error(`Fanout: insufficient funds (have ${picked.totalSats}, need ${totalOutputSats + 2000})`);
        let tx = await buildAndSign(changeSats);
        const fee = Math.ceil(tx.toHex().length / 2 * 150 / 1000) + 50;
        changeSats = picked.totalSats - totalOutputSats - fee;
        if (changeSats < 1) throw new Error(`Fanout: fee ${fee} exceeds funds`);
        tx = await buildAndSign(changeSats);
        // walletOuts = ALL outputs (100 fan-out + 1 change)
        const outs = Array.from({ length: SMALL_COUNT + LARGE_COUNT + 1 }, (_, i) => i);
        return { tx, walletOuts: outs, result: null };
      }, minInput);
      console.log(`[fanout] Complete — ${SMALL_COUNT + LARGE_COUNT + 1} outputs created`);
    } catch (err: any) {
      console.log(`[fanout] Failed: ${err.message}`);
    }
  }

  /** Check if a new block has been mined since last check. Clears mempool-conflict set. */
  private async _checkNewBlock(): Promise<void> {
    try {
      const height = await this.network.getBlockHeight();
      if (height > this._lastBlockHeight && this._lastBlockHeight > 0) {
        if (this._mempoolConflictUtxos.size > 0) {
          console.log(`[block] New block ${height} — clearing ${this._mempoolConflictUtxos.size} mempool-conflict UTXOs`);
          this._mempoolConflictUtxos.clear();
          // Scan for new deposits now that mempool has settled
          this.scanForDeposits().catch(() => {});
        }
      }
      this._lastBlockHeight = height;
    } catch {}
  }

  /** Walk a UTXO's spend chain to find the latest unspent output to our address.
   *  Used to recover from mempool-conflict: our prior broadcast spent the input,
   *  creating a change output. That change may itself have been spent in further
   *  broadcasts. We walk until we find the TIP (unspent). */
  private async _walkAndRecoverTip(txid: string, vout: number): Promise<void> {
    if (this.network.getNetwork() === 'regtest') return;
    const wocBase = this.network.getNetwork() === 'mainnet'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test';
    const myAddress = this.dispatchWallet.address;
    let depth = 0;

    while (depth < 50) {
      try {
        const r = await fetch(`${wocBase}/tx/hash/${txid}`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return;
        const d: any = await r.json();
        const v = d.vout?.[vout];
        if (!v) return;

        if (!v.spentTxId) {
          // Found the TIP — add it to wallet if we don't already have it
          const sats = Math.round(v.value * 1e8);
          if (sats < 100) return; // skip dust
          const key = `${txid}:${vout}`;
          if (this.dispatchWallet.hasUtxo(txid, vout)) return;
          // Fetch source tx hex
          const hexR = await fetch(`${wocBase}/tx/${txid}/hex`, { signal: AbortSignal.timeout(5000) });
          if (!hexR.ok) return;
          const sourceTx = Transaction.fromHex(await hexR.text());
          const script = sourceTx.outputs[vout].lockingScript!.toHex();
          // Only add P2PKH (Teranode rejects P2PK)
          if (!script.startsWith('76a914')) return;
          this.dispatchWallet.addUtxo({
            txid, vout, satoshis: sats, script, sourceTransaction: sourceTx,
          });
          console.log(`[walk-recover] Found tip at depth ${depth}: ${txid.slice(0,16)}:${vout} = ${sats} sats`);
          return;
        }

        // Follow the spend
        const spendTxid = v.spentTxId;
        const sr = await fetch(`${wocBase}/tx/hash/${spendTxid}`, { signal: AbortSignal.timeout(5000) });
        if (!sr.ok) return;
        const sd: any = await sr.json();
        let found = false;
        for (let i = 0; i < sd.vout.length; i++) {
          const addrs = sd.vout[i].scriptPubKey?.addresses || [];
          if (addrs.includes(myAddress) && sd.vout[i].value > 0.0001) {
            txid = spendTxid;
            vout = i;
            found = true;
            break;
          }
        }
        if (!found) return;
        depth++;
      } catch { return; }
    }
  }

  /** Check if a tx landed on chain (via WoC /tx/hash/). Returns true if 200. */
  private async _verifyTxLanded(txid: string): Promise<boolean> {
    if (this.network.getNetwork() === 'regtest') return true;
    const wocBase = this.network.getNetwork() === 'mainnet'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test';
    try {
      const r = await fetch(`${wocBase}/tx/hash/${txid}`, { signal: AbortSignal.timeout(5000) });
      return r.status === 200;
    } catch { return false; }
  }

  /** Debug-only: expose pickWalletUtxos publicly with detailed failure reason */
  public async debugPickWalletUtxos(minSats: number): Promise<{ success: boolean; reason?: string; totalSats?: number; utxoCount?: number; allUtxosCount?: number; blacklistSize?: number; sourceTxMissing?: number; pendingCount?: number }> {
    const before = {
      total: this.dispatchWallet.getUtxos().length,
      pending: this.dispatchWallet.getUtxos().filter(u => u.pending).length,
      noSource: this.dispatchWallet.getUtxos().filter(u => !u.sourceTransaction).length,
      blacklist: this._failedUtxos.size,
    };
    const picked = this.pickWalletUtxos(minSats);
    const after = {
      total: this.dispatchWallet.getUtxos().length,
      pending: this.dispatchWallet.getUtxos().filter(u => u.pending).length,
      noSource: this.dispatchWallet.getUtxos().filter(u => !u.sourceTransaction).length,
      blacklist: this._failedUtxos.size,
    };
    if (picked) {
      return { success: true, totalSats: picked.totalSats, utxoCount: picked.utxos.length, allUtxosCount: before.total, blacklistSize: before.blacklist, sourceTxMissing: before.noSource, pendingCount: before.pending };
    }
    return { success: false, reason: `pick returned null (before: total=${before.total} pending=${before.pending} noSrc=${before.noSource} blacklist=${before.blacklist}) (after: total=${after.total} pending=${after.pending} noSrc=${after.noSource} blacklist=${after.blacklist})`, allUtxosCount: before.total, blacklistSize: before.blacklist, sourceTxMissing: before.noSource, pendingCount: before.pending };
  }

  private async walletTxWithRollback<T>(
    build: (picked: { utxos: UTXO[]; unlockTemplates: any[]; totalSats: number }) => Promise<{ tx: Transaction; walletOuts: number[]; result: T }>,
    minSats: number,
    pickPrefer: 'smallest' | 'largest' | 'median' = 'largest',
  ): Promise<{ tx: Transaction; txid: string; result: T }> {
    // 3 attempts: enough for transient failures, not enough to hang the request.
    // MEMPOOL_CONFLICT fails immediately (marks UTXO, doesn't retry same one).
    const MAX_ATTEMPTS = 3;
    let lastErr: any;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Phase 1: pick, sign, mark spent (under lock). NO pending change added.
      // Change gets added as CONFIRMED after broadcast succeeds. If broadcast fails,
      // rollback restores the spent inputs. This eliminates the pending accumulation.
      let phase1: { tx: Transaction; walletOuts: number[]; result: T; snapshots: UTXO[] } | null = null;
      try {
        phase1 = await this.withSpendLock(async () => {
          const picked = this.pickWalletUtxos(minSats, pickPrefer);
          if (!picked) throw new Error(`NO_FUNDING:${minSats}`);
          const snapshots = picked.utxos.map(u => ({ ...u }));
          const { tx, walletOuts, result } = await build(picked);
          for (const u of picked.utxos) this.dispatchWallet.spendUtxo(u.txid, u.vout);
          return { tx, walletOuts, result, snapshots };
        });
      } catch (err: any) {
        lastErr = err;
        if (String(err?.message || '').startsWith('NO_FUNDING')) {
          // Wait briefly for in-flight broadcasts to release change UTXOs.
          if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          const spendable = this.dispatchWallet.spendableBalance;
          const utxoCount = this.dispatchWallet.getUtxos().length;
          throw new Error(
            `No funding available (need ${minSats}, spendable ${spendable} in ${utxoCount} UTXOs)`
          );
        }
        throw err;
      }
      if (!phase1) continue;

      const { tx, walletOuts, result, snapshots } = phase1;

      // Phase 2: broadcast (outside lock)
      try {
        const txid = await this.network.broadcast(tx);

        // Phase 3: add change output as CONFIRMED.
        const beforeCount = this.dispatchWallet.getUtxos().length;
        await this.withSpendLock(async () => {
          const p2pkhHex = this.dispatchWallet.p2pkhLockingScript().toHex();
          for (const idx of walletOuts) {
            const out = tx.outputs[idx];
            if (out && out.satoshis && out.satoshis > 0) {
              const outScriptHex = out.lockingScript?.toHex() ?? p2pkhHex;
              this.dispatchWallet.addUtxo({
                txid, vout: idx, satoshis: out.satoshis,
                script: outScriptHex, sourceTransaction: tx,
              });
            } else {
              // CHANGE OUTPUT IS MISSING OR ZERO — this is the leak!
              console.log(`[LEAK] phase3 walletOuts[${idx}] has no output or 0 sats! outputs.length=${tx.outputs.length} idx=${idx} sats=${out?.satoshis}`);
            }
          }
        });
        const afterCount = this.dispatchWallet.getUtxos().length;
        if (afterCount <= beforeCount) {
          console.log(`[LEAK] phase3 did NOT increase UTXO count! before=${beforeCount} after=${afterCount} walletOuts=${JSON.stringify(walletOuts)}`);
        }

        this._recentWalletTxs.set(txid, {
          broadcastAt: Date.now(),
          walletOuts: walletOuts.slice(),
        });

        return { tx, txid, result };
      } catch (err: any) {
        lastErr = err;
        const errMsg = String(err?.message || '');
        this._broadcastErrCount = (this._broadcastErrCount ?? 0) + 1;
        if (this._broadcastErrCount <= 20 || this._broadcastErrCount % 50 === 0) {
          console.log(`[broadcast-err #${this._broadcastErrCount}] txid=${phase1?.tx?.id('hex')?.slice(0,16)} err=${errMsg.slice(0,150)}`);
        }

        // MEMPOOL_CONFLICT means a PRIOR broadcast already spent this input.
        // Mark it as mempool-conflict (won't be picked again until next block).
        // Walk the spending chain to find the current TIP.
        if (errMsg.startsWith('MEMPOOL_CONFLICT')) {
          for (const snap of snapshots) {
            this._mempoolConflictUtxos.add(`${snap.txid}:${snap.vout}`);
            this._walkAndRecoverTip(snap.txid, snap.vout).catch(() => {});
          }
          throw new Error(`Input already spent in mempool`);
        }

        // "Failed to validate" often means the parent TX didn't propagate to all nodes.
        // RE-BROADCAST the parent TX before rolling back — this ensures all nodes see it.
        const isValidationFail = /failed to validate|missing|unknown.*input|previous|parent/i.test(errMsg);
        if (isValidationFail) {
          // Re-broadcast each input's source TX to all Arcade endpoints (fire-and-forget)
          for (const snap of snapshots) {
            if (snap.sourceTransaction) {
              try {
                const parentEf = snap.sourceTransaction.toHexEF();
                const parentBody = Buffer.from(parentEf, 'hex');
                for (const ep of ['https://arcade-eu-1.bsvb.tech', 'https://arcade-ttn-us-1.bsvb.tech', 'https://arcade-us-1.bsvb.tech']) {
                  fetch(`${ep}/tx`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: parentBody }).catch(() => {});
                }
              } catch {}
            }
            this._failedUtxos.set(`${snap.txid}:${snap.vout}`, Date.now());
          }
        }
        // Rollback: restore spent inputs
        await this.withSpendLock(async () => {
          for (const snap of snapshots) {
            this.dispatchWallet.addUtxo(snap);
          }
        });
      }
    }

    throw lastErr || new Error('walletTxWithRollback: all attempts failed');
  }

  /**
   * Fan out a big UTXO into many smaller ones so parallel agents don't contend.
   * Called on startup when a single UTXO exceeds `threshold`.
   */
  async fanOutIfNeeded(threshold = 500000, numOutputs = 50, satsPerOutput = 300000): Promise<void> {
    if (this.network.getNetwork() === 'regtest') return;

    // Only consider P2PKH UTXOs (Teranode rejects P2PK)
    const utxos = this.dispatchWallet.getUtxos().filter(u => u.script?.startsWith('76a914'));
    const big = utxos.filter(u => u.satoshis >= threshold);
    if (big.length === 0) return;

    const smallEnough = utxos.filter(u => u.satoshis >= satsPerOutput && u.satoshis < threshold);
    if (smallEnough.length >= numOutputs) {
      console.log(`[fanout] Skipping — already have ${smallEnough.length} suitable P2PKH UTXOs`);
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
        const lockScript = this.dispatchWallet.p2pkhLockingScript();
        // Two-pass: build, measure, set explicit change
        const buildAndSign = async (changeSats: number) => {
          const tx = new Transaction();
          tx.version = 2;
          for (let i = 0; i < picked.utxos.length; i++) {
            tx.addInput({
              sourceTransaction: picked.utxos[i].sourceTransaction,
              sourceOutputIndex: picked.utxos[i].vout,
              unlockingScriptTemplate: picked.unlockTemplates[i],
            });
          }
          for (let i = 0; i < numOutputs; i++) {
            tx.addOutput({ lockingScript: lockScript, satoshis: satsPerOutput });
          }
          tx.addOutput({ lockingScript: lockScript, satoshis: changeSats });
          await tx.sign();
          return tx;
        };
        let changeSats = picked.totalSats - (numOutputs * satsPerOutput) - 1000;
        if (changeSats < 1) throw new Error(`Fanout: insufficient funds`);
        let tx = await buildAndSign(changeSats);
        const fee = Math.ceil(tx.toHex().length / 2 * 150 / 1000) + 50;
        changeSats = picked.totalSats - (numOutputs * satsPerOutput) - fee;
        if (changeSats < 1) throw new Error(`Fanout: fee exceeds change`);
        tx = await buildAndSign(changeSats);
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

      // NOTE: We no longer bootstrap P2PK UTXOs on startup.
      // Teranode has tightened standardness policy and rejects TXs spending P2PK
      // outputs. We leave any existing P2PK UTXOs on chain as dust and operate
      // entirely from P2PKH. Any deposits to this address should be P2PKH.

      // Check for new P2PKH deposits not already in our UTXO set.
      // Verify via Arcade /tx/{txid} (no rate limits, closest to Teranode).
      // Arcade returns txStatus for real TXs, "Transaction not found" for phantoms.
      const p2pkhUtxos = await this.network.fetchUtxos(this.dispatchWallet.address);
      let newDeposits = 0;
      let newSats = 0;
      let skippedPhantom = 0;
      // Batch: group UTXOs by txid to avoid duplicate TX hex fetches
      const byTxid = new Map<string, Array<typeof p2pkhUtxos[0]>>();
      for (const u of p2pkhUtxos) {
        if (known.has(`${u.txid}:${u.vout}`)) continue;
        if (this._mempoolConflictUtxos.has(`${u.txid}:${u.vout}`)) continue;
        if (!byTxid.has(u.txid)) byTxid.set(u.txid, []);
        byTxid.get(u.txid)!.push(u);
      }

      // STEP 1: Verify each parent TX exists on Teranode via Arcade (no rate limits).
      // WoC returns UTXOs for TXs its node saw, but Teranode may never have seen them.
      // Only proceed with UTXOs whose parent TX is confirmed on Arcade.
      const VERIFY_BATCH = 20;
      const txidList = [...byTxid.keys()];
      const verifiedTxids = new Set<string>();
      for (let i = 0; i < txidList.length; i += VERIFY_BATCH) {
        const batch = txidList.slice(i, i + VERIFY_BATCH);
        const results = await Promise.allSettled(
          batch.map(async (txid) => {
            try {
              const r = await fetch(`https://arcade-eu-1.bsvb.tech/tx/${txid}`, { signal: AbortSignal.timeout(5000) });
              if (!r.ok) return { txid, exists: false };
              const j: any = await r.json();
              // Only accept if Arcade has it with a real status (not error/not found)
              const isReal = j.txStatus === 'SEEN_ON_NETWORK' || j.txStatus === 'MINED'
                || j.txStatus === 'ANNOUNCED_TO_NETWORK' || j.txStatus === 'STORED';
              if (j.error || !isReal) return { txid, exists: false };
              return { txid, exists: true };
            } catch { return { txid, exists: false }; }
          })
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.exists) {
            verifiedTxids.add(r.value.txid);
          }
        }
      }
      const phantomTxids = txidList.length - verifiedTxids.size;
      if (phantomTxids > 0) {
        console.log(`[dispatch] Arcade verification: ${verifiedTxids.size} real, ${phantomTxids} phantom TXs skipped`);
      }

      // STEP 2: Fetch source TX hex only for verified TXs (from WoC, rate-limited)
      const FETCH_BATCH = 5;
      const verifiedList = [...verifiedTxids];
      for (let i = 0; i < verifiedList.length; i += FETCH_BATCH) {
        const batch = verifiedList.slice(i, i + FETCH_BATCH);
        const results = await Promise.allSettled(
          batch.map(async (txid) => {
            try {
              const r = await fetch(`${wocBase}/tx/${txid}/hex`, { signal: AbortSignal.timeout(5000) });
              if (!r.ok) return { txid, ok: false };
              return { txid, ok: true, txHex: await r.text() };
            } catch { return { txid, ok: false }; }
          })
        );
        for (const r of results) {
          if (r.status !== 'fulfilled' || !r.value.ok) continue;
          const { txid, txHex } = r.value as { txid: string; ok: true; txHex: string };
          try {
            const sourceTx = Transaction.fromHex(txHex!);
            for (const u of byTxid.get(txid) || []) {
              const actualScript = sourceTx.outputs[u.vout]?.lockingScript?.toHex();
              if (!actualScript) continue;
              const before = this.dispatchWallet.getUtxos().length;
              this.dispatchWallet.addUtxo({
                txid: u.txid, vout: u.vout, satoshis: u.satoshis,
                script: actualScript, sourceTransaction: sourceTx,
              });
              if (this.dispatchWallet.getUtxos().length > before) {
                newDeposits++;
                newSats += u.satoshis;
                known.add(`${u.txid}:${u.vout}`);
              }
            }
          } catch {}
        }
      }
      if (newDeposits > 0 || skippedPhantom > 0) {
        console.log(`[dispatch] New deposits: ${newDeposits} UTXOs (${newSats} sats), skipped ${skippedPhantom} phantom`);
      }

      // Cache chain balance from WoC query — this is stable (doesn't flicker like memory balance)
      const chainTotal = p2pkhUtxos.reduce((s: number, u: any) => s + (u.satoshis || u.value || 0), 0);
      if (chainTotal > 0) this.lastChainBalanceSats = chainTotal;
      console.log(`[dispatch] Chain balance: ${this.lastChainBalanceSats} sats (${(this.lastChainBalanceSats/1e8).toFixed(4)} BSV), mem: ${this.dispatchWallet.getUtxos().length} UTXOs`);
    } catch (err: any) {
      console.log(`[dispatch] Deposit scan failed: ${err.message}`);
    }
  }

  /** Verify recently-broadcast wallet TXs actually landed on chain.
   *  For each TX we broadcast ≥ `minAgeMs` ago: query WoC by txid. If 404, the TX
   *  was evicted/dropped. Remove its change outputs (they're ghosts). If found,
   *  mark verified. Drops verified entries older than 30 min.
   *
   *  This is SURGICAL — it only removes UTXOs we KNOW are ghosts (parent TX missing),
   *  never false-positives like the WoC-wide prune did. */
  async verifyWalletTxs(opts: { minAgeMs?: number; maxPerRun?: number } = {}): Promise<{ checked: number; promoted: number; ghosts: number; ghostSats: number }> {
    if (this.network.getNetwork() === 'regtest') {
      // Regtest: nothing to verify, but promote all pending UTXOs immediately
      let promoted = 0;
      for (const u of this.dispatchWallet.getUtxos()) {
        if (u.pending) { this.dispatchWallet.clearPending(u.txid, u.vout); promoted++; }
      }
      return { checked: 0, promoted, ghosts: 0, ghostSats: 0 };
    }
    // DISABLED: Arcade can't verify TXs broadcast via GorillaPool, causing false ghost detection.
    // With Arcade broken and GorillaPool as primary, verification is counterproductive.
    // Just auto-promote everything.
    for (const [, rec] of this._recentWalletTxs) {
      if (!rec.verified) rec.verified = true;
    }
    return { checked: 0, promoted: 0, ghosts: 0, ghostSats: 0 };

    const minAgeMs = opts.minAgeMs ?? 2_000;
    const maxPerRun = opts.maxPerRun ?? 40;

    const now = Date.now();
    const candidates: Array<[string, { broadcastAt: number; walletOuts: number[]; verified?: boolean }]> = [];
    for (const entry of this._recentWalletTxs.entries()) {
      const [txid, rec] = entry;
      if (rec.verified) {
        if (now - rec.broadcastAt > 30 * 60 * 1000) {
          this._recentWalletTxs.delete(txid);
        }
        continue;
      }
      if (now - rec.broadcastAt >= minAgeMs) {
        candidates.push(entry);
      }
    }
    candidates.sort((a, b) => a[1].broadcastAt - b[1].broadcastAt);

    let checked = 0, promoted = 0, ghosts = 0, ghostSats = 0;
    for (const [txid, rec] of candidates.slice(0, maxPerRun)) {
      checked++;
      const age = now - rec.broadcastAt;
      try {
        // Check Arcade for TX existence. GorillaPool doesn't support /tx/{txid} lookup.
        // Arcade CAN look up TXs even when its broadcast is broken.
        let txFound = false;
        for (const ep of ['https://arcade-eu-1.bsvb.tech', 'https://arcade-us-1.bsvb.tech']) {
          try {
            const resp = await fetch(`${ep}/tx/${txid}`, { signal: AbortSignal.timeout(5000) });
            if (resp.ok) {
              const j: any = await resp.json();
              const isReal = j.txStatus === 'SEEN_ON_NETWORK' || j.txStatus === 'MINED'
                || j.txStatus === 'ANNOUNCED_TO_NETWORK' || j.txStatus === 'STORED';
              if (isReal) { txFound = true; break; }
            }
          } catch {}
        }
        if (txFound) {
          rec.verified = true;
          promoted++;
          continue;
        }
        // TX not found on ANY endpoint — it's a ghost. Remove after age threshold.
        if (age >= 120_000) { // 2 min — give GorillaPool→Arcade propagation time
          await this.withSpendLock(async () => {
            for (const vout of rec.walletOuts) {
              const utxo = this.dispatchWallet.getUtxos().find(u => u.txid === txid && u.vout === vout);
              if (utxo) {
                ghostSats += utxo.satoshis;
                this.dispatchWallet.spendUtxo(txid, vout);
                ghosts++;
              }
            }
          });
          this._recentWalletTxs.delete(txid);
          console.log(`[verify] GHOST: ${txid.slice(0,16)} not found after ${Math.round(age/1000)}s`);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 20));
    }
    return { checked, promoted, ghosts, ghostSats };
  }

  /** Prune in-memory UTXOs that the chain says are already spent.
   *  Only REMOVES — never adds. Safe to run periodically because it won't re-add
   *  ghosts that WoC reports as "unspent" but which ARC is currently spending.
   *  Preserves pending UTXOs (in-flight broadcasts) and recently-added confirmed UTXOs. */
  async pruneGhosts(opts: { minAgeMs?: number } = {}): Promise<{ removed: number; totalSats: number }> {
    if (this.network.getNetwork() === 'regtest') {
      return { removed: 0, totalSats: this.dispatchWallet.balance };
    }

    const p2pkScript = this.dispatchWallet.p2pkLockingScript().toHex();
    const p2pkUnspent = await this.network.fetchScriptUtxos?.(p2pkScript) ?? [];
    const p2pkhUnspent = await this.network.fetchUtxos(this.dispatchWallet.address);

    const chainUnspent = new Set<string>();
    for (const u of p2pkUnspent) chainUnspent.add(`${u.txid}:${u.vout}`);
    for (const u of p2pkhUnspent) chainUnspent.add(`${u.txid}:${u.vout}`);

    return await this.withSpendLock(async () => {
      const current = this.dispatchWallet.getUtxos();
      let removed = 0;
      for (const u of current) {
        if (u.pending) continue;
        if (!chainUnspent.has(`${u.txid}:${u.vout}`)) {
          this.dispatchWallet.spendUtxo(u.txid, u.vout);
          removed++;
        }
      }
      const totalSats = this.dispatchWallet.balance;
      console.log(`[prune] chain=${chainUnspent.size}, removed=${removed}, mem=${this.dispatchWallet.getUtxos().length}, balance=${(totalSats/1e8).toFixed(4)} BSV`);
      return { removed, totalSats };
    });
  }

  /** Full reconcile — removes ghosts AND adds chain UTXOs we don't know about.
   *  Use for one-shot manual sync. Do NOT run periodically (WoC lag causes ghost re-adds). */
  async reconcileFromChain(): Promise<{ added: number; removed: number; totalSats: number }> {
    if (this.network.getNetwork() === 'regtest') {
      return { added: 0, removed: 0, totalSats: this.dispatchWallet.balance };
    }
    const wocBase = this.network.getNetwork() === 'mainnet'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test';

    const p2pkScript = this.dispatchWallet.p2pkLockingScript().toHex();
    const p2pkUnspent = await this.network.fetchScriptUtxos?.(p2pkScript) ?? [];
    const p2pkhUnspent = await this.network.fetchUtxos(this.dispatchWallet.address);

    const chainSet = new Set<string>();
    for (const u of p2pkUnspent) chainSet.add(`${u.txid}:${u.vout}`);
    for (const u of p2pkhUnspent) chainSet.add(`${u.txid}:${u.vout}`);

    return await this.withSpendLock(async () => {
      const current = this.dispatchWallet.getUtxos();
      let removed = 0;
      for (const u of current) {
        if (u.pending) continue;
        if (!chainSet.has(`${u.txid}:${u.vout}`)) {
          this.dispatchWallet.spendUtxo(u.txid, u.vout);
          removed++;
        }
      }
      const have = new Set(this.dispatchWallet.getUtxos().map(u => `${u.txid}:${u.vout}`));
      let added = 0;
      for (const u of p2pkUnspent) {
        const key = `${u.txid}:${u.vout}`;
        if (have.has(key)) continue;
        try {
          const resp = await fetch(`${wocBase}/tx/${u.txid}/hex`);
          if (!resp.ok) continue;
          const sourceTx = Transaction.fromHex(await resp.text());
          this.dispatchWallet.addUtxo({
            txid: u.txid, vout: u.vout, satoshis: u.satoshis,
            script: p2pkScript, sourceTransaction: sourceTx,
          });
          added++;
        } catch { /* skip */ }
      }
      for (const u of p2pkhUnspent) {
        const key = `${u.txid}:${u.vout}`;
        if (have.has(key)) continue;
        try {
          const resp = await fetch(`${wocBase}/tx/${u.txid}/hex`);
          if (!resp.ok) continue;
          const sourceTx = Transaction.fromHex(await resp.text());
          const actualScript = sourceTx.outputs[u.vout].lockingScript!.toHex();
          this.dispatchWallet.addUtxo({
            txid: u.txid, vout: u.vout, satoshis: u.satoshis,
            script: actualScript, sourceTransaction: sourceTx,
          });
          added++;
        } catch { /* skip */ }
      }
      const totalSats = this.dispatchWallet.balance;
      console.log(`[reconcile] chain=${chainSet.size}, before=${current.length}, removed=${removed}, added=${added}, after=${this.dispatchWallet.getUtxos().length}, totalSats=${totalSats}`);
      return { added, removed, totalSats };
    });
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
  /**
   * GENESIS + FAN-OUT: creates 1 covenant (at vout 0) + N-1 fan-out P2PKH outputs.
   * The covenant script hardcodes vout=0, so only 1 covenant per TX.
   * But the fan-out outputs replenish the UTXO pool — every genesis TX feeds N-1 more.
   * Returns 1 work package (the batch concept feeds the POOL, not the agent).
   */
  // --- Pre-built genesis pool ---
  // Background loop creates genesis TXs ahead of time so agent work requests are instant.
  private _genesisPool: Array<{
    molecule: Molecule & { receptorId?: string };
    receptor: ReceptorSite;
    compiledAsm: string;
    genesisTxHex: string;
    genesisTxid: string;
  }> = [];
  private _genesisPoolTarget = 100;
  private _genesisPoolRunning = false;

  /** Start the background genesis pool filler. Call once after init.
   *  Strategy: build many genesis TXs locally (just pick UTXO + sign, NO broadcast),
   *  then batch broadcast them all in ONE /txs call. Each genesis uses a different
   *  input UTXO so none are parent-child — safe to batch. */
  startGenesisPool(): void {
    if (this._genesisPoolRunning) return;
    this._genesisPoolRunning = true;
    const fill = async () => {
      while (this._genesisPoolRunning) {
        const needed = this._genesisPoolTarget - this._genesisPool.length;
        if (needed <= 0) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // Build up to `needed` genesis TXs locally — no broadcast yet
        const built: Array<{
          tx: Transaction;
          molecule: Molecule & { receptorId?: string };
          receptor: ReceptorSite;
          compiledAsm: string;
          walletOuts: number[];
          snapshots: any[];
        }> = [];

        // Build in chunks of 20 under the lock, release between chunks for fees
        const totalBatch = Math.min(needed, 100);
        const CHUNK = 20;

        for (let chunk = 0; chunk < totalBatch; chunk += CHUNK) {
        const batchSize = Math.min(CHUNK, totalBatch - chunk);

        // Prepare molecules before taking the lock
        const mols: Array<{ molecule: Molecule & { receptorId?: string }; receptor: ReceptorSite; compiledAsm: string; numAtoms: number }> = [];
        for (let i = 0; i < batchSize; i++) {
          if (this.moleculeQueue.length === 0) {
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
          }
          const molecule = this.moleculeQueue.shift()!;
          const numAtoms = molecule.atoms.length;
          let compiledAsm = this.asmCache.get(numAtoms);
          if (!compiledAsm) { compiledAsm = getCompiledAsm(numAtoms); this.asmCache.set(numAtoms, compiledAsm); }
          const receptor = (molecule.receptorId && this.receptors.get(molecule.receptorId)) || this.receptor;
          mols.push({ molecule, receptor, compiledAsm, numAtoms });
        }

        // ONE lock acquisition: pick ALL UTXOs + build ALL genesis TXs
        try {
          const batchResult = await this.withSpendLock(async () => {
            const results: typeof built = [];
            for (const m of mols) {
              const picked = this.pickWalletUtxos(5000, 'median', 'genesis');
              if (!picked) break; // no more UTXOs

              const buildAndSign = async (changeSats: number) => {
                const tx = new Transaction();
                tx.version = 2;
                for (let j = 0; j < picked.utxos.length; j++) {
                  tx.addInput({
                    sourceTransaction: picked.utxos[j].sourceTransaction,
                    sourceOutputIndex: picked.utxos[j].vout,
                    unlockingScriptTemplate: picked.unlockTemplates[j],
                  });
                }
                tx.addOutput({ lockingScript: buildChainLockScript(m.numAtoms, 0, m.compiledAsm), satoshis: 1 });
                tx.addOutput({ lockingScript: this.dispatchWallet.p2pkhLockingScript(), satoshis: changeSats });
                await tx.sign();
                return tx;
              };
              let changeSats = picked.totalSats - 1 - 1000;
              if (changeSats < 1) continue;
              let tx = await buildAndSign(changeSats);
              const fee = Math.ceil(tx.toHex().length / 2 * 150 / 1000) + 50;
              changeSats = picked.totalSats - 1 - fee;
              if (changeSats < 1) continue;
              tx = await buildAndSign(changeSats);

              const snapshots = picked.utxos.map(u => ({ ...u }));
              for (const u of picked.utxos) this.dispatchWallet.spendUtxo(u.txid, u.vout);

              results.push({
                tx, molecule: m.molecule, receptor: m.receptor,
                compiledAsm: m.compiledAsm, walletOuts: [1], snapshots,
              });
            }
            return results;
          });
          built.push(...batchResult);
        } catch (err: any) {
          // lock failed — retry next round
        }

        if (built.length === 0) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        // Queue ALL built genesis TXs through the unified batch broadcaster.
        // They'll be combined with any pending fee TXs in the next flush (~500ms).
        console.log(`[genesis-pool] Queuing ${built.length} genesis TXs for batch broadcast...`);
        const promises = built.map(item =>
          this.queueForBatchBroadcast(item.tx, item.walletOuts, item.snapshots)
            .then(txid => ({ ok: true as const, txid, item }))
            .catch(() => ({ ok: false as const, txid: '', item }))
        );
        const results = await Promise.all(promises);

        let added = 0;
        for (const r of results) {
          if (!r.ok) continue;
          this._genesisPool.push({
            molecule: r.item.molecule,
            receptor: r.item.receptor,
            compiledAsm: r.item.compiledAsm,
            genesisTxHex: r.item.tx.toHex(),
            genesisTxid: r.txid,
          });
          added++;
        }
        console.log(`[genesis-pool] Added ${added} to pool (now ${this._genesisPool.length}/${this._genesisPoolTarget})`);

        // Yield between chunks — let fee requests get the spend lock
        await new Promise(r => setTimeout(r, 100));
        } // end chunk loop

        // Pause before next refill round
        await new Promise(r => setTimeout(r, 1000));
      }
    };
    fill().catch((e) => { console.log(`[genesis-pool] Error: ${e.message}`); this._genesisPoolRunning = false; });
    console.log(`[dispatch] Genesis pool started (target: ${this._genesisPoolTarget})`);
  }

  get genesisPoolSize(): number { return this._genesisPool.length; }

  async createWorkBatch(agentId: string, count: number): Promise<{ works?: WorkPackage[]; error?: string }> {
    const works: WorkPackage[] = [];
    for (let i = 0; i < count; i++) {
      const result = await this._assignFromPool(agentId, true);
      if (result.work) works.push(result.work);
      if (result.error && works.length === 0) return { error: result.error };
    }
    if (works.length === 0) return { error: 'No work created' };
    return { works };
  }

  async createWorkPackage(agentId: string): Promise<{ work?: WorkPackage; error?: string }> {
    return this._assignFromPool(agentId, false);
  }

  /** Pull from genesis pool (instant) or fall back to on-demand creation. */
  private async _assignFromPool(agentId: string, allowConcurrent: boolean): Promise<{ work?: WorkPackage; error?: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    if (!allowConcurrent && agent.currentWorkId) return { error: 'Agent already has work assigned' };

    if (this.startTime === 0) this.startTime = performance.now();

    // Try external queue first
    if (this.externalQueue.length > 0) {
      const ext = this.externalQueue.shift()!;
      const workId = Math.random().toString(36).slice(2, 10);
      const work: WorkPackage = {
        id: workId, agentId, molecule: ext.molecule, receptor: ext.receptor,
        compiledAsm: ext.compiledAsm, genesisTxHex: ext.genesisTxHex,
        genesisTxid: ext.genesisTxid, genesisVout: 0,
        numSteps: ext.receptor.atoms.length, status: 'assigned',
        assignedAt: new Date().toISOString(), batchId: ext.batchId,
      };
      this.work.set(workId, work);
      if (!allowConcurrent) { agent.currentWorkId = workId; agent.currentMoleculeId = ext.molecule.id; }
      agent.lastSeen = new Date().toISOString();
      this.pushEvent({ type: 'assigned', agentName: agent.name, agentId, moleculeId: ext.molecule.id });
      return { work };
    }

    // Pull from pre-built genesis pool — INSTANT, no broadcast wait
    if (this._genesisPool.length > 0) {
      const pre = this._genesisPool.shift()!;
      const workId = Math.random().toString(36).slice(2, 10);
      const work: WorkPackage = {
        id: workId, agentId, molecule: pre.molecule, receptor: pre.receptor,
        compiledAsm: pre.compiledAsm, genesisTxHex: pre.genesisTxHex,
        genesisTxid: pre.genesisTxid, genesisVout: 0,
        numSteps: pre.receptor.atoms.length, status: 'assigned',
        assignedAt: new Date().toISOString(),
      };
      this.work.set(workId, work);
      if (!allowConcurrent) { agent.currentWorkId = workId; agent.currentMoleculeId = pre.molecule.id; }
      agent.lastSeen = new Date().toISOString();
      this.pushEvent({ type: 'assigned', agentName: agent.name, agentId, moleculeId: pre.molecule.id });
      console.log(`[dispatch] Work ${workId} assigned to ${agent.name}: ${pre.molecule.id} (from pool, ${this._genesisPool.length} remaining)`);
      return { work };
    }

    // Pool empty — fall back to on-demand creation
    return this.createWorkPackageInternal(agentId, allowConcurrent);
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
        genesisVout: 0,
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
        // Two-pass build: first pass signs with a placeholder change, then we measure
        // the actual signed size, compute fee at 150 sats/kB, update change, re-sign.
        // Simple genesis: covenant at output 0, change at output 1.
        // NO inline fan-out — it amplifies ghost UTXOs (each failed genesis
        // creates 5+ ghosts instead of 1). Pool replenished by fanOutVaried.
        const buildAndSign = async (changeSats: number) => {
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
          tx.addOutput({ lockingScript: this.dispatchWallet.p2pkhLockingScript(), satoshis: changeSats });
          await tx.sign();
          return tx;
        };
        let changeSats = picked.totalSats - 1 - 1000;
        if (changeSats < 1) throw new Error(`Genesis: insufficient funds`);
        let tx = await buildAndSign(changeSats);
        const fee = Math.ceil(tx.toHex().length / 2 * 150 / 1000) + 50;
        changeSats = picked.totalSats - 1 - fee;
        if (changeSats < 1) throw new Error(`Genesis: fee exceeds funds`);
        tx = await buildAndSign(changeSats);
        return { tx, walletOuts: [1], result: null };
      }, 5000, 'median'); // Genesis: pick median UTXO (prevents deep ancestor chains)
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
        genesisVout: 0, // single genesis: covenant is always at output 0
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

    // Spot-check: re-execute and verify the score.
    // Skip if score is 999999 — that's the browser sentinel for "chain broadcast failed",
    // not an actual energy calculation. Spot-checking it would always fail.
    if (finalScore !== 999999) {
      const verified = this.spotCheckScore(work);
      if (!verified) {
        console.log(`[dispatch] SPOT CHECK FAILED for ${agent.name} on ${workId}! Score mismatch.`);
        agent.trustLevel = Math.max(0, agent.trustLevel - 1);
        this.pushEvent({ type: 'spot_check_fail', agentName: agent.name, agentId, moleculeId: work.molecule.id });
      }
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
    chainLength: number, // total TX count including genesis (was chainTxHexes.length)
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

    // Approximate chain bytes — chain TXs are ~4500 bytes each on average
    agent.totalBytes += chainLength * 4500;

    // Spot-check uses molecule/receptor from work package, not the chain hex
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
    if (alreadyBroadcast) {
      work.broadcastAt = performance.now();
      work.status = 'verified';
      agent.totalTxsBroadcast += chainLength;
      if (agent.totalPassed >= 5 && agent.trustLevel < 1) agent.trustLevel = 1;
      if (agent.totalPassed >= 20 && agent.trustLevel < 2) agent.trustLevel = 2;
      const chainSteps = chainLength - 1;
      const passReward = REWARD_BASE_SATS + (REWARD_PER_CHAIN_TX_SATS * chainSteps);
      this.payReward(agent, passReward).catch(() => {});
      this.markTested(work);
      this.pushEvent({ type: 'pass', agentName: agent.name, agentId, moleculeId: work.molecule.id, score: finalScore, rewardSats: passReward });
      this.persistState();
      console.log(`[dispatch] ${agent.name} PASS verified for ${workId} (score=${finalScore}) reward=${passReward} sats [browser-broadcast]`);
      return { ok: true, reward: passReward };
    }

    // Create fee UTXOs for the agent to broadcast the chain
    // chainLength includes genesis — fee UTXOs only needed for chain steps
    const chainSteps = chainLength - 1;
    // Estimate fee with generous margin — chain TX sizes vary widely with molecule atom count.
    // Some molecules produce ~5800 byte chain TXs; we use 6500 to be safe.
    // Overpaying ~50 sats per step is cheap insurance against "fee too low" rejections.
    const feePerStep = Math.ceil((6500 + 150) * FEE_RATE_SATS_PER_KB / 1000) + 20;

    try {
      const feeUtxos = await this.createFeeUtxos(agent.pubkey, chainSteps, feePerStep);

      const feePackage: FeePackage = {
        workId,
        utxos: feeUtxos,
      };

      work.status = 'verified';
      agent.totalTxsBroadcast += chainLength; // genesis + chain steps

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

  // --- Unified broadcast batcher ---
  // Collects TXs (genesis + fee) and broadcasts them in one /txs batch per second.
  private _bcastQueue: Array<{
    tx: Transaction;
    walletOuts: number[];
    snapshots: UTXO[];
    resolve: (txid: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private _bcastFlushRunning = false;

  /** Queue a signed TX for batch broadcast. Returns txid when batch flushes. */
  private queueForBatchBroadcast(tx: Transaction, walletOuts: number[], snapshots: UTXO[]): Promise<string> {
    return new Promise((resolve, reject) => {
      this._bcastQueue.push({ tx, walletOuts, snapshots, resolve, reject });
      this._startBcastFlush();
    });
  }

  private _startBcastFlush(): void {
    if (this._bcastFlushRunning) return;
    this._bcastFlushRunning = true;
    const flush = async () => {
      while (this._bcastQueue.length > 0) {
        // Wait 500ms to accumulate TXs from genesis pool + fee requests
        await new Promise(r => setTimeout(r, 500));
        const allQueued = this._bcastQueue.splice(0);
        if (allQueued.length === 0) continue;

        // Split into sub-batches of 25 — GorillaPool times out on large batches
        const SUB_BATCH = 10; // GorillaPool hangs on 25 — keep batches small
        for (let sb = 0; sb < allQueued.length; sb += SUB_BATCH) {
        const batch = allQueued.slice(sb, sb + SUB_BATCH);

        console.log(`[batch-bcast] Flushing ${batch.length} TXs...`);
        const batchBody = batch.map(b => ({ rawTx: b.tx.toHexEF() }));

        // Skip /txs batch endpoint — it hangs unpredictably and deadlocks everything.
        // Individual /tx broadcasts via race pattern are fast and reliable.
        let perTxResults: any[] | null = null;

        // Broadcast ALL items in parallel via race pattern (no /txs batch endpoint)
        let ok = 0, fail = 0;
        await Promise.all(batch.map(async (item) => {
          const txid = item.tx.id('hex');
          try {
            await this.network.broadcast(item.tx);
            // Add change UTXOs to wallet
            await this.withSpendLock(async () => {
              for (const idx of item.walletOuts) {
                const out = item.tx.outputs[idx];
                if (out && out.satoshis && out.satoshis > 0) {
                  this.dispatchWallet.addUtxo({
                    txid, vout: idx, satoshis: out.satoshis,
                    script: out.lockingScript!.toHex(),
                    sourceTransaction: item.tx,
                  });
                }
              }
            });
            item.resolve(txid);
            ok++;
          } catch {
            await this.withSpendLock(async () => {
              for (const snap of item.snapshots) this.dispatchWallet.addUtxo(snap);
            });
            item.reject(new Error('Broadcast failed'));
            fail++;
          }
        }));
        console.log(`[batch-bcast] ${ok} accepted, ${fail} failed`);
        } // end sub-batch loop
      }
      this._bcastFlushRunning = false;
    };
    flush().catch(() => { this._bcastFlushRunning = false; });
  }

  private async createFeeUtxos(
    agentPubkey: string, count: number, satsEach: number,
  ): Promise<FeePackage['utxos']> {
    const estFeeBytes = 35 * (count + 1) + 160;
    const estFee = Math.ceil(estFeeBytes * 150 / 1000) + 100;
    const totalNeeded = count * satsEach + estFee + 1;

    const agentPubkeyBytes = Buffer.from(agentPubkey, 'hex');
    const pubkeyHash = Hash.hash160(Array.from(agentPubkeyBytes)) as number[];
    const agentLockScript = new Script([
      { op: 0x76 }, { op: 0xa9 },
      { op: pubkeyHash.length, data: pubkeyHash },
      { op: 0x88 }, { op: 0xac },
    ]).toHex();
    const agentLock = Script.fromHex(agentLockScript);

    // Phase 1: pick + sign under lock (NO broadcast)
    const phase1 = await this.withSpendLock(async () => {
      const picked = this.pickWalletUtxos(totalNeeded, 'largest', 'fee');
      if (!picked) throw new Error(`Fee TX: No funding (need ${totalNeeded})`);
      const snapshots = picked.utxos.map(u => ({ ...u }));

      const buildAndSign = async (changeSats: number) => {
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
        tx.addOutput({ lockingScript: this.dispatchWallet.p2pkhLockingScript(), satoshis: changeSats });
        await tx.sign();
        return tx;
      };
      let changeSats = picked.totalSats - (count * satsEach) - 500;
      if (changeSats < 1) throw new Error('Fee TX: insufficient funds');
      let tx = await buildAndSign(changeSats);
      const fee = Math.ceil(tx.toHex().length / 2 * 150 / 1000) + 10;
      changeSats = picked.totalSats - (count * satsEach) - fee;
      if (changeSats < 1) throw new Error('Fee TX: fee exceeds change');
      tx = await buildAndSign(changeSats);

      for (const u of picked.utxos) this.dispatchWallet.spendUtxo(u.txid, u.vout);
      return { tx, snapshots, walletOuts: [count] };
    });

    // Phase 2: queue for batch broadcast (returns when batch flushes ~500ms later)
    const feeTxid = await this.queueForBatchBroadcast(phase1.tx, phase1.walletOuts, phase1.snapshots);

    const result: FeePackage['utxos'] = [];
    for (let i = 0; i < count; i++) {
      result.push({
        txid: feeTxid, vout: i, satoshis: satsEach,
        scriptHex: agentLockScript, sourceTxHex: phase1.tx.toHex(),
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
        const buildAndSign = async (changeSats: number) => {
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
          tx.addOutput({ lockingScript: this.dispatchWallet.p2pkhLockingScript(), satoshis: changeSats });
          await tx.sign();
          return tx;
        };
        let changeSats = picked.totalSats - rewardSats - 500;
        if (changeSats < 1) throw new Error(`Reward: insufficient funds`);
        let tx = await buildAndSign(changeSats);
        const actualSize = tx.toHex().length / 2;
        const fee = Math.ceil(actualSize * 150 / 1000) + 10;
        changeSats = picked.totalSats - rewardSats - fee;
        if (changeSats < 1) throw new Error(`Reward: fee ${fee} exceeds change`);
        tx = await buildAndSign(changeSats);
        return { tx, walletOuts: [1], result: null };
      }, rewardSats + 501, 'smallest'); // Reward: pick smallest (preserve big for fees)
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
      // CRITICAL: filter out `pending` UTXOs — they're in-memory only.
      // Pending means the parent TX broadcast hasn't confirmed yet. Persisting them
      // would create ghost UTXOs on disk if the server crashes before broadcast confirms.
      utxos: this.dispatchWallet.getUtxos()
        .filter(u => !u.pending)
        .map(u => ({
          txid: u.txid, vout: u.vout, satoshis: u.satoshis, script: u.script,
          sourceTxHex: u.sourceTransaction ? u.sourceTransaction.toHex() : '',
        }))
        .filter(u => u.sourceTxHex.length > 0),
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

    // Rolling 60-second TX rate (not session average)
    const now = Date.now();
    this._txSnapshots.push({ time: now, txs: totalTxs });
    // Drop entries older than 60s
    while (this._txSnapshots.length > 0 && now - this._txSnapshots[0].time > 60_000) {
      this._txSnapshots.shift();
    }
    let txsPerSecond = 0;
    if (this._txSnapshots.length >= 2) {
      const oldest = this._txSnapshots[0];
      const newest = this._txSnapshots[this._txSnapshots.length - 1];
      const dt = (newest.time - oldest.time) / 1000;
      if (dt > 0) txsPerSecond = (newest.txs - oldest.txs) / dt;
    }
    const avgTxsPerMol = totalProcessed > 0 ? Math.round(totalTxs / totalProcessed) : 21;

    // Time remaining estimate based on current rate
    const txsRemaining = Math.max(0, this.TX_TARGET - totalTxs);
    const etaMs = txsPerSecond > 0 ? (txsRemaining / txsPerSecond) * 1000 : 0;
    const timeRemainingMs = Math.max(0, this.MAX_RUN_MS - elapsed);

    // Wallet balance = sum of NON-pending UTXOs. Pending = optimistic change
    // outputs from in-flight broadcasts that haven't confirmed yet. Showing them
    // as "balance" is misleading and drifts up as they pile up.
    // Show TOTAL balance (confirmed + pending). Pending is real money waiting
    // for verify-tick to confirm the parent TX exists on chain.
    // Use chain balance (from WoC scan) if available — it's accurate.
    // Fall back to wallet memory balance if chain hasn't been scanned yet.
    const walletBalanceSats = this.lastChainBalanceSats > 0
      ? this.lastChainBalanceSats
      : this.dispatchWallet.balance;
    const walletUtxoCount = this.dispatchWallet.getUtxos().length;
    const pendingUtxoCount = this.dispatchWallet.pendingCount;
    const pendingBalanceSats = this.dispatchWallet.pendingBalance;

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
      genesisPool: this._genesisPool.length,
      workCreated: workItems.length,
      // Enhanced metrics
      txTarget: this.TX_TARGET,
      txsRemaining,
      etaMs,
      timeRemainingMs,
      maxRunMs: this.MAX_RUN_MS,
      walletBalanceSats,
      walletUtxoCount,
      pendingUtxoCount,
      pendingBalanceSats,
      chainBalanceSats: this.lastChainBalanceSats,
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
