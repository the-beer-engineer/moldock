import { Transaction } from '@bsv/sdk';

// Use a known TX hex from our state to verify id() format
const fs = await import('fs');
const state = JSON.parse(fs.readFileSync('../.moldock-state.json', 'utf-8'));
const utxo = state.utxos[0];

const tx = Transaction.fromHex(utxo.sourceTxHex);
const computedId = tx.id('hex');
const stateId = utxo.txid;

console.log('State TXID:   ', stateId);
console.log('Computed id(): ', computedId);
console.log('Match:', computedId === stateId);
