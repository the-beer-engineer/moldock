/**
 * MolDock Agent Swarm — HTTP server and API routes.
 * All work is dispatched to remote agents via dispatch.ts.
 * Dashboard HTML in dashboard.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import * as regtest from './regtest.js';
import { dashboardHtml } from './dashboard.js';
import { DispatchManager } from './dispatch.js';
import { Wallet } from './wallet.js';
import { getCompiledAsm, bulkFundWalletP2PK } from './chainBuilder.js';
import { buildChainLockScript } from './genesis.js';
import { generateMolecule, generateReceptorSite, getRealMolecules } from './generate.js';
import type { Molecule, ReceptorSite } from './types.js';

const PORT = parseInt(process.env.PORT ?? '3456');

// Shared wallet for funding
const parentWallet = new Wallet(undefined, 'regtest');

// Initialize dispatch manager (deferred — compiling scripts takes ~12s)
let dispatchManager: DispatchManager | null = null;
let dispatchInitializing = false;

async function initDispatch() {
  if (dispatchManager || dispatchInitializing) return;
  dispatchInitializing = true;
  console.log('[server] Initializing dispatch manager (compiling scripts, ~10s)...');
  try {
    dispatchManager = new DispatchManager(parentWallet);
    console.log('[server] Dispatch manager ready — waiting for agents to connect');
  } catch (err: any) {
    console.log('[server] Dispatch manager init failed:', err.message);
  }
  dispatchInitializing = false;
}

// Start dispatch init in background after server is listening
setTimeout(initDispatch, 100);

// --- HTTP helpers ---
function json(res: ServerResponse, data: any, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// Helper: serialize a work package for JSON response
function serializeWork(work: any) {
  return {
    id: work.id,
    molecule: work.molecule,
    receptor: work.receptor,
    compiledAsm: work.compiledAsm,
    genesisTxHex: work.genesisTxHex,
    genesisTxid: work.genesisTxid,
    numSteps: work.numSteps,
  };
}

// --- Job state (lightweight — dispatch does the real work) ---
interface DashboardJob {
  id: string;
  status: 'preparing' | 'running' | 'completed' | 'failed';
  config: { numMolecules: number; numAtoms: number; numReceptorAtoms: number; useReal?: boolean };
  totalMolecules: number;
  genesisCreated: number;
  createdAt: string;
  error?: string;
}
const jobs = new Map<string, DashboardJob>();
let activeJobId: string | null = null;

/** Create genesis TXs and enqueue work into dispatch for remote agents */
async function enqueueJob(job: DashboardJob): Promise<void> {
  if (!dispatchManager) throw new Error('Dispatch not ready');

  const { numMolecules, numAtoms, numReceptorAtoms, useReal } = job.config;

  let molecules: Molecule[];
  let receptor: ReceptorSite;

  if (useReal) {
    const real = getRealMolecules(numMolecules);
    molecules = real.molecules;
    receptor = real.receptor;
    console.log(`[job] Using ${molecules.length} real molecules`);
  } else {
    molecules = Array.from({ length: numMolecules }, () => generateMolecule(numAtoms));
    receptor = generateReceptorSite(numReceptorAtoms);
  }

  // Pre-compile scripts for all unique atom counts
  const atomCounts = [...new Set(molecules.map(m => m.atoms.length))].sort((a, b) => a - b);
  const compiledAsmMap = new Map<number, string>();
  for (const ac of atomCounts) {
    compiledAsmMap.set(ac, getCompiledAsm(ac));
  }

  // Bulk fund genesis TXs
  console.log(`[job] Funding ${numMolecules} genesis TXs...`);
  const fundingUtxos = await bulkFundWalletP2PK(parentWallet, numMolecules, 10000);

  // Create genesis TXs
  const workItems: Array<{
    molecule: Molecule; receptor: ReceptorSite; compiledAsm: string;
    genesisTxHex: string; genesisTxid: string;
  }> = [];

  let txsSinceLastMine = 0;
  for (let i = 0; i < numMolecules; i++) {
    const mol = molecules[i];
    const utxo = fundingUtxos[i];
    const compiledAsm = compiledAsmMap.get(mol.atoms.length)!;

    const genesisTx = new Transaction();
    genesisTx.version = 2;
    genesisTx.addInput({
      sourceTransaction: utxo.sourceTransaction,
      sourceOutputIndex: utxo.vout,
      unlockingScriptTemplate: parentWallet.p2pkUnlock(utxo.satoshis, Script.fromHex(utxo.script)),
    });
    genesisTx.addOutput({ lockingScript: buildChainLockScript(mol.atoms.length, 0, compiledAsm), satoshis: 1 });
    genesisTx.addOutput({ lockingScript: parentWallet.p2pkLockingScript(), change: true });
    await genesisTx.fee(new SatoshisPerKilobyte(1));
    await genesisTx.sign();

    const genesisTxid = regtest.broadcastOnly(genesisTx);
    txsSinceLastMine++;
    job.genesisCreated++;

    workItems.push({
      molecule: mol,
      receptor,
      compiledAsm,
      genesisTxHex: genesisTx.toHex(),
      genesisTxid,
    });

    if (txsSinceLastMine >= 25) {
      regtest.mine(1);
      txsSinceLastMine = 0;
    }
  }

  if (txsSinceLastMine > 0) {
    regtest.mine(1);
  }

  // Enqueue into dispatch for remote agents to pick up
  job.status = 'running';
  dispatchManager.startTime = performance.now();
  dispatchManager.enqueueExternalWork(workItems, job.id, () => {
    job.status = 'completed';
    if (activeJobId === job.id) activeJobId = null;
    console.log(`[job] Job ${job.id} completed — all ${numMolecules} molecules processed by remote agents`);
  });

  console.log(`[job] ${numMolecules} molecules queued for remote agents (job ${job.id})`);
}

