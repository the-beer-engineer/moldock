import { PrivateKey, P2PKH, Transaction, LockingScript, UnlockingScript, Hash, Utils, TransactionSignature, Script } from '@bsv/sdk';

export type Network = 'mainnet' | 'testnet' | 'regtest';

export interface UTXO {
  txid: string;
  vout: number;
  satoshis: number;
  script: string;
  sourceTransaction?: Transaction;
  /** If true, this UTXO's parent TX broadcast hasn't confirmed yet.
   *  Usable for picking in-memory, but excluded from disk persistence
   *  so a crash/restart doesn't leave ghost UTXOs on disk. */
  pending?: boolean;
}

function toNetworkAddress(pubKeyHash: number[], network: Network): string {
  const versionByte = network === 'mainnet' ? 0x00 : 0x6f;
  const payload = [versionByte, ...pubKeyHash];
  const checksum = (Hash.sha256(Hash.sha256(payload)) as number[]).slice(0, 4);
  return Utils.toBase58([...payload, ...checksum]);
}

export class Wallet {
  readonly privateKey: PrivateKey;
  readonly address: string;       // network-appropriate address
  readonly mainnetAddress: string;
  readonly pubKeyHash: string;
  readonly network: Network;
  private utxos: UTXO[] = [];
  /** When each pending UTXO was first added — used to expire stale pending */
  private pendingAt = new Map<string, number>();
  /** Diagnostic: count of mutation events */
  public _stats = {
    adds: 0,
    addsSkippedDupe: 0,
    spends: 0,
    spendsMissed: 0,
    clearPendingSuccess: 0,
    clearPendingMissed: 0,
  };

  /** Callbacks for UTXO changes — used to persist wallet state */
  onSpend?: (txid: string, vout: number) => void;
  onAdd?: (utxo: UTXO) => void;

  constructor(wif?: string, network: Network = 'regtest') {
    this.privateKey = wif ? PrivateKey.fromWif(wif) : PrivateKey.fromRandom();
    this.network = network;
    this.mainnetAddress = this.privateKey.toAddress();
    const pubKeyBuf = this.privateKey.toPublicKey().encode(true) as number[];
    const hashBuf = Hash.hash160(pubKeyBuf) as number[];
    this.pubKeyHash = Buffer.from(hashBuf).toString('hex');
    this.address = toNetworkAddress(hashBuf, network);
  }

  get publicKeyHex(): string {
    return this.privateKey.toPublicKey().toString();
  }

  addUtxo(utxo: UTXO) {
    // Dedup: if we already have this txid:vout, don't add again.
    const exists = this.utxos.find(u => u.txid === utxo.txid && u.vout === utxo.vout);
    if (exists) {
      this._stats.addsSkippedDupe++;
      if (exists.pending && !utxo.pending) {
        exists.pending = false;
        this.pendingAt.delete(`${utxo.txid}:${utxo.vout}`);
      }
      return;
    }
    this.utxos.push(utxo);
    this._stats.adds++;
    if (utxo.pending) {
      this.pendingAt.set(`${utxo.txid}:${utxo.vout}`, Date.now());
    }
    this.onAdd?.(utxo);
  }

  addUtxos(utxos: UTXO[]) {
    for (const u of utxos) this.addUtxo(u);
  }

  getUtxos(): UTXO[] {
    return [...this.utxos];
  }

  // Remove a spent UTXO
  spendUtxo(txid: string, vout: number) {
    const before = this.utxos.length;
    this.utxos = this.utxos.filter(u => !(u.txid === txid && u.vout === vout));
    if (this.utxos.length === before) {
      this._stats.spendsMissed++;
    } else {
      this._stats.spends++;
    }
    this.pendingAt.delete(`${txid}:${vout}`);
    this.onSpend?.(txid, vout);
  }

  // Clear the pending flag on a UTXO (called after its parent TX broadcast confirms)
  // Returns true if found-and-cleared, false otherwise (so callers can track leaks).
  clearPending(txid: string, vout: number): boolean {
    const u = this.utxos.find(x => x.txid === txid && x.vout === vout);
    if (u && u.pending) {
      u.pending = false;
      this.pendingAt.delete(`${txid}:${vout}`);
      this.onAdd?.(u);
      this._stats.clearPendingSuccess++;
      return true;
    }
    this._stats.clearPendingMissed++;
    return false;
  }

  /** Does this utxo exist in the wallet right now? */
  hasUtxo(txid: string, vout: number): boolean {
    return this.utxos.some(u => u.txid === txid && u.vout === vout);
  }

