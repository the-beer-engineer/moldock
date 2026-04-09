import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

interface CompileResult {
  lockingAsm: string;
  unlockingAsm: string;
  lockArgs: string[];
  unlockArgs: string[];
  lockOps: any[];
  unlockOps: any[];
  lockingRecombinants: any[];
  unlockingRecombinants: any[];
  error?: { msg: string; line?: number };
}

let SxCompiler: any = null;

async function getCompiler() {
  if (!SxCompiler) {
    const mod = await import(join(config.sxcPath, 'src/sx/src/compiler.ts'));
    SxCompiler = mod.SxCompiler;
  }
  return SxCompiler;
}

function loadStdLib(): { name: string; id: string; data: string } {
  const data = readFileSync(join(config.sxcPath, 'src/sx/lib/std.sxLib'), 'utf-8');
  return { name: 'std.sxLib', id: 'stdlib', data };
}

export async function compileSxFile(sxPath: string): Promise<CompileResult> {
  const Compiler = await getCompiler();
  const mainData = readFileSync(sxPath, 'utf-8');
  const mainName = sxPath.split('/').pop()!;

  const files = [
    { name: mainName, id: 0, data: mainData },
    loadStdLib(),
  ];

  const compiler = new Compiler();
  const result = await compiler.compile(mainName, files);

  if (result.error) {
    throw new Error(`Compile error in ${mainName}: ${result.error.msg} at line ${result.error.line}`);
  }

  return result;
}

export async function compileBatchScript(): Promise<CompileResult> {
  const sxPath = join(import.meta.dirname || '.', config.batchScriptPath);
  return compileSxFile(sxPath);
}

export async function compileChainScript(): Promise<CompileResult> {
  const sxPath = join(import.meta.dirname || '.', config.chainScriptPath);
  return compileSxFile(sxPath);
}
