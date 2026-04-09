import {
  Transaction,
  P2PKH,
  Script,
  LockingScript,
  SatoshisPerKilobyte,
  Hash,
} from '@bsv/sdk';
import type { Molecule, ReceptorSite } from './types.js';
import { Wallet } from './wallet.js';
import type { UTXO } from './wallet.js';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { generateChainSx } from './chainTemplate.js';

const SXC_DIR = '/Users/reacher/workspace/projects/BitcoinSX';

// Compile an .sx source string and return the locking script hex
export function compileSxToLockHex(sxSource: string, filename: string = 'generated.sx'): string {
  const tmpPath = `/tmp/moldock_${Date.now()}_${filename}`;
  writeFileSync(tmpPath, sxSource);

  try {
    const output = execSync(`npx tsx cli/sxc.ts compile ${tmpPath} --json`, {
      encoding: 'utf-8',
      cwd: SXC_DIR,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    });
    const result = JSON.parse(output);
    if (!result.success) {
      throw new Error(`Compile failed: ${JSON.stringify(result)}`);
    }
    // The lockingAsm contains the full locking script ASM
    // We need the hex. Build it from the recombinants or from ASM.
    // For simplicity, extract from the compiled script by re-assembling.
    return result.lockingAsm;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

// Cache the covenant body hex keyed by compiledAsm
const bodyHexCache = new Map<string, string>();

// Build a chain locking script with specific scoreInN embedded
export function buildChainLockScript(
  numAtoms: number,
  scoreIn: number,
  compiledAsm: string,
): LockingScript {
  // compiledAsm: "<scoreInN> OP_DROP <body...>"
  // Strip the placeholder prefix, convert body ASM → hex, cache it
  let cachedBodyHex = bodyHexCache.get(compiledAsm);
  if (!cachedBodyHex) {
    const parts = compiledAsm.split('OP_DROP ');
    if (parts.length < 2) {
      throw new Error('Could not find OP_DROP in compiled chain ASM');
    }
    const bodyAsm = parts.slice(1).join('OP_DROP ');
    cachedBodyHex = Script.fromASM(bodyAsm).toHex();
    bodyHexCache.set(compiledAsm, cachedBodyHex);
  }

  // Build scoreIn prefix as fixed 4-byte push (avoids MINIMALDATA for small values 1-16, -1)
  const scorePrefix = '04' + encodeScriptNumber4(scoreIn);

  const fullHex = scorePrefix + '75' + cachedBodyHex; // + OP_DROP + body
  const rawBytes = Uint8Array.from(Buffer.from(fullHex, 'hex'));
  return new LockingScript([], rawBytes, undefined, false);
}

// Encode a script number as exactly 4 bytes (signed LE), matching on-chain `4n num2bin`
function encodeScriptNumber4(n: number): string {
  const buf = Buffer.alloc(4);
  if (n !== 0) {
    const neg = n < 0;
    const abs = Math.abs(n);
    buf.writeUInt32LE(abs);
    if (neg) buf[3] |= 0x80;
  }
  return buf.toString('hex');
}

// Create genesis TX that spawns the first chain UTXO
export async function createGenesisTx(
  molecule: Molecule,
  numAtoms: number,
  compiledAsm: string,
  fundingUtxo: UTXO,
  wallet: Wallet,
): Promise<Transaction> {
  const tx = new Transaction();

  // Input: spend funding P2PK UTXO
  tx.addInput({
    sourceTransaction: fundingUtxo.sourceTransaction,
    sourceTXID: fundingUtxo.txid,
    sourceOutputIndex: fundingUtxo.vout,
    unlockingScriptTemplate: wallet.p2pkUnlock(
      fundingUtxo.satoshis,
      Script.fromHex(fundingUtxo.script),
    ),
    sequence: 0xffffffff,
  });

  // Output 0: chain UTXO with score=0
  const lockScript = buildChainLockScript(numAtoms, 0, compiledAsm);
  tx.addOutput({
    lockingScript: lockScript,
    satoshis: 1,
  });

  // Output 1: OP_RETURN with molecule metadata
  const opReturn = buildOpReturn(molecule);
  tx.addOutput({
    lockingScript: new LockingScript([], Uint8Array.from(Buffer.from(opReturn, 'hex')), undefined, false),
    satoshis: 0,
  });

  // Output 2: P2PK change back to wallet
  tx.addOutput({
    lockingScript: wallet.p2pkLockingScript(),
    change: true,
  });

  await tx.fee(new SatoshisPerKilobyte(1));
  await tx.sign();

  return tx;
}

function buildOpReturn(molecule: Molecule): string {
  const tag = Buffer.from('MOLDOCK').toString('hex');
  const molId = Buffer.from(molecule.id).toString('hex');
  const coordsStr = molecule.atoms.map(a => `${a.x},${a.y},${a.z}`).join(';');
  const coordsHash = Buffer.from(Hash.sha256(Buffer.from(coordsStr)) as number[]).toString('hex');

  // OP_FALSE OP_RETURN <pushdata MOLDOCK> <pushdata moleculeId> <pushdata coordsHash>
  const pushTag = `${tag.length / 2 < 0x4c ? (tag.length / 2).toString(16).padStart(2, '0') : '4c' + (tag.length / 2).toString(16).padStart(2, '0')}${tag}`;
  const pushId = `${molId.length / 2 < 0x4c ? (molId.length / 2).toString(16).padStart(2, '0') : '4c' + (molId.length / 2).toString(16).padStart(2, '0')}${molId}`;
  const pushHash = `20${coordsHash}`; // 32 bytes = 0x20

  return `006a${pushTag}${pushId}${pushHash}`;
}
