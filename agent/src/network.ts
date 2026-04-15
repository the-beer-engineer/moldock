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
// GorillaPool ARC accepts raw but never relays to miners; Arcade with EF works.
const ARC_ENDPOINTS: Record<'testnet' | 'mainnet', string[]> = {
  testnet: [
    'https://arcade-testnet-us-1.bsvb.tech',
    'https://arcade-ttn-us-1.bsvb.tech',
  ],
  mainnet: [
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

  constructor(
    networkType: 'testnet' | 'mainnet',
    opts?: { retries?: number; retryDelayMs?: number },
  ) {
    this.networkType = networkType;
    this.endpoints = ARC_ENDPOINTS[networkType];
    this.retries = opts?.retries ?? 3;
    this.retryDelayMs = opts?.retryDelayMs ?? 2000;
  }

  getNetwork(): NetworkType { return this.networkType; }

  async broadcast(tx: Transaction): Promise<string> {
    // Arcade requires Extended Format (EF) — includes source TX data inline.
    const efHex = tx.toHexEF();
    const body = Buffer.from(efHex, 'hex');
    const TIMEOUT_MS = 15000; // 15s per attempt
    const MAX_ATTEMPTS = 8;   // aggressive retry on 5xx (SQLITE_BUSY etc.)

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      for (const endpoint of this.endpoints) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const response = await fetch(`${endpoint}/tx`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body,
            signal: controller.signal,
          });
          clearTimeout(timer);

          if (response.ok) {
            const data = await response.json() as any;
            return data.txid || tx.id('hex');
          }

          const errorText = await response.text();

          // 4xx client errors (except 429) — don't retry, throw immediately
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new Error(`Arcade ${response.status}: ${errorText}`);
          }

          // 5xx / 429 — retry with backoff
          if (attempt < MAX_ATTEMPTS) {
            const waitMs = 200 + Math.random() * 500 * Math.pow(2, attempt - 1);
            await sleep(Math.min(waitMs, 5000));
            continue;
          }
          throw new Error(`Arcade ${response.status}: ${errorText}`);
        } catch (err: any) {
          clearTimeout(timer);
          if (err.message?.startsWith('Arcade 4')) throw err;
          if (attempt === MAX_ATTEMPTS) {
            throw new Error(`Arcade broadcast failed after ${MAX_ATTEMPTS} attempts: ${err.message}`);
          }
          // Network error / timeout — retry
          const waitMs = 200 + Math.random() * 500 * Math.pow(2, attempt - 1);
          await sleep(Math.min(waitMs, 5000));
        }
      }
    }

    throw new Error('Arcade broadcast: max retries exceeded');
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