// --- Routes ---
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // POST /api/dock — start a docking job (creates genesis TXs, queues for remote agents)
  if (method === 'POST' && url.pathname === '/api/dock') {
    if (!dispatchManager) { json(res, { error: dispatchInitializing ? 'Dispatch initializing...' : 'Dispatch not available' }, 503); return; }
    if (activeJobId) { json(res, { error: 'A job is already running' }, 409); return; }
    const body = JSON.parse(await readBody(req));
    const job: DashboardJob = {
      id: randomUUID().slice(0, 8),
      status: 'preparing',
      createdAt: new Date().toISOString(),
      config: {
        numMolecules: body.numMolecules ?? 10,
        numAtoms: body.numAtoms ?? 3,
        numReceptorAtoms: body.numReceptorAtoms ?? 3,
        useReal: body.useReal ?? false,
      },
      totalMolecules: body.numMolecules ?? 10,
      genesisCreated: 0,
    };
    jobs.set(job.id, job);
    activeJobId = job.id;
    json(res, { jobId: job.id, status: 'preparing', molecules: job.totalMolecules }, 201);
    enqueueJob(job).catch(err => {
      job.status = 'failed';
      job.error = err.message;
      activeJobId = null;
      console.error('Job failed:', err);
    });
    return;
  }

  // GET /api/agents — remote agent stats for dashboard
  if (method === 'GET' && url.pathname === '/api/agents') {
    if (!dispatchManager) { json(res, []); return; }
    json(res, dispatchManager.getAgentsForDashboard());
    return;
  }

  // GET /api/stats — unified stats from dispatch
  if (method === 'GET' && url.pathname === '/api/stats') {
    if (!dispatchManager) { json(res, { status: dispatchInitializing ? 'initializing' : 'unavailable' }); return; }
    const ds = await dispatchManager.getUnifiedStats();
    const blockHeight = (() => { try { return regtest.getBlockCount(); } catch { return 0; } })();
    const activeJob = activeJobId ? jobs.get(activeJobId) : null;
    const lastJob = activeJob ?? [...jobs.values()].reverse().find(j => j.status === 'completed');

    json(res, {
      status: activeJob?.status ?? (ds.totalAgents > 0 ? 'idle' : 'waiting'),
      totalAgents: ds.totalAgents,
      activeAgents: ds.activeAgents,
      processed: ds.processed,
      passed: ds.passed,
      failed: ds.failed,
      totalTxs: ds.totalTxs,
      totalBytes: ds.totalBytes,
      totalRewards: ds.totalRewards,
      elapsedMs: ds.elapsedMs,
      txsPerSecond: ds.txsPerSecond,
      blockHeight,
      queueDepth: ds.queueDepth,
      jobId: lastJob?.id,
      totalMolecules: lastJob?.totalMolecules ?? 0,
      genesisCreated: lastJob?.genesisCreated ?? 0,
      config: lastJob?.config,
    });
    return;
  }

  // GET /api/events — dispatch events
  if (method === 'GET' && url.pathname === '/api/events') {
    if (!dispatchManager) { json(res, []); return; }
    json(res, dispatchManager.getRecentEvents().slice(-80));
    return;
  }

  // GET /api/results — ranked molecules from dispatch
  if (method === 'GET' && url.pathname === '/api/results') {
    if (!dispatchManager) { json(res, { total: 0, ranked: [] }); return; }
    const results = dispatchManager.getResults();
    const ranked = [...results].filter(r => r.passed).sort((a, b) => a.finalScore - b.finalScore);
    json(res, { total: results.length, ranked: ranked.slice(0, 50) });
    return;
  }

  // GET /api/jobs
  if (method === 'GET' && url.pathname === '/api/jobs') {
    json(res, [...jobs.values()].map(j => ({
      id: j.id, status: j.status, config: j.config, totalMolecules: j.totalMolecules,
      genesisCreated: j.genesisCreated,
    })));
    return;
  }

  // GET /api/node
  if (method === 'GET' && url.pathname === '/api/node') {
    try { json(res, { height: regtest.getBlockCount(), balance: regtest.getBalance(), status: 'connected' }); }
    catch { json(res, { status: 'disconnected' }, 503); }
    return;
  }

  // === Dispatch API for remote agents ===

  // POST /api/agent/register
  if (method === 'POST' && url.pathname === '/api/agent/register') {
    if (!dispatchManager) { json(res, { error: dispatchInitializing ? 'Dispatch initializing, please wait...' : 'Dispatch not available' }, 503); return; }
    const body = JSON.parse(await readBody(req));
    const name = body.name?.trim();
    const pubkey = body.pubkey?.trim();
    const paymail = body.paymail?.trim() || null;
    if (!name || !pubkey) { json(res, { error: 'name and pubkey required' }, 400); return; }
    const result = dispatchManager.registerAgent(name, pubkey, paymail);
    if (result.error) { json(res, { error: result.error }, 409); return; }
    json(res, { agent: result.agent }, 201);
    return;
  }

  // GET /api/agent/check-name/:name
  if (method === 'GET' && url.pathname.startsWith('/api/agent/check-name/')) {
    if (!dispatchManager) { json(res, { error: dispatchInitializing ? 'Dispatch initializing, please wait...' : 'Dispatch not available' }, 503); return; }
    const name = decodeURIComponent(url.pathname.split('/api/agent/check-name/')[1]);
    json(res, { name, available: !dispatchManager.isNameTaken(name) });
    return;
  }

  // GET /api/agent/:id/work
  if (method === 'GET' && url.pathname.match(/^\/api\/agent\/[^/]+\/work$/)) {
    if (!dispatchManager) { json(res, { error: dispatchInitializing ? 'Dispatch initializing, please wait...' : 'Dispatch not available' }, 503); return; }
    const agentId = url.pathname.split('/')[3];
    const result = await dispatchManager.createWorkPackage(agentId);
    if (result.error) { json(res, { error: result.error }, 400); return; }
    json(res, { work: serializeWork(result.work!) });
    return;
  }

  // POST /api/agent/:id/fail
  if (method === 'POST' && url.pathname.match(/^\/api\/agent\/[^/]+\/fail$/)) {
    if (!dispatchManager) { json(res, { error: dispatchInitializing ? 'Dispatch initializing, please wait...' : 'Dispatch not available' }, 503); return; }
    const agentId = url.pathname.split('/')[3];
    const body = JSON.parse(await readBody(req));
    const result = await dispatchManager.submitFail(agentId, body.workId, body.finalScore ?? 0);
    if (!result.ok) { json(res, { error: result.error }, 400); return; }
    json(res, { ok: true, nextWork: result.nextWork ? serializeWork(result.nextWork) : null });
    return;
  }

  // POST /api/agent/:id/pass
  if (method === 'POST' && url.pathname.match(/^\/api\/agent\/[^/]+\/pass$/)) {
    if (!dispatchManager) { json(res, { error: dispatchInitializing ? 'Dispatch initializing, please wait...' : 'Dispatch not available' }, 503); return; }
    const agentId = url.pathname.split('/')[3];
    const body = JSON.parse(await readBody(req));
    const result = await dispatchManager.submitPass(agentId, body.workId, body.finalScore, body.chainTxHexes ?? []);
    if (!result.ok) { json(res, { error: result.error }, 400); return; }
    json(res, { ok: true, feePackage: result.feePackage });
    return;
  }

  // POST /api/agent/:id/confirm
  if (method === 'POST' && url.pathname.match(/^\/api\/agent\/[^/]+\/confirm$/)) {
    if (!dispatchManager) { json(res, { error: dispatchInitializing ? 'Dispatch initializing, please wait...' : 'Dispatch not available' }, 503); return; }
    const agentId = url.pathname.split('/')[3];
    const body = JSON.parse(await readBody(req));
    const result = await dispatchManager.confirmBroadcast(agentId, body.workId, body.txids ?? []);
    if (!result.ok) { json(res, { error: result.error }, 400); return; }
    json(res, { ok: true, nextWork: result.nextWork ? serializeWork(result.nextWork) : null });
    return;
  }

  // GET /api/dispatch/stats (debug endpoint)
  if (method === 'GET' && url.pathname === '/api/dispatch/stats') {
    if (!dispatchManager) { json(res, { error: dispatchInitializing ? 'Dispatch initializing, please wait...' : 'Dispatch not available' }, 503); return; }
    json(res, { ...dispatchManager.getStats(), agents: dispatchManager.getAllAgents() });
    return;
  }

  // POST /api/abort
  if (method === 'POST' && url.pathname === '/api/abort') {
    activeJobId = null;
    json(res, { status: 'aborted' });
    return;
  }

  // Dashboard
  if (url.pathname === '/' || url.pathname === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboardHtml());
    return;
  }

  // Serve bundled agent file for download
  if (url.pathname === '/moldock-agent.mjs') {
    try {
      const { readFileSync } = await import('fs');
      const { dirname, join } = await import('path');
      const { fileURLToPath } = await import('url');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const agentPath = join(__dirname, '..', 'build', 'moldock-agent.mjs');
      const content = readFileSync(agentPath, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Content-Disposition': 'attachment; filename="moldock-agent.mjs"',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content);
    } catch {
      json(res, { error: 'Agent bundle not built. Run: npm run build:agent' }, 404);
    }
    return;
  }

  json(res, { error: 'Not found' }, 404);
}

// --- Start server ---
const server = createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('Request error:', err);
    json(res, { error: 'Internal error' }, 500);
  });
});

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} in use. Set PORT env var or kill existing process.`);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`MolDock Agent Swarm running at http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Download agent: http://localhost:${PORT}/moldock-agent.mjs`);
  console.log(`Dispatch API: POST /api/agent/register, GET /api/agent/:id/work`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close();
  setTimeout(() => process.exit(0), 500);
});