  get balance(): number {
    return this.utxos.reduce((sum, u) => sum + u.satoshis, 0);
  }

  /** Spendable balance = non-pending UTXOs only. This is what the user "has". */
  get spendableBalance(): number {
    return this.utxos
      .filter(u => !u.pending)
      .reduce((sum, u) => sum + u.satoshis, 0);
  }

  /** Count of pending (optimistic) UTXOs — parent TX broadcast not yet confirmed */
  get pendingCount(): number {
    return this.utxos.filter(u => u.pending).length;
  }

  /** Sum of satoshis in pending UTXOs */
  get pendingBalance(): number {
    return this.utxos
      .filter(u => u.pending)
      .reduce((sum, u) => sum + u.satoshis, 0);
  }

  /** Drop pending UTXOs added more than `ttlMs` ago. Returns dropped count+sats. */
  sweepStalePending(ttlMs: number): { count: number; sats: number } {
    const now = Date.now();
    const stale = new Set<string>();
    for (const [k, t] of this.pendingAt.entries()) {
      if (now - t > ttlMs) stale.add(k);
    }
    if (stale.size === 0) return { count: 0, sats: 0 };
    let sats = 0;
    this.utxos = this.utxos.filter(u => {
      const k = `${u.txid}:${u.vout}`;
      if (u.pending && stale.has(k)) {
        sats += u.satoshis;
        return false;
      }
      return true;
    });
    for (const k of stale) this.pendingAt.delete(k);
    return { count: stale.size, sats };
  }

  // Build a P2PKH locking script for this wallet (standard address-based output)
  p2pkhLockingScript(): LockingScript {
    return new P2PKH().lock(this.address);
  }

  // P2PKH unlocking script template for @bsv/sdk Transaction.sign()
  p2pkhUnlock(
    sourceSatoshis?: number,
    lockingScript?: Script,
  ) {
    return new P2PKH().unlock(
      this.privateKey, 'all', false,
      sourceSatoshis, lockingScript,
    );
  }

  // Legacy aliases — P2PK (raw pubkey, no hash). Used only by covenant chain internals.
  p2pkLockingScript(): LockingScript {
    const pubKeyBytes = this.privateKey.toPublicKey().encode(true) as number[];
    return new LockingScript([
      { op: pubKeyBytes.length, data: pubKeyBytes },
      { op: 0xac }, // OP_CHECKSIG
    ]);
  }

  p2pkUnlock(
    sourceSatoshis?: number,
    lockingScript?: Script,
  ): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
    estimateLength: () => Promise<number>;
  } {
    const privateKey = this.privateKey;
    return {
      sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
        const signatureScope = TransactionSignature.SIGHASH_FORKID | TransactionSignature.SIGHASH_ALL;
        const input = tx.inputs[inputIndex];
        const otherInputs = tx.inputs.filter((_, i) => i !== inputIndex);
        const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex');
        if (!sourceTXID) throw new Error('sourceTXID or sourceTransaction required');
        const sats = sourceSatoshis ?? input.sourceTransaction?.outputs[input.sourceOutputIndex].satoshis;
        if (sats == null) throw new Error('sourceSatoshis or sourceTransaction required');
        const lockScript = lockingScript ?? input.sourceTransaction?.outputs[input.sourceOutputIndex].lockingScript;
        if (!lockScript) throw new Error('lockingScript or sourceTransaction required');

        const preimage = TransactionSignature.format({
          sourceTXID,
          sourceOutputIndex: input.sourceOutputIndex,
          sourceSatoshis: sats,
          transactionVersion: tx.version,
          otherInputs,
          inputIndex,
          outputs: tx.outputs,
          inputSequence: input.sequence!,
          subscript: lockScript,
          lockTime: tx.lockTime,
          scope: signatureScope,
        });

        const rawSig = privateKey.sign(Hash.sha256(preimage) as number[]);
        const sig = new TransactionSignature(rawSig.r, rawSig.s, signatureScope);
        const sigBytes = sig.toChecksigFormat();
        return new UnlockingScript([
          { op: sigBytes.length, data: sigBytes },
        ]);
      },
      estimateLength: async () => 74,
    };
  }

  // Convenience alias
  lockingScript(): LockingScript {
    return this.p2pkhLockingScript();
  }

  toJSON() {
    return {
      wif: this.privateKey.toWif(),
      address: this.address,
      pubKeyHash: this.pubKeyHash,
      balance: this.balance,
      utxoCount: this.utxos.length,
    };
  }
}
