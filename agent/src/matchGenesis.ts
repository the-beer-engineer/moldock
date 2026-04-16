import { getCompiledAsm } from './chainBuilder.js';
import { buildChainLockScript } from './genesis.js';

for (let atoms = 3; atoms <= 90; atoms++) {
  try {
    const asm = getCompiledAsm(atoms);
    const lockScript = buildChainLockScript(atoms, 0, asm);
    const scriptLen = lockScript.toHex().length / 2;
    if (scriptLen === 3448 || scriptLen === 1928) {
      console.log(`MATCH: atoms=${atoms} → scriptLen=${scriptLen}`);
    }
  } catch {}
}
