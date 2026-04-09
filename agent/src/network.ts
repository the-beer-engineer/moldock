/**
 * Network abstraction layer for MolDock.
 * Switches between regtest (local bitcoin node) and ARC (testnet/mainnet)
 * based on NETWORK env var.
 */

import { Transaction } from '@bsv/sdk';
import type { UTXO } from './wallet.js';

export type NetworkType = 'regtest' | 'testnet' | 'mainnet';

export interface NetworkAdapter {
  /** Broadcast a single transaction, return txid */
  broadcast(tx: Transaction): Promise<string>;
  /** Broadcast multiple transactions in order, return txids */
  broadcastBatch(txs: Transaction[]): Promise<string[]>;
  /** Fund a wallet address (regtest only — testnet/mainnet must be pre-funded) */
  fund(address: string, amountBsv: number): Promise<UTXO>;
  /** Get current network type */
  getNetwork(): NetworkType;
  /** Mine blocks (regtest only — no-op on testnet/mainnet) */
  mine(n?: number): Promise<void>;
  /** Get WhatsOnChain URL for a txid (empty on regtest) */
  getTxUrl(txid: string): string;
}

// ---------------------------------------------------------------------------
// ARC endpoints
// ---------------------------------------------------------------------------
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

  async mine(n: number = 1): Promise<void> {
    const r = await this.load();
    r.mine(n);
  }

  getTxUrl(_txid: string): string { return ''; }
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
    const rawHex = tx.toHex();
    const body = Buffer.from(rawHex, 'hex');

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      for (const endpoint of this.endpoints) {
        try {
          const response = await fetch(`${endpoint}/v1/tx`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body,
          });

          if (response.ok) {
            const data = await response.json() as any;
            return data.txid || tx.id('hex');
          }

          const errorText = await response.text();

          // Don't retry on client errors (4xx) except 429 (rate limit)
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new Error(`ARC ${response.status}: ${errorText}`);
          }
        } catch (err: any) {
          if (err.message?.startsWith('ARC 4')) throw err; // don't retry client errors
          if (attempt === this.retries) {
            throw new Error(`ARC broadcast failed after ${this.retries} attempts: ${err.message}`);
          }
        }
      }
      await sleep(this.retryDelayMs * attempt);
    }

    throw new Error('ARC broadcast: max retries exceeded');
  }

  async broadcastBatch(txs: Transaction[]): Promise<string[]> {
    // ARC supports batch via POST /v1/txs
    // Each TX in the batch may depend on the previous one (covenant chain)
    // Submit them in sequence for safety
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

  async mine(_n?: number): Promise<void> {
    // No-op on testnet/mainnet — TXs confirm via miners
  }

  getTxUrl(txid: string): string {
    return `${WOC_BASE[this.networkType]}/${txid}`;
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
