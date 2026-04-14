/**
 * MolDock Dispatch Agent — Autonomous bounty posting and work coordination.
 *
 * This is the "dispatch" side of the two-agent system required by the hackathon.
 * It autonomously:
 *   1. Loads its own BSV wallet (from env or generates new)
 *   2. Starts the HTTP API server for compute agent discovery
 *   3. Continuously posts bounties (genesis/covenant TXs) for molecules
 *   4. Manages work distribution, verification, and payment
 *   5. Tracks agent trust levels and earnings
 *
 * Usage:
 *   NETWORK=regtest npx tsx src/dispatchAgent.ts
 *   DISPATCH_PRIVATE_KEY=<wif> NETWORK=testnet npx tsx src/dispatchAgent.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from './wallet.js';
import { DispatchManager } from './dispatch.js';
import { getCompiledAsm, bulkFundWalletP2PK } from './chainBuilder.js';
import { buildChainLockScript, createGenesisTx } from './genesis.js';
import { getRealMolecules } from './generate.js';
import { dashboardHtml } from './dashboard.js';
import { config } from './config.js';
import type { Molecule, ReceptorSite } from './types.js';

import { getNetwork } from './network.js';

const network = getNetwork();

// --- Configuration ---
const PORT = parseInt(process.env.PORT ?? '3456');
const AUTO_QUEUE_SIZE = parseInt(process.env.AUTO_QUEUE_SIZE ?? '10'); // molecules per batch
const AUTO_QUEUE_INTERVAL_MS = parseInt(process.env.AUTO_QUEUE_INTERVAL_MS ?? '5000');

// --- Wallet ---
const wif = process.env.DISPATCH_PRIVATE_KEY;
const wallet = new Wallet(wif, config.network as any);
console.log(`\n=== MolDock Dispatch Agent ===`);
console.log(`Network: ${config.network}`);
console.log(`Wallet:  ${wallet.address}`);
console.log(`PubKey:  ${wallet.publicKeyHex}`);
console.log(`Port:    ${PORT}`);
if (!wif) console.log(`⚠  No DISPATCH_PRIVATE_KEY set — using ephemeral wallet`);

// --- Dispatch Manager ---
let dispatch: DispatchManager | null = null;
let dispatchReady = false;

async function initDispatch(): Promise<void> {
  console.log(`\n[init] Compiling covenant scripts (~10s)...`);
  dispatch = new DispatchManager(wallet);
  // Check for new deposits (UTXOs are restored from state file in constructor)
  await dispatch.scanForDeposits();
  dispatchReady = true;
  console.log(`[init] Dispatch ready — accepting compute agents on http://localhost:${PORT}`);
}

// --- Autonomous Bounty Posting ---
let autoQueueRunning = false;
let totalBountiesPosted = 0;

async function autoQueueLoop(): Promise<void> {
  if (autoQueueRunning) return;
  autoQueueRunning = true;

  console.log(`\n[auto] Starting autonomous bounty posting (${AUTO_QUEUE_SIZE} molecules every ${AUTO_QUEUE_INTERVAL_MS}ms)`);

  while (autoQueueRunning) {
    if (!dispatch) {
      await sleep(1000);
      continue;
    }

    // Auto-stop: check if run should end (24h, target reached, funds exhausted)
    const stopCheck = await dispatch.shouldStop();
    if (stopCheck.stop) {
      if (stopCheck.reason.includes('funds exhausted')) {
        // Don't permanently stop — just pause and retry (funds may arrive)
        console.log(`[auto] Pausing: ${stopCheck.reason} — will retry in 60s`);
        await sleep(60000);
        continue;
      }
      console.log(`\n[auto] RUN COMPLETE: ${stopCheck.reason}`);
      autoQueueRunning = false;
      break;
    }

    // Only queue more if the external queue is low
    const queueDepth = (await dispatch.getUnifiedStats()).queueDepth;
    if (queueDepth > AUTO_QUEUE_SIZE * 2) {
      // Plenty of work queued — wait
      await sleep(AUTO_QUEUE_INTERVAL_MS);
      continue;
    }

    try {
      await postBountyBatch(AUTO_QUEUE_SIZE);
    } catch (err: any) {
      console.error(`[auto] Bounty batch failed: ${err.message}`);
      await sleep(5000);
    }

    await sleep(AUTO_QUEUE_INTERVAL_MS);
  }
}

async function postBountyBatch(count: number): Promise<void> {
  if (!dispatch) throw new Error('Dispatch not ready');

  const real = getRealMolecules(count);
  const molecules = real.molecules;
  const receptors = real.receptors;
  const defaultReceptor = real.receptor;

  // Pre-compile ASM for all ligand atom counts (script is parameterized by ligand atoms, not receptor)
  const atomCounts = [...new Set(molecules.map(m => m.atoms.length))];
  const asmMap = new Map<number, string>();
  for (const ac of atomCounts) {
    asmMap.set(ac, getCompiledAsm(ac));
  }

  // Bulk fund genesis TXs
  const fundingUtxos = await bulkFundWalletP2PK(wallet, count, 10000);

  // Create genesis TXs
  const workItems: Array<{
    molecule: Molecule; receptor: ReceptorSite; compiledAsm: string;
    genesisTxHex: string; genesisTxid: string;
  }> = [];

  let txsSinceLastMine = 0;
  for (let i = 0; i < count; i++) {
    const mol = molecules[i];
    const utxo = fundingUtxos[i];
    const compiledAsm = asmMap.get(mol.atoms.length)!;

    // Look up the correct receptor for this molecule
    const molReceptor = ((mol as any).receptorId && receptors.get((mol as any).receptorId)) || defaultReceptor;

    const genesisTx = new Transaction();
    genesisTx.version = 2;
    genesisTx.addInput({
      sourceTransaction: utxo.sourceTransaction,
      sourceOutputIndex: utxo.vout,
      unlockingScriptTemplate: wallet.p2pkUnlock(utxo.satoshis, Script.fromHex(utxo.script)),
    });
    genesisTx.addOutput({ lockingScript: buildChainLockScript(mol.atoms.length, 0, compiledAsm), satoshis: 1 });
    genesisTx.addOutput({ lockingScript: wallet.p2pkLockingScript(), change: true });
    await genesisTx.fee(new SatoshisPerKilobyte(config.feePerKb));
    await genesisTx.sign();

    const genesisTxid = await network.broadcast(genesisTx);
    txsSinceLastMine++;

    workItems.push({
      molecule: mol,
      receptor: molReceptor,
      compiledAsm,
      genesisTxHex: genesisTx.toHex(),
      genesisTxid,
    });

    if (txsSinceLastMine >= 20) {
      await network.mine(1);
      txsSinceLastMine = 0;
    }
  }
  if (txsSinceLastMine > 0) await network.mine(1);

  // Enqueue into dispatch
  const batchId = randomUUID().slice(0, 8);
  dispatch.startTime = dispatch.startTime || performance.now();
  dispatch.enqueueExternalWork(workItems, batchId);

  totalBountiesPosted += count;
  console.log(`[auto] Posted ${count} bounties (batch ${batchId}, total: ${totalBountiesPosted})`);
}

// --- HTTP Server ---
function json(res: ServerResponse, data: any, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
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

  // --- Dashboard ---
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboardHtml());
    return;
  }

  // --- Stats ---
  if (method === 'GET' && url.pathname === '/api/stats') {
    if (!dispatch) { json(res, { status: 'initializing' }); return; }
    const ds = await dispatch.getUnifiedStats();
    let blockHeight = 0;
    try { blockHeight = await network.getBlockHeight(); } catch {}
    const stopCheck = await dispatch.shouldStop();
    json(res, {
      status: stopCheck.stop ? 'completed' : (ds.totalAgents > 0 ? 'running' : 'waiting'),
      stopReason: stopCheck.stop ? stopCheck.reason : null,
      ...ds,
      blockHeight,
      totalBountiesPosted,
      network: config.network,
      dispatchWallet: wallet.address,
    });
    return;
  }

  // --- Agents ---
  if (method === 'GET' && url.pathname === '/api/agents') {
    if (!dispatch) { json(res, []); return; }
    json(res, dispatch.getAgentsForDashboard());
    return;
  }

  if (method === 'GET' && url.pathname === '/api/events') {
    if (!dispatch) { json(res, []); return; }
    json(res, dispatch.getRecentEvents());
    return;
  }

  if (method === 'GET' && url.pathname === '/api/results') {
    if (!dispatch) { json(res, []); return; }
    json(res, dispatch.getResults());
    return;
  }

  // --- Agent Registration ---
  if (method === 'POST' && url.pathname === '/api/agent/register') {
    if (!dispatch) { json(res, { error: 'Dispatch initializing' }, 503); return; }
    const body = JSON.parse(await readBody(req));
    const result = dispatch.registerAgent(body.name, body.pubkey, body.paymail);
    if (result.error) { json(res, { error: result.error }, 400); return; }
    json(res, { agent: result.agent }, 201);
    return;
  }

  // --- Agent Name Check ---
  const nameCheckMatch = url.pathname.match(/^\/api\/agent\/check-name\/(.+)$/);
  if (method === 'GET' && nameCheckMatch) {
    if (!dispatch) { json(res, { available: true }); return; }
    json(res, { available: !dispatch.isNameTaken(decodeURIComponent(nameCheckMatch[1])) });
    return;
  }

  // --- Agent Work ---
  const agentWorkMatch = url.pathname.match(/^\/api\/agent\/([^/]+)\/work$/);
  if (method === 'GET' && agentWorkMatch) {
    if (!dispatch) { json(res, { error: 'Dispatch initializing' }, 503); return; }
    const agentId = agentWorkMatch[1];
    const result = await dispatch.createWorkPackage(agentId);
    if (result.error) { json(res, { error: result.error }, 400); return; }
    json(res, { work: serializeWork(result.work!) });
    return;
  }

  // --- Agent Submit Fail ---
  const failMatch = url.pathname.match(/^\/api\/agent\/([^/]+)\/fail$/);
  if (method === 'POST' && failMatch) {
    if (!dispatch) { json(res, { error: 'Dispatch initializing' }, 503); return; }
    const agentId = failMatch[1];
    const body = JSON.parse(await readBody(req));
    const result = await dispatch.submitFail(agentId, body.workId, body.finalScore);
    if (!result.ok) { json(res, { error: result.error }, 400); return; }
    json(res, {
      ok: true,
      reward: result.reward,
      nextWork: result.nextWork ? serializeWork(result.nextWork) : null,
    });
    return;
  }

  // --- Agent Submit Pass ---
  const passMatch = url.pathname.match(/^\/api\/agent\/([^/]+)\/pass$/);
  if (method === 'POST' && passMatch) {
    if (!dispatch) { json(res, { error: 'Dispatch initializing' }, 503); return; }
    const agentId = passMatch[1];
    const body = JSON.parse(await readBody(req));
    const result = await dispatch.submitPass(agentId, body.workId, body.finalScore, body.chainTxHexes ?? [], body.alreadyBroadcast === true);
    if (!result.ok) { json(res, { error: result.error }, 400); return; }
    json(res, { ok: true, reward: result.reward, feePackage: result.feePackage });
    return;
  }

  // --- Agent Confirm Broadcast ---
  const confirmMatch = url.pathname.match(/^\/api\/agent\/([^/]+)\/confirm$/);
  if (method === 'POST' && confirmMatch) {
    if (!dispatch) { json(res, { error: 'Dispatch initializing' }, 503); return; }
    const agentId = confirmMatch[1];
    const body = JSON.parse(await readBody(req));
    const result = await dispatch.confirmBroadcast(agentId, body.workId, body.txids ?? []);
    if (!result.ok) { json(res, { error: result.error }, 400); return; }
    json(res, {
      ok: true,
      nextWork: result.nextWork ? serializeWork(result.nextWork) : null,
    });
    return;
  }

  // --- Manual Dock (dashboard button) ---
  if (method === 'POST' && url.pathname === '/api/dock') {
    if (!dispatch) { json(res, { error: 'Dispatch initializing' }, 503); return; }
    const body = JSON.parse(await readBody(req));
    const count = body.numMolecules ?? 10;
    try {
      await postBountyBatch(count);
      json(res, { ok: true, posted: count });
    } catch (err: any) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // --- Node Info ---
  if (method === 'GET' && url.pathname === '/api/node') {
    try {
      const height = await network.getBlockHeight();
      json(res, { status: 'connected', height, network: config.network });
    } catch {
      json(res, { status: 'disconnected', network: config.network });
    }
    return;
  }

  // --- Broadcast forwarder (browser agents can't reach bitcoind on regtest due to CORS) ---
  if (method === 'POST' && url.pathname === '/api/broadcast') {
    try {
      const body = JSON.parse(await readBody(req));
      const txHex: string | undefined = body.txHex;
      const txHexes: string[] | undefined = body.txHexes;

      if (txHexes && Array.isArray(txHexes)) {
        const txids: string[] = [];
        const errors: Array<{ index: number; error: string }> = [];
        let backoff = false;
        for (let i = 0; i < txHexes.length; i++) {
          try {
            const txid = await network.broadcastHex(txHexes[i]);
            txids.push(txid);
          } catch (err: any) {
            const msg = err.message || '';
            if (/already.known|txn.already|duplicate/i.test(msg)) {
              txids.push('(already-known)');
              continue;
            }
            if (/too.long.mempool.chain|mempool.full|chain.too.long|limit.?ancestor|limit.?descendant/i.test(msg)) {
              backoff = true;
              errors.push({ index: i, error: 'mempool-chain-limit' });
              break;
            }
            errors.push({ index: i, error: msg });
            break;
          }
        }
        json(res, { ok: errors.length === 0, txids, errors, backoff });
        return;
      }

      if (!txHex || typeof txHex !== 'string') {
        json(res, { error: 'Missing txHex or txHexes' }, 400);
        return;
      }
      const txid = await network.broadcastHex(txHex);
      json(res, { ok: true, txid });
    } catch (err: any) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  // --- Discovery endpoint (compute agents find dispatch) ---
  if (method === 'GET' && url.pathname === '/api/discover') {
    json(res, {
      service: 'moldock-dispatch',
      version: '1.0.0',
      network: config.network,
      dispatchPubkey: wallet.publicKeyHex,
      dispatchAddress: wallet.address,
      endpoints: {
        register: '/api/agent/register',
        work: '/api/agent/:id/work',
        submitPass: '/api/agent/:id/pass',
        submitFail: '/api/agent/:id/fail',
        confirmBroadcast: '/api/agent/:id/confirm',
      },
    });
    return;
  }

  // --- Scan for new funding UTXOs ---
  if (method === 'POST' && url.pathname === '/api/scan-funding') {
    try {
      // Scan for new P2PKH deposits, then return balance from persisted UTXO set
      if (dispatch) await dispatch.scanForDeposits();
      const balance = dispatch ? (await dispatch.getUnifiedStats()).walletBalanceSats : 0;
      json(res, { balance, address: wallet.address, utxos: dispatch ? (await dispatch.getUnifiedStats()).walletUtxoCount : 0 });
    } catch (err: any) {
      json(res, { balance: 0, address: wallet.address, error: err.message });
    }
    return;
  }

  // 404
  json(res, { error: 'Not found' }, 404);
}

// --- Start ---
const server = createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('[server] Error:', err.message);
    json(res, { error: 'Internal error' }, 500);
  });
});

server.listen(PORT, async () => {
  console.log(`\n[server] Listening on http://localhost:${PORT}`);
  console.log(`[server] Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`[server] Discovery: http://localhost:${PORT}/api/discover`);

  // Initialize dispatch (compiles scripts)
  await initDispatch();

  // Start autonomous bounty posting
  autoQueueLoop();

  // Regtest-only: auto-mine ticker. Drains mempool every 3s so browser-broadcast
  // chain TXs never pile up past BSV's ancestor threshold. On testnet/mainnet ARC
  // handles this automatically.
  if (config.network === 'regtest') {
    setInterval(async () => {
      try {
        const regtest = await import('./regtest.js');
        const mempool = regtest.getRawMempool();
        if (mempool.length > 0) {
          regtest.mine(1);
        }
      } catch {
        // non-fatal — node might be briefly unavailable
      }
    }, 3000);
    console.log(`[server] Regtest auto-mine ticker enabled (3s)`);
  }

  // Chain verification ticker. Every 15s, scan recently verified works and re-broadcast
  // any whose head TX has been dropped from the node's mempool without being mined.
  // This is the "trust layer" — even though browsers broadcast directly, dispatch has
  // the full chain hex and can replay it if anything goes missing.
  setInterval(async () => {
    if (!dispatch) return;
    try {
      const result = await dispatch.verifyAndRebroadcastRecent({ ageMsMin: 8000, maxPerRun: 30 });
      if (result.rebroadcast > 0 || result.dropped > 0) {
        console.log(`[verify] checked=${result.checked} rebroadcast=${result.rebroadcast} dropped=${result.dropped}`);
      }
    } catch (err: any) {
      console.error(`[verify] error: ${err.message}`);
    }
  }, 15000);
  console.log(`[server] Chain verification ticker enabled (15s)`);
});

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
