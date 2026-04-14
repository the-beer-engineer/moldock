import { PrivateKey, P2PKH, Transaction, LockingScript, UnlockingScript, Hash, Utils, TransactionSignature, Script } from '@bsv/sdk';

export type Network = 'mainnet' | 'testnet' | 'regtest';

export interface UTXO {
  txid: string;
  vout: number;
  satoshis: number;
  script: string;
  sourceTransaction?: Transaction;
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

  /** Callback fired on every spendUtxo — used to persist spent outpoints */
  onSpend?: (txid: string, vout: number) => void;

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
    this.utxos.push(utxo);
  }

  addUtxos(utxos: UTXO[]) {
    this.utxos.push(...utxos);
  }

  getUtxos(): UTXO[] {
    return [...this.utxos];
  }

  // Remove a spent UTXO
  spendUtxo(txid: string, vout: number) {
    this.utxos = this.utxos.filter(u => !(u.txid === txid && u.vout === vout));
    this.onSpend?.(txid, vout);
  }

  get balance(): number {
    return this.utxos.reduce((sum, u) => sum + u.satoshis, 0);
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
