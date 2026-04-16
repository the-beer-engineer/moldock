/**
 * Network abstraction layer for MolDock.
 * Switches between regtest (local bitcoin node) and ARC (testnet/mainnet)
 * based on NETWORK env var.
 */

import { Transaction } from '@bsv/sdk';
import { createHash } from 'crypto';
import type { UTXO } from './wallet.js';

/** Compute electrum-style script hash: sha256(script) reversed */
function scriptHashElectrum(scriptHex: string): string {
  const hash = createHash('sha256').update(Buffer.from(scriptHex, 'hex')).digest();
  return Buffer.from(hash).reverse().toString('hex');
}

export type NetworkType = 'regtest' | 'testnet' | 'mainnet';

export interface NetworkAdapter {
  /** Broadcast a single transaction, return txid */
  broadcast(tx: Transaction): Promise<string>;
  /** Broadcast raw hex, return txid */
  broadcastHex(hex: string): Promise<string>;
  /** Broadcast multiple transactions in order, return txids */
  broadcastBatch(txs: Transaction[]): Promise<string[]>;
  /** Fund a wallet address (regtest only — testnet/mainnet must be pre-funded) */
  fund(address: string, amountBsv: number): Promise<UTXO>;
  /** Fetch UTXOs for an address (mainnet/testnet: WhatsOnChain, regtest: listunspent) */
  fetchUtxos(address: string): Promise<UTXO[]>;
  /** Get wallet balance in sats */
  getBalance(address: string): Promise<number>;
  /** Get current network type */
  getNetwork(): NetworkType;
  /** Mine blocks (regtest only — no-op on testnet/mainnet) */
  mine(n?: number): Promise<void>;
  /** Get WhatsOnChain URL for a txid (empty on regtest) */
  getTxUrl(txid: string): string;
  /** Get block height (0 on testnet/mainnet if unavailable) */
  getBlockHeight(): Promise<number>;
  /** Fetch unspent UTXOs by raw script hex (for P2PK outputs) */
  fetchScriptUtxos?(scriptHex: string): Promise<UTXO[]>;
  /** Get TX history for a script hash */
  getScriptHistory?(scriptHex: string): Promise<{ tx_hash: string; height: number }[]>;
  /** Get TX history for an address */
  getAddressHistory?(address: string): Promise<{ tx_hash: string; height: number }[]>;
}

// ---------------------------------------------------------------------------
// ARC endpoints
// ---------------------------------------------------------------------------
// Arcade endpoints — requires Extended Format (EF) for broadcast.
// Ordered by observed speed (fastest first) — arcade-us-1 has been flaky under load.
const ARC_ENDPOINTS: Record<'testnet' | 'mainnet', string[]> = {
  testnet: [
    'https://arcade-testnet-us-1.bsvb.tech',
    'https://arcade-ttn-us-1.bsvb.tech',
  ],
  mainnet: [
    'https://arc.gorillapool.io/v1',
    'https://arcade-eu-1.bsvb.tech',
    'https://arcade-us-1.bsvb.tech',
  ],
};

const WOC_BASE: Record<NetworkType, string> = {
  regtest: '',
  testnet: 'https://test.whatsonchain.com/tx',
  mainnet: 'https://whatsonchain.com/tx',
};

// ---------------------------------------------------------------------------
// Regtest adapter — wraps the local bitcoin-cli node
// ---------------------------------------------------------------------------
export class RegtestAdapter implements NetworkAdapter {
  private regtest: typeof import('./regtest.js') | null = null;

  private async load() {
    if (!this.regtest) {
      this.regtest = await import('./regtest.js');
    }
    return this.regtest;
  }

  getNetwork(): NetworkType { return 'regtest'; }

  async broadcast(tx: Transaction): Promise<string> {
    const r = await this.load();
    return r.broadcastOnly(tx);
  }

  async broadcastHex(hex: string): Promise<string> {
    const r = await this.load();
    return r.sendRawTx(hex);
  }

  async broadcastBatch(txs: Transaction[]): Promise<string[]> {
    const r = await this.load();
    const txids: string[] = [];
    for (const tx of txs) {
      txids.push(r.broadcastOnly(tx));
    }
    return txids;
  }

