import { Transaction } from '@bsv/sdk';
import { config } from './config.js';

interface BroadcastResult {
  txid: string;
  status: 'success' | 'error';
  message?: string;
}

export async function broadcastTx(tx: Transaction): Promise<BroadcastResult> {
  const rawHex = tx.toHex();

  for (let attempt = 1; attempt <= config.broadcastRetries; attempt++) {
    try {
      const response = await fetch(`${config.arcUrl}/tx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from(rawHex, 'hex'),
      });

      if (response.ok) {
        const data = await response.json() as any;
        return {
          txid: data.txid || tx.id('hex'),
          status: 'success',
        };
      }

      const errorText = await response.text();

      // Don't retry on client errors (4xx) except 429
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return {
          txid: tx.id('hex'),
          status: 'error',
          message: `HTTP ${response.status}: ${errorText}`,
        };
      }

      // Server error or rate limit — retry
      if (attempt < config.broadcastRetries) {
        await sleep(config.broadcastRetryDelayMs * attempt);
      }
    } catch (err: any) {
      if (attempt < config.broadcastRetries) {
        await sleep(config.broadcastRetryDelayMs * attempt);
      } else {
        return {
          txid: tx.id('hex'),
          status: 'error',
          message: err.message || String(err),
        };
      }
    }
  }

  return {
    txid: tx.id('hex'),
    status: 'error',
    message: 'Max retries exceeded',
  };
}

export async function waitForConfirmation(txid: string, timeoutMs: number = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${config.wocUrl}/tx/hash/${txid}`);
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
