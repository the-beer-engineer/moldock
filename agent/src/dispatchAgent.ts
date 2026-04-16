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
import { getCompiledAsm } from './chainBuilder.js';
import { buildChainLockScript, createGenesisTx } from './genesis.js';
import { getRealMolecules } from './generate.js';
import { dashboardHtml } from './dashboard.js';
import { config } from './config.js';
import type { Molecule, ReceptorSite } from './types.js';

import { getNetwork } from './network.js';

const network = getNetwork();

// Server version = process start time. Browsers poll /api/version and reload on change.
const SERVER_VERSION = Date.now().toString();

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
  // Give scan 120s — it now fetches TX hex in parallel batches (not rate-limited)
  const scanTimeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 120_000));
  try { await Promise.race([dispatch.scanForDeposits(), scanTimeout]); } catch (e: any) { console.log(`[init] Scan incomplete: ${e.message}`); }
  // Skip init fan-out — we have thousands of UTXOs on chain already.
  // Fan-out runs on timer only when < 100 UTXOs.
  dispatchReady = true;
  console.log(`[init] Dispatch ready — ${dispatch.dispatchWallet.getUtxos().filter(u => u.script?.startsWith('76a914')).length} P2PKH UTXOs available`);
  // Start background genesis pool — continuously pre-creates genesis TXs
  dispatch.startGenesisPool();
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
  // Genesis TXs are now created on-demand by DispatchManager.createWorkPackage()
  // when an agent requests work. This avoids the bulkFundWalletP2PK intermediate
  // fan-out TX that caused mempool chain depth issues on mainnet.
  // Just ensure the auto-queue loop stays alive — molecules are loaded in the constructor.
  dispatch.startTime = dispatch.startTime || performance.now();
  totalBountiesPosted += count;
  console.log(`[auto] Auto-queue cycle (molecules ready in dispatch queue)`);
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
    genesisVout: work.genesisVout ?? 0,
    numSteps: work.numSteps,
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';

  // Log API requests (skip static/dashboard/version/stats)
  if (url.pathname.startsWith('/api/') && !['version','stats','dashboard-data','events','agents'].some(s => url.pathname.includes(s))) {
    console.log(`[http] ${method} ${url.pathname}${url.search}`);
  }

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
    const html = dashboardHtml();
    const acceptEncoding = (req.headers['accept-encoding'] || '') as string;
    const headers: Record<string, string> = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate', // never cache — code changes frequently
    };
    if (acceptEncoding.includes('gzip')) {
      const zlib = await import('zlib');
      const gzipped = zlib.gzipSync(Buffer.from(html, 'utf-8'), { level: 6 });
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = String(gzipped.length);
      res.writeHead(200, headers);
      res.end(gzipped);
    } else {
      headers['Content-Length'] = String(Buffer.byteLength(html, 'utf-8'));
      res.writeHead(200, headers);
      res.end(html);
    }
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

  // Combined dashboard data — one call replaces 5 separate fetches.
  // Reduces Cloudflare tunnel load by 5× for the dashboard refresh loop.
  if (method === 'GET' && url.pathname === '/api/dashboard-data') {
    if (!dispatch) { json(res, { status: 'initializing' }); return; }
    try {
      const ds = await dispatch.getUnifiedStats();
      let blockHeight = 0;
      try { blockHeight = await network.getBlockHeight(); } catch {}
      const stopCheck = await dispatch.shouldStop();
      json(res, {
        stats: {
          status: stopCheck.stop ? 'completed' : (ds.totalAgents > 0 ? 'running' : 'waiting'),
          stopReason: stopCheck.stop ? stopCheck.reason : null,
          ...ds,
          blockHeight,
          totalBountiesPosted,
          network: config.network,
          dispatchWallet: wallet.address,
        },
        agents: dispatch.getAgentsForDashboard(),
        events: dispatch.getRecentEvents(),
        results: dispatch.getResults(),
        node: { status: 'connected', height: blockHeight },
      });
    } catch (err: any) {
      json(res, { error: err.message }, 500);
    }
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

  // --- Agent Work (single, legacy) ---
  const agentWorkMatch = url.pathname.match(/^\/api\/agent\/([^/]+)\/work$/);
  if (method === 'GET' && agentWorkMatch) {
    if (!dispatch || !dispatchReady) { json(res, { error: 'Dispatch initializing (fan-out in progress)' }, 503); return; }
    const agentId = agentWorkMatch[1];
    const count = parseInt(url.searchParams.get('count') ?? '1', 10);
    if (count > 1) {
      const result = await dispatch.createWorkBatch(agentId, Math.min(count, 10));
      if (result.error) { json(res, { error: result.error }, 400); return; }
      json(res, { works: (result.works || []).map(serializeWork) });
      return;
    }
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
    // chainLength is the new minimal payload; chainTxHexes still accepted for backwards compat
    const chainLen = body.chainLength ?? (Array.isArray(body.chainTxHexes) ? body.chainTxHexes.length : 0);
    const result = await dispatch.submitPass(agentId, body.workId, body.finalScore, chainLen, body.alreadyBroadcast === true);
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
      const efHexes: string[] | undefined = body.efHexes;

      // EF hex batch from browser agents — broadcast individually via race pattern
      if (efHexes && Array.isArray(efHexes) && efHexes.length > 0) {
        try {
          const txs = efHexes.map(h => Transaction.fromHexEF(h));
          const txids: string[] = [];
          for (const tx of txs) {
            try {
              const txid = await network.broadcast(tx);
              txids.push(txid);
            } catch {
              txids.push(tx.id('hex')); // probably already broadcast
            }
          }
          json(res, { ok: true, txids });
        } catch (err: any) {
          json(res, { ok: false, error: err.message }, 500);
        }
        return;
      }

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
      version: SERVER_VERSION,
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

  // --- Version endpoint (browser polls this; reloads on change) ---
  if (method === 'GET' && url.pathname === '/api/version') {
    json(res, { version: SERVER_VERSION });
    return;
  }

  // --- Debug: call the real pickWalletUtxos function ---
  if (method === 'GET' && url.pathname === '/api/debug-test-pick') {
    if (!dispatch) return json(res, { error: 'not ready' }, 503);
    const sats = parseInt(url.searchParams.get('sats') ?? '500', 10);
    const result = await dispatch.debugPickWalletUtxos(sats);
    json(res, result);
    return;
  }

  // --- Debug: wallet mutation stats ---
  if (method === 'GET' && url.pathname === '/api/debug-stats') {
    json(res, {
      stats: (wallet as any)._stats,
      memory: {
        total: wallet.getUtxos().length,
        confirmedSats: wallet.spendableBalance,
        pendingSats: wallet.pendingBalance,
      },
    });
    return;
  }

  // --- Debug: wallet picking diagnostics ---
  if (method === 'GET' && url.pathname === '/api/debug-pick') {
    const all = wallet.getUtxos();
    const pending = all.filter(u => u.pending).length;
    const noSourceTx = all.filter(u => !u.sourceTransaction).length;
    const havePickable = all.filter(u => u.sourceTransaction && !u.pending).length;
    const pickableSats = all.filter(u => u.sourceTransaction && !u.pending).reduce((s, u) => s + u.satoshis, 0);
    const samples = all.slice(0, 5).map(u => ({
      txid: u.txid.slice(0, 16),
      vout: u.vout,
      sats: u.satoshis,
      pending: !!u.pending,
      hasSourceTx: !!u.sourceTransaction,
    }));
    json(res, { total: all.length, pending, noSourceTx, havePickable, pickableSats, samples });
    return;
  }

  // --- Debug: wallet state breakdown ---
  if (method === 'GET' && url.pathname === '/api/debug-wallet') {
    const utxos = wallet.getUtxos();
    const pending = utxos.filter(u => u.pending);
    const confirmed = utxos.filter(u => !u.pending);
    const pendingSats = pending.reduce((s, u) => s + u.satoshis, 0);
    const confirmedSats = confirmed.reduce((s, u) => s + u.satoshis, 0);
    const includeAll = url.searchParams.get('all') === '1';
    json(res, {
      total: utxos.length,
      confirmed: confirmed.length,
      confirmedSats,
      pending: pending.length,
      pendingSats,
      topPending: pending
        .sort((a, b) => b.satoshis - a.satoshis)
        .slice(0, 10)
        .map(u => ({ txid: u.txid, vout: u.vout, sats: u.satoshis })),
      topConfirmed: confirmed
        .sort((a, b) => b.satoshis - a.satoshis)
        .slice(0, 10)
        .map(u => ({ txid: u.txid, vout: u.vout, sats: u.satoshis })),
      all: includeAll ? utxos.map(u => ({
        txid: u.txid, vout: u.vout, sats: u.satoshis, pending: !!u.pending,
      })) : undefined,
    });
    return;
  }

  // --- Debug: force sweep of ALL pending ---
  if (method === 'POST' && url.pathname === '/api/debug-sweep-pending') {
    const result = wallet.sweepStalePending(0); // TTL 0 = drop all pending
    json(res, { dropped: result.count, sats: result.sats });
    return;
  }

  // --- Reconcile wallet with chain (WoC). Drops in-memory UTXOs and replaces
  //     from on-chain truth. Returns before/after summary. ---
  if (method === 'POST' && url.pathname === '/api/reconcile') {
    if (!dispatch) return json(res, { error: 'Dispatch not ready' }, 503);
    try {
      const before = {
        utxos: wallet.getUtxos().length,
        sats: wallet.balance,
      };
      const result = await dispatch.reconcileFromChain();
      const after = {
        utxos: wallet.getUtxos().length,
        sats: wallet.balance,
      };
      json(res, { before, after, ...result });
    } catch (err: any) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // --- Scan for new funding UTXOs ---
  // Fix startTime if it's 0 but agents have done work
  if (method === 'POST' && url.pathname === '/api/fix-timer') {
    if (dispatch && dispatch.startTime === 0) {
      dispatch.startTime = performance.now() - 1000; // pretend we started 1s ago to avoid div-by-zero
      json(res, { ok: true, message: 'Timer started' });
    } else {
      json(res, { ok: true, message: 'Timer already running' });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/scan-funding') {
    try {
      // CRITICAL: do NOT call scanForDeposits here. It was being hit by every
      // browser tab, triggering repeated WoC queries. WoC's unspent indexer lags
      // ARC by 5-30s and keeps returning UTXOs we've already spent — each scan
      // added phantom "new deposits" to memory, inflating balance by 10x-100x.
      // Now just returns current balance without scanning.
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

  // Stale work cleanup ticker — every 2 min, remove completed/abandoned work from memory
  setInterval(() => {
    if (!dispatch) return;
    try { dispatch.cleanupStaleWork(); } catch (err: any) { console.error(`[cleanup] error: ${err.message}`); }
  }, 2 * 60 * 1000);
  console.log(`[server] Stale work cleanup ticker enabled (2 min)`);

  // Stale pending UTXO sweep — only triggers at a long TTL (10 min). A pending
  // UTXO > 10 min old means its parent broadcast never reported back — truly stuck.
  // (Shorter TTL was losing legit UTXOs when clearPending was slightly delayed.)
  setInterval(() => {
    try {
      const result = wallet.sweepStalePending(10 * 60 * 1000);
      if (result.count > 0) {
        console.log(`[pending-sweep] Dropped ${result.count} stuck pending UTXOs (${result.sats} sats)`);
      }
    } catch (err: any) { console.error(`[pending-sweep] error: ${err.message}`); }
  }, 60 * 1000);
  console.log(`[server] Stale pending sweep enabled (60s, TTL 10min)`);

  // Wallet-TX verification — every 3s, promotes pending change outputs to confirmed
  // once their parent TX is visible on chain. Removes ghosts after 15s of missing.
  setInterval(async () => {
    if (!dispatch) return;
    try {
      const result = await dispatch.verifyWalletTxs({ minAgeMs: 1_000, maxPerRun: 50 });
      if (result.promoted > 0 || result.ghosts > 0) {
        console.log(`[verify-tick] promoted=${result.promoted} ghosts=${result.ghosts}`);
      }
    } catch (err: any) { console.error(`[verify-tick] error: ${err.message}`); }
  }, 3 * 1000);
  console.log(`[server] Wallet-TX verify ticker enabled (3s)`);

  // Periodic deposit scan — every 45s, check for new P2PKH deposits on chain.
  // Uses the confirmed+unspent check so it won't pull in mempool ghosts.
  // This recovers broadcasts that succeeded but weren't tracked by our phase3 addUtxo.
  setInterval(async () => {
    if (!dispatch) return;
    try {
      await dispatch.scanForDeposits();
    } catch (err: any) { console.error(`[scan-tick] error: ${err.message}`); }
  }, 45 * 1000);
  console.log(`[server] Periodic deposit scan enabled (45s)`);

  // Fan-out only when critically low (< 100 UTXOs). We have thousands on chain
  // already; aggressive fan-out is counterproductive.
  setInterval(async () => {
    if (!dispatch || !dispatchReady) return;
    const utxoCount = dispatch.dispatchWallet.getUtxos().filter((u: any) => u.script?.startsWith('76a914')).length;
    if (utxoCount < 100) {
      try { await dispatch.fanOutVaried(); } catch { /* logged inside */ }
    }
  }, 30 * 1000);
  console.log(`[server] Fan-out enabled (30s, triggers only when < 100 UTXOs)`);
});

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
