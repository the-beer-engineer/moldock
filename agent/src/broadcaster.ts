import { Transaction } from '@bsv/sdk';
import { getNetwork } from './network.js';
import { config } from './config.js';

interface BroadcastResult {
  txid: string;
  status: 'success' | 'error';
  message?: string;
}

export async function broadcastTx(tx: Transaction): Promise<BroadcastResult> {
  try {
    const net = getNetwork();
    const txid = await net.broadcast(tx);
    return { txid, status: 'success' };
  } catch (err: any) {
    return {
      txid: tx.id('hex'),
      status: 'error',
      message: err.message || String(err),
    };
  }
}

export async function waitForConfirmation(txid: string, timeoutMs: number = 60000): Promise<boolean> {
  const net = getNetwork();
  const netType = net.getNetwork();
  if (netType === 'regtest') return true; // regtest mines immediately

  const wocBase = netType === 'mainnet'
    ? 'https://api.whatsonchain.com/v1/bsv/main'
    : 'https://api.whatsonchain.com/v1/bsv/test';

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${wocBase}/tx/hash/${txid}`);
      if (response.ok) {
        const data = await response.json() as any;
        if (data.confirmations > 0) return true;
      }
    } catch {
      // ignore fetch errors, retry
    }
    await sleep(config.confirmationPollMs);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