  async fund(address: string, amountBsv: number): Promise<UTXO> {
    const r = await this.load();
    return r.fundWallet(address, amountBsv);
  }

  async fetchUtxos(_address: string): Promise<UTXO[]> {
    // On regtest, UTXOs are managed by the node wallet via fundWallet
    return [];
  }

  async getBalance(_address: string): Promise<number> {
    const r = await this.load();
    const bal = r.getBalance(); // BSV as float
    return Math.round(bal * 1e8);
  }

  async mine(n: number = 1): Promise<void> {
    const r = await this.load();
    r.mine(n);
  }

  getTxUrl(_txid: string): string { return ''; }

  async getBlockHeight(): Promise<number> {
    const r = await this.load();
    return r.getBlockCount();
  }
}

// ---------------------------------------------------------------------------
// ARC adapter — broadcasts via ARC REST API (testnet or mainnet)
// ---------------------------------------------------------------------------
export class ArcAdapter implements NetworkAdapter {
  private endpoints: string[];
  private networkType: NetworkType;
  private retries: number;
  private retryDelayMs: number;
  // Circuit breaker: tracks recent SQLITE_BUSY errors. If too many in a short
  // window, pause all broadcasts. Arcade is overloaded — hammering it makes it worse.
  private _busyCount = 0;
  private _busyWindowStart = 0;
  private _backoffUntil = 0;
  // Global concurrency limiter: only N broadcasts in flight at once.
  // Bumped to 8 — user needs 20+ tx/sec throughput.
  private _inFlight = 0;
  private _queue: Array<() => void> = [];
  private readonly MAX_CONCURRENT = 12;

  constructor(
    networkType: 'testnet' | 'mainnet',
    opts?: { retries?: number; retryDelayMs?: number },
  ) {
    this.networkType = networkType;
    this.endpoints = ARC_ENDPOINTS[networkType];
    this.retries = opts?.retries ?? 3;
    this.retryDelayMs = opts?.retryDelayMs ?? 2000;
  }

  private async acquireSlot(): Promise<void> {
    if (this._inFlight < this.MAX_CONCURRENT) {
      this._inFlight++;
      return;
    }
    await new Promise<void>(resolve => this._queue.push(resolve));
    this._inFlight++;
  }
  private releaseSlot(): void {
    this._inFlight--;
    const next = this._queue.shift();
    if (next) next();
  }
  private checkCircuitBreaker(): number {
    const now = Date.now();
    if (now < this._backoffUntil) {
      return this._backoffUntil - now;
    }
    return 0;
  }
  private recordBusy(): void {
    const now = Date.now();
    // Reset window every 10s
    if (now - this._busyWindowStart > 10_000) {
      this._busyWindowStart = now;
      this._busyCount = 0;
    }
    this._busyCount++;
    // Trip circuit breaker if >10 SQLITE_BUSY in 10s window
    if (this._busyCount > 10 && now >= this._backoffUntil) {
      this._backoffUntil = now + 15_000; // 15s global pause
      console.log(`[arc-adapter] CIRCUIT BREAKER TRIPPED — ${this._busyCount} SQLITE_BUSY in 10s, pausing broadcasts 15s`);
    }
  }

  getNetwork(): NetworkType { return this.networkType; }

  async broadcast(tx: Transaction): Promise<string> {
    // Check circuit breaker
    const backoffMs = this.checkCircuitBreaker();
    if (backoffMs > 0) {
      await sleep(backoffMs);
    }

    // Acquire a concurrency slot
    await this.acquireSlot();
    try {
      return await this._broadcastInner(tx);
    } finally {
      this.releaseSlot();
    }
  }

  /** Check if a specific TX exists on chain (via WoC). Returns:
   *  'exists' — TX is on chain / mempool
   *  'missing' — 404, not in WoC view
   *  'unknown' — couldn't query (network error, 429, etc)
   */
  private async _wocTxExists(txid: string): Promise<'exists' | 'missing' | 'unknown'> {
    const wocBase = this.networkType === 'mainnet'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test';
    try {
      const r = await fetch(`${wocBase}/tx/hash/${txid}`, { signal: AbortSignal.timeout(5000) });
      if (r.status === 200) return 'exists';
      if (r.status === 404) return 'missing';
      return 'unknown';
    } catch { return 'unknown'; }
  }

