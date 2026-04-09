import { execSync } from 'child_process';
import { Transaction, P2PKH, PrivateKey, LockingScript, Script, SatoshisPerKilobyte, Hash } from '@bsv/sdk';
import type { UTXO } from './wallet.js';

const BITCOIN_CLI = '/Users/reacher/workspace/projects/bitcoin-sv-arm64/bitcoin/bin/bitcoin-cli';
const DATA_DIR = '/Users/reacher/workspace/projects/bitcoin-sv-arm64/bitcoin-data';

function cli(cmd: string): string {
  return execSync(`${BITCOIN_CLI} -datadir=${DATA_DIR} ${cmd}`, {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
  }).trim();
}

export function getBlockCount(): number {
  return parseInt(cli('getblockcount'));
}

export function getBalance(): number {
  return parseFloat(cli('getbalance'));
}

// Generate blocks (mine)
export function mine(n: number = 1): string[] {
  const addr = cli('getnewaddress');
  const result = cli(`generatetoaddress ${n} ${addr}`);
  return JSON.parse(result);
}

// Send raw transaction hex to regtest node
export function sendRawTx(txHex: string): string {
  return cli(`sendrawtransaction ${txHex}`);
}

// Get raw transaction hex by txid
export function getRawTx(txid: string): string {
  return cli(`getrawtransaction ${txid}`);
}

// Get decoded transaction
export function decodeTx(txHex: string): any {
  return JSON.parse(cli(`decoderawtransaction ${txHex}`));
}

// Send BSV from regtest wallet to an address, returns txid
export function fundAddress(address: string, amount: number): string {
  return cli(`sendtoaddress ${address} ${amount}`);
}

// List unspent outputs for an address
export function listUnspent(address?: string, minConf: number = 1): any[] {
  const args = address ? `1 9999999 '["${address}"]'` : `${minConf}`;
  return JSON.parse(cli(`listunspent ${args}`));
}

// Fund a moldock agent wallet: send coins from regtest wallet, mine, return UTXO
export function fundWallet(address: string, amountBsv: number = 0.01): UTXO {
  const txid = fundAddress(address, amountBsv);
  mine(1); // confirm

  // Find the UTXO we just created
  const rawHex = getRawTx(txid);
  const decoded = decodeTx(rawHex);
  const sourceTx = Transaction.fromHex(rawHex);

  // Find the vout that pays to our address
  for (const vout of decoded.vout) {
    if (vout.scriptPubKey?.addresses?.includes(address)) {
      return {
        txid,
        vout: vout.n,
        satoshis: Math.round(vout.value * 1e8),
        script: vout.scriptPubKey.hex,
        sourceTransaction: sourceTx,
      };
    }
  }
  throw new Error(`Could not find output to ${address} in tx ${txid}`);
}

// Broadcast a Transaction object to regtest
export function broadcastTx(tx: Transaction): string {
  const hex = tx.toHex();
  return sendRawTx(hex);
}

// Broadcast without mining (TX stays in mempool)
export function broadcastOnly(tx: Transaction): string {
  return broadcastTx(tx);
}

// Broadcast and mine
export function broadcastAndMine(tx: Transaction): string {
  const txid = broadcastTx(tx);
  mine(1);
  return txid;
}
