import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { NetworkType } from './network.js';

// Load .env from project root (one level above agent/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenvConfig({ path: resolve(__dirname, '../../.env') });

export const config = {
  // Network — controlled by NETWORK env var (regtest|testnet|mainnet)
  network: (process.env.NETWORK || 'regtest') as NetworkType,

  // ARC endpoints (used by ArcAdapter in network.ts)
  arcEndpoints: {
    testnet: [
      'https://arcade-testnet-us-1.bsvb.tech',
      'https://arcade-ttn-us-1.bsvb.tech',
    ],
    mainnet: [
      'https://arcade-us-1.bsvb.tech',
    ],
  },

  // WhatsOnChain base URLs
  wocUrl: {
    regtest: '',
    testnet: 'https://test.whatsonchain.com',
    mainnet: 'https://whatsonchain.com',
  },

  // Script paths
  batchScriptPath: '../scripts/atomPairBatch.sx',
  chainScriptPath: '../scripts/atomChain.sx',

  // BitcoinSX compiler
  sxcPath: '/Users/reacher/workspace/projects/BitcoinSX',

  // TX parameters
  dustLimit: 1,
  feePerKb: parseInt(process.env.FEE_RATE_SATS_PER_KB || '100', 10),  // sats/kB — ARC enforces 100 sats/kB minimum

  // Agent parameters
  maxParallelChains: 10,
  broadcastRetries: 3,
  broadcastRetryDelayMs: 2000,
  confirmationPollMs: 5000,

  // Reward pricing
  rewardBaseSats: 100,           // base reward (paid even for fails)
  rewardPerChainTxSats: 10,      // additional per chain TX for passes
  // Pass reward = rewardBaseSats + (rewardPerChainTxSats × numChainTxs)
  // e.g. 20-TX chain pass = 100 + 200 = 300 sats

  // Defaults
  defaultNumAtoms: 3,  // atoms per batch (matches fixed chainBody)
};