  private async _broadcastInner(tx: Transaction): Promise<string> {
    const efHex = tx.toHexEF();
    const body = Buffer.from(efHex, 'hex');
    const txid = tx.id('hex');

    // RACE: fire at ALL endpoints, resolve on FIRST success.
    // GorillaPool (~200ms) wins the race; broken Arcade endpoints don't slow us down.
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let failCount = 0;
      const total = this.endpoints.length;
      let lastErr = '';
      let mempoolConflict = false;

      for (const endpoint of this.endpoints) {
        fetch(`${endpoint}/tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body,
          signal: AbortSignal.timeout(8_000),
        }).then(async (response) => {
          const respText = await response.text();
          let respJson: any = null;
          try { respJson = JSON.parse(respText); } catch {}
          const isAccepted = response.ok && respJson?.txStatus !== 'REJECTED' && !respJson?.error;
          const errorMsg = respJson?.extraInfo || respJson?.detail || respJson?.error || respText.slice(0, 200);

          if (/mempool.conflict/i.test(errorMsg)) {
            mempoolConflict = true;
          }

          if (isAccepted && !settled) {
            settled = true;
            resolve(txid);
            return;
          }
          lastErr = errorMsg;
          failCount++;
          if (failCount >= total && !settled) {
            settled = true;
            if (mempoolConflict) {
              reject(new Error(`MEMPOOL_CONFLICT:${txid}`));
            } else {
              reject(new Error(`Broadcast failed: ${lastErr.slice(0, 150)}`));
            }
          }
        }).catch((e: any) => {
          if (e.message?.includes('MEMPOOL_CONFLICT')) mempoolConflict = true;
          failCount++;
          lastErr = e.message || 'network error';
          if (failCount >= total && !settled) {
            settled = true;
            if (mempoolConflict) {
              reject(new Error(`MEMPOOL_CONFLICT:${txid}`));
            } else {
              reject(new Error(`Broadcast failed: ${lastErr.slice(0, 150)}`));
            }
          }
        });
      }
    });
  }

  /** Broadcast multiple UNRELATED transactions in a single batch API call.
   *  Uses Arcade's POST /txs endpoint. Returns array of txids.
   *  Parent-child TXs MUST NOT be batched — use sequential broadcast() instead. */
  async broadcastBatchUnrelated(txs: Transaction[]): Promise<string[]> {
    if (txs.length === 0) return [];
    if (txs.length === 1) return [await this.broadcast(txs[0])];

    await this.acquireSlot();
    try {
      // Build JSON batch: [{rawTx: "<EF hex>"}, ...]
      const batchBody = txs.map(tx => ({ rawTx: tx.toHexEF() }));
      const txids = txs.map(tx => tx.id('hex'));

      // Try each endpoint — first success wins
      for (const endpoint of this.endpoints) {
        try {
          const resp = await fetch(`${endpoint}/txs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batchBody),
            signal: AbortSignal.timeout(15_000),
          });
          if (resp.ok) {
            return txids;
          }
          const respText = await resp.text();
          // Partial success — some TXs might have been accepted
          let respJson: any = null;
          try { respJson = JSON.parse(respText); } catch {}
          if (Array.isArray(respJson)) {
            // Per-TX status array
            const allOk = respJson.every((r: any) => r.txStatus && r.txStatus !== 'REJECTED' && !r.error);
            if (allOk) return txids;
          }
        } catch {}
      }

      // Batch failed — fall back to individual broadcasts
      console.log(`[broadcast] Batch /txs failed for ${txs.length} TXs, falling back to individual`);
      const results: string[] = [];
      for (const tx of txs) {
        results.push(await this.broadcast(tx));
      }
      return results;
    } finally {
      this.releaseSlot();
    }
  }

  async broadcastHex(hex: string): Promise<string> {
    const tx = Transaction.fromHex(hex);
    return this.broadcast(tx);
  }

  async broadcastBatch(txs: Transaction[]): Promise<string[]> {
    const txids: string[] = [];
    for (const tx of txs) {
      const txid = await this.broadcast(tx);
      txids.push(txid);
    }
    return txids;
  }

  async fund(_address: string, _amountBsv: number): Promise<UTXO> {
    throw new Error(`Cannot auto-fund on ${this.networkType}. Pre-fund the wallet manually.`);
  }

  async fetchUtxos(address: string): Promise<UTXO[]> {
    const wocBase = this.networkType === 'mainnet'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test';
    const resp = await fetch(`${wocBase}/address/${address}/unspent`);
    if (!resp.ok) throw new Error(`WoC UTXO fetch failed: ${resp.status}`);
    const data = await resp.json() as any[];
    return data.map((u: any) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      satoshis: u.value,
      script: '', // caller must fetch TX if needed
    }));
  }

  async getBalance(address: string): Promise<number> {
    const wocBase = this.networkType === 'mainnet'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test';
    const resp = await fetch(`${wocBase}/address/${address}/balance`);
    if (!resp.ok) return 0;
    const data = await resp.json() as any;
    return (data.confirmed ?? 0) + (data.unconfirmed ?? 0);
  }

  /** Fetch unspent UTXOs by script hash (for P2PK outputs not visible by address) */
  async fetchScriptUtxos(scriptHex: string): Promise<UTXO[]> {
    const wocBase = this.networkType === 'mainnet'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test';
    const scriptHash = scriptHashElectrum(scriptHex);
    const resp = await fetch(`${wocBase}/script/${scriptHash}/unspent`);
    if (!resp.ok) return [];
    const data = await resp.json() as any[];
    return data.map((u: any) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      satoshis: u.value,
      script: scriptHex,
    }));
  }

  /** Get full TX history for a script hash (count of all TXs that used this script) */
  async getScriptHistory(scriptHex: string): Promise<{ tx_hash: string; height: number }[]> {
    const wocBase = this.networkType === 'mainnet'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test';
    const scriptHash = scriptHashElectrum(scriptHex);
    const resp = await fetch(`${wocBase}/script/${scriptHash}/history`);
    if (!resp.ok) return [];
    return await resp.json() as any[];
  }

  /** Get TX history for an address */
  async getAddressHistory(address: string): Promise<{ tx_hash: string; height: number }[]> {
    const wocBase = this.networkType === 'mainnet'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test';
    const resp = await fetch(`${wocBase}/address/${address}/history`);
    if (!resp.ok) return [];
    return await resp.json() as any[];
  }

  async mine(_n?: number): Promise<void> {
    // No-op on testnet/mainnet
  }

  getTxUrl(txid: string): string {
    return `${WOC_BASE[this.networkType]}/${txid}`;
  }

  async getBlockHeight(): Promise<number> {
    try {
      const wocBase = this.networkType === 'mainnet'
        ? 'https://api.whatsonchain.com/v1/bsv/main'
        : 'https://api.whatsonchain.com/v1/bsv/test';
      const resp = await fetch(`${wocBase}/chain/info`);
      if (!resp.ok) return 0;
      const data = await resp.json() as any;
      return data.blocks ?? 0;
    } catch { return 0; }
  }
}

// ---------------------------------------------------------------------------
// Factory — creates the right adapter based on NETWORK env var
// ---------------------------------------------------------------------------
let _instance: NetworkAdapter | null = null;

export function getNetwork(): NetworkAdapter {
  if (_instance) return _instance;

  const net = (process.env.NETWORK || 'regtest') as NetworkType;

  switch (net) {
    case 'regtest':
      _instance = new RegtestAdapter();
      break;
    case 'testnet':
      _instance = new ArcAdapter('testnet');
      break;
    case 'mainnet':
      _instance = new ArcAdapter('mainnet');
      break;
    default:
      throw new Error(`Unknown NETWORK: ${net}. Use regtest|testnet|mainnet`);
  }

  console.log(`[network] Using ${net} adapter`);
  return _instance;
}

/** Reset the singleton (useful for tests) */
export function resetNetwork(): void {
  _instance = null;
}

/** Set a specific adapter instance (useful for dependency injection) */
export function setNetwork(adapter: NetworkAdapter): void {
  _instance = adapter;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
