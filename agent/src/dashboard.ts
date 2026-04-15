/**
 * Dashboard HTML template for MolDock Agent Swarm.
 * Pure function — no state, no imports. Just returns the HTML string.
 *
 * Includes an embedded browser-based compute agent that runs entirely
 * client-side using @bsv/sdk (loaded from CDN). Users click "Start Computing"
 * and the agent runs in their browser tab.
 */

export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>MolDock — On-Chain Molecular Docking</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace; background: #0a0a0a; color: #e0e0e0; padding: 20px; max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 22px; color: #00ff88; margin-bottom: 4px; }
  .subtitle { font-size: 12px; color: #555; margin-bottom: 16px; }
  .node-status { font-size: 11px; color: #555; margin-bottom: 12px; }
  .node-status .on { color: #00ff88; }

  /* Browser Agent Banner */
  .agent-banner { background: linear-gradient(135deg, #0a2a1a, #1a2a0a); border: 2px solid #00ff88; border-radius: 10px; padding: 18px 24px; margin-bottom: 16px; }
  .agent-banner .banner-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .agent-banner h2 { font-size: 16px; color: #00ff88; }
  .agent-banner .banner-desc { font-size: 11px; color: #88cc88; margin-top: 4px; }
  .agent-banner .agent-inputs { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
  .agent-banner .agent-inputs label { font-size: 11px; color: #88cc88; }
  .agent-banner .agent-inputs input { background: #050f05; border: 1px solid #1a3a1a; border-radius: 6px; padding: 8px 12px; font-family: inherit; font-size: 13px; color: #e0e0e0; outline: none; width: 180px; }
  .agent-banner .agent-inputs input:focus { border-color: #00ff88; }
  .agent-banner .agent-inputs input::placeholder { color: #445; }
  .agent-banner .start-btn { background: #00ff88; color: #0a0a0a; border: none; border-radius: 8px; padding: 12px 28px; font-family: inherit; font-size: 14px; font-weight: bold; cursor: pointer; transition: all 0.2s; }
  .agent-banner .start-btn:hover { background: #33ffaa; transform: scale(1.02); }
  .agent-banner .start-btn:disabled { background: #333; color: #888; cursor: not-allowed; transform: none; }
  .agent-banner .stop-btn { background: #ff4444; color: white; border: none; border-radius: 8px; padding: 12px 28px; font-family: inherit; font-size: 14px; font-weight: bold; cursor: pointer; }
  .agent-banner .agent-stats { display: flex; gap: 20px; margin-top: 12px; font-size: 12px; flex-wrap: wrap; }
  .agent-banner .agent-stats .stat { color: #88cc88; }
  .agent-banner .agent-stats .stat strong { color: #00ff88; }
  .agent-banner .agent-log { background: #050f05; border: 1px solid #1a3a1a; border-radius: 6px; padding: 8px 12px; margin-top: 10px; max-height: 120px; overflow-y: auto; font-size: 10px; color: #88cc88; line-height: 1.6; display: none; }

  /* Controls */
  .controls { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .btn { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 8px 14px; color: #00ff88; font-family: inherit; font-size: 12px; cursor: pointer; transition: all 0.15s; }
  .btn:hover { background: #222; border-color: #00ff88; }
  .btn.danger { color: #ff4444; border-color: #333; }
  .btn.danger:hover { border-color: #ff4444; }

  /* Stats Grid */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .card { background: #1a1a1a; border: 1px solid #222; border-radius: 8px; padding: 14px; }
  .card h2 { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .card .val { font-size: 22px; font-weight: bold; color: #00ff88; }
  .card .sub { font-size: 10px; color: #555; margin-top: 3px; }
  .progress-bar { background: #222; border-radius: 3px; height: 4px; margin-top: 6px; overflow: hidden; }
  .progress-fill { background: linear-gradient(90deg, #00ff88, #00cc66); height: 100%; transition: width 0.3s; }

  /* Target Progress */
  .target-bar { background: #111; border: 1px solid #222; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
  .target-bar .target-label { font-size: 11px; color: #888; margin-bottom: 6px; }
  .target-bar .target-progress { background: #1a1a1a; border-radius: 4px; height: 20px; overflow: hidden; position: relative; }
  .target-bar .target-fill { background: linear-gradient(90deg, #00ff88, #00cc66); height: 100%; transition: width 1s; position: relative; }
  .target-bar .target-text { position: absolute; right: 8px; top: 2px; font-size: 11px; color: #e0e0e0; font-weight: bold; }
  .target-bar .target-meta { display: flex; gap: 24px; margin-top: 8px; font-size: 10px; color: #666; flex-wrap: wrap; }
  .target-bar .target-meta span { white-space: nowrap; }
  .target-bar .target-meta .warn { color: #ff6644; font-weight: bold; }
  .target-bar .target-meta .good { color: #00ff88; }
  .run-status { background: #1a0a0a; border: 1px solid #ff4444; border-radius: 8px; padding: 10px 16px; margin-bottom: 16px; display: none; }
  .run-status.active { display: block; }
  .run-status .status-text { font-size: 13px; color: #ff8844; font-weight: bold; }

  /* Sections */
  .section { margin-bottom: 16px; }
  .section h3 { font-size: 12px; color: #888; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #1a1a1a; font-size: 11px; }
  th { color: #555; text-transform: uppercase; letter-spacing: 1px; font-size: 10px; }
  .agent-row { background: #111; }
  .agent-row td { padding: 8px 10px; }
  .agent-name { font-weight: bold; font-size: 12px; }
  .pass { color: #00ff88; }
  .fail { color: #ff4444; }
  .trust-badge { display: inline-block; border-radius: 4px; padding: 1px 6px; font-size: 9px; font-weight: bold; }
  .trust-0 { background: #1a1a1a; border: 1px solid #444; color: #888; }
  .trust-1 { background: #2a2200; border: 1px solid #ffaa00; color: #ffaa00; }
  .trust-2 { background: #0a2a1a; border: 1px solid #00ff88; color: #00ff88; }
  .status-idle { color: #555; }
  .status-working { color: #ffaa00; }
  .status-offline { color: #ff4444; opacity: 0.5; }
  .rank { color: #ffaa00; }
  .score { font-weight: bold; }
  .score.good { color: #00ff88; }
  .score.bad { color: #ff6644; }
  .log { background: #111; border: 1px solid #1a1a1a; border-radius: 8px; padding: 10px; max-height: 250px; overflow-y: auto; font-size: 10px; line-height: 1.6; }
  .log .ev { padding: 1px 0; }
  .log .ev-registered { color: #00ccff; }
  .log .ev-assigned { color: #ffaa00; }
  .log .ev-pass { color: #00ff88; }
  .log .ev-fail { color: #ff6644; }
  .log .ev-confirmed { color: #00ff88; }
  .log .ev-reward { color: #ffaa00; }
  .log .ev-spot_check_fail { color: #ff4444; font-weight: bold; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } }
  .download-bar { background: linear-gradient(135deg, #1a1a2e, #16213e); border: 1px solid #0f3460; border-radius: 8px; padding: 14px 18px; margin-bottom: 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .download-bar .dl-title { font-size: 13px; color: #00ccff; font-weight: bold; }
  .download-bar .dl-cmd { background: #0a0a0a; border: 1px solid #333; border-radius: 4px; padding: 6px 12px; font-size: 11px; color: #e0e0e0; font-family: inherit; cursor: pointer; user-select: all; flex: 1; min-width: 200px; }
  .download-bar .dl-cmd:hover { border-color: #00ccff; }
  .waiting-msg { text-align: center; padding: 30px; color: #555; font-size: 13px; }
  .waiting-msg .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ffaa00; animation: pulse 1.5s infinite; margin-right: 8px; }
  @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }

  /* Funding Banner */
  .funding-banner { background: linear-gradient(135deg, #1a1a2e, #0f3460); border: 1px solid #00ccff; border-radius: 10px; padding: 18px 24px; margin-bottom: 16px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .funding-qr { background: white; border-radius: 8px; padding: 8px; flex-shrink: 0; }
  .funding-qr canvas { display: block; }
  .funding-info { flex: 1; min-width: 200px; }
  .funding-info h2 { font-size: 15px; color: #00ccff; margin-bottom: 6px; }
  .funding-info .fund-address { background: #0a0a0a; border: 1px solid #333; border-radius: 4px; padding: 8px 12px; font-size: 12px; color: #e0e0e0; cursor: pointer; user-select: all; word-break: break-all; margin: 6px 0; }
  .funding-info .fund-address:hover { border-color: #00ccff; }
  .funding-info .fund-meta { font-size: 11px; color: #88aacc; }
  .funding-info .fund-meta .balance { color: #00ff88; font-weight: bold; }
  .funding-info .fund-meta .scan-timer { color: #ffaa00; }
  .funding-info .fund-copied { color: #00ff88; font-size: 11px; display: none; margin-left: 8px; }
</style>
</head>
<body>
<h1>MolDock Agent Swarm <span id="server-version" style="font-size:11px;color:#555;font-weight:normal;margin-left:8px"></span></h1>
<div class="subtitle">On-chain molecular docking via BSV covenant chains &mdash; <span id="target-drugs-sub">107</span> FDA-approved drugs vs <span id="target-receptors-sub">8</span> protein targets (CDK2, EGFR, HIV Protease, COVID Mpro, COX-2, ER-alpha, BRAF, AChE)</div>
<div class="node-status" id="node-status">Node: checking...</div>

<!-- Funding Banner -->
<div class="funding-banner" id="funding-banner">
  <div class="funding-qr"><canvas id="qr-canvas" width="140" height="140"></canvas></div>
  <div class="funding-info">
    <h2>Fund MolDock</h2>
    <div style="font-size:11px; color:#88aacc; margin-bottom:4px;">Send BSV to this address to fund docking computations</div>
    <div class="fund-address" id="fund-address" onclick="copyAddress()" title="Click to copy">Loading...</div>
    <span class="fund-copied" id="fund-copied">Copied!</span>
    <div class="fund-meta">
      Balance: <span class="balance" id="fund-balance">--</span>
      &nbsp;&bull;&nbsp; Next scan: <span class="scan-timer" id="scan-timer">--</span>
    </div>
  </div>
</div>

<!-- Browser Compute Agent -->
<div class="agent-banner">
  <div class="banner-top">
    <div>
      <h2>&#x1f9ec; Browser Compute Agent<span id="ba-name-display" style="color:#88cc88;font-size:13px;margin-left:8px;font-weight:normal"></span></h2>
      <div class="banner-desc">Run a compute agent directly in your browser. Earn BSV by verifying molecular docking calculations on-chain.</div>
    </div>
    <button class="start-btn" id="start-btn" onclick="toggleBrowserAgent()">Start Computing</button>
  </div>
  <div class="agent-inputs" id="agent-inputs">
    <div>
      <label>Agent Name</label><br>
      <input type="text" id="ba-name" placeholder="e.g. DrugHunter42" maxlength="24" autocomplete="off">
    </div>
    <div>
      <label>BSV Wallet Address (for rewards)</label><br>
      <input type="text" id="ba-paymail" placeholder="e.g. 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" maxlength="64" autocomplete="off">
      <div style="margin-top:4px;font-size:11px;color:#888;line-height:1.3">
        <span style="background:#333;padding:1px 5px;border-radius:3px;margin-right:4px;font-size:10px">ℹ</span>
        Paste a standard BSV address to receive micropayment rewards. If no address is provided, rewards are tracked but not paid out.
        HandCash will not display incoming TXs under 1&cent;.
      </div>
    </div>
  </div>
  <div class="agent-stats" id="browser-stats" style="display:none">
    <span class="stat">Molecules: <strong id="ba-molecules">0</strong></span>
    <span class="stat">Passed: <strong id="ba-passed">0</strong></span>
    <span class="stat">Failed: <strong id="ba-failed">0</strong></span>
    <span class="stat">TXs: <strong id="ba-txs">0</strong></span>
    <span class="stat">Earned: <strong id="ba-earned">0 sats</strong></span>
    <span class="stat" style="color:#555">Status: <strong id="ba-status">idle</strong></span>
  </div>
  <div class="agent-log" id="browser-log"></div>
</div>

<!-- CLI Agent Download -->
<div class="download-bar">
  <span class="dl-title">CLI Agent</span>
  <code class="dl-cmd" id="dl-cmd">npx tsx src/computeAgent.ts --server http://localhost:3456 --name MyBot</code>
</div>

<!-- Run Status Banner (shown when run completes) -->
<div class="run-status" id="run-status">
  <span class="status-text" id="run-status-text"></span>
</div>

<!-- TX Volume Target -->
<div class="target-bar">
  <div class="target-label">Transaction Volume Target: 1,500,000 TXs in 24h</div>
  <div class="target-progress">
    <div class="target-fill" id="target-fill" style="width:0%"></div>
    <span class="target-text" id="target-text">0 / 1,500,000</span>
  </div>
  <div class="target-meta">
    <span>ETA: <span id="target-eta" class="good">--</span></span>
    <span>Elapsed: <span id="target-elapsed">--</span></span>
    <span>Remaining: <span id="target-remaining">--</span></span>
    <span>Rate: <span id="target-rate" class="good">--</span></span>
    <span>Avg/mol: <span id="target-avg">--</span> TXs</span>
    <span>Wallet: <span id="target-wallet">--</span></span>
    <span>Drugs: <span id="target-drugs">--</span></span>
    <span>Receptor: <span id="target-receptor">--</span> atoms</span>
  </div>
</div>

<!-- Stats Cards -->
<div class="grid">
  <div class="card"><h2>Agents</h2><div class="val" id="agent-val">--</div><div class="sub" id="agent-sub"></div></div>
  <div class="card"><h2>Processed</h2><div class="val" id="proc-val">--</div><div class="sub" id="proc-sub"></div><div class="progress-bar"><div class="progress-fill" id="proc-bar" style="width:0%"></div></div></div>
  <div class="card"><h2>Transactions</h2><div class="val" id="tx-val">--</div><div class="sub" id="tx-sub"></div></div>
  <div class="card"><h2>Pass Rate</h2><div class="val" id="pass-val">--</div><div class="sub" id="pass-sub"></div></div>
  <div class="card"><h2>Data Size</h2><div class="val" id="bytes-val">--</div><div class="sub" id="bytes-sub"></div></div>
  <div class="card"><h2>Rewards Paid</h2><div class="val" id="reward-val">--</div><div class="sub" id="reward-sub"></div></div>
</div>

<div class="section">
  <h3>Connected Agents</h3>
  <div id="agents-empty" class="waiting-msg" style="display:none"><span class="pulse"></span>Waiting for agents to connect...</div>
  <table id="agents-table-wrap" style="display:none">
    <thead><tr><th>Agent</th><th>Trust</th><th>Status</th><th>Processed</th><th>Passed</th><th>Failed</th><th>Rewards</th><th>TXs</th><th>Data</th></tr></thead>
    <tbody id="agents-table"></tbody>
  </table>
</div>

<div class="two-col">
  <div class="section">
    <h3>Event Log</h3>
    <div class="log" id="log"></div>
  </div>
  <div class="section">
    <h3>Top Molecules (by score)</h3>
    <table>
      <thead><tr><th>#</th><th>Molecule</th><th>Target</th><th>Score</th><th>Result</th><th>Agent</th><th>Chain</th></tr></thead>
      <tbody id="leaderboard"></tbody>
    </table>
  </div>
</div>

<!-- Molecule detail modal -->
<div id="mol-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;overflow-y:auto">
  <div style="max-width:700px;margin:40px auto;background:#0a1a0a;border:1px solid #1a3a1a;border-radius:8px;padding:24px;color:#e0e0e0;font-family:monospace">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="margin:0;color:#00ff88" id="modal-title">Molecule</h2>
      <button onclick="document.getElementById('mol-modal').style.display='none'" style="background:none;border:1px solid #333;color:#aaa;padding:4px 12px;cursor:pointer;border-radius:4px">&times; Close</button>
    </div>
    <div id="modal-body" style="font-size:13px;line-height:1.8"></div>
  </div>
</div>

<script>
function showMolModal(jsonStrOrEl) {
  var r = typeof jsonStrOrEl === 'string' ? JSON.parse(jsonStrOrEl) : jsonStrOrEl;
  var woc = 'https://whatsonchain.com/tx/';
  document.getElementById('modal-title').textContent = r.moleculeId || 'Unknown';
  var html = '';
  html += '<div style="margin-bottom:12px">';
  html += '<b>Target:</b> ' + (r.receptorName || 'unknown') + '<br>';
  html += '<b>Score:</b> <span style="color:' + (r.passed ? '#00ff88' : '#ff6644') + '">' + r.finalScore + '</span> (' + (r.passed ? 'PASS' : 'FAIL') + ')<br>';
  html += '<b>Agent:</b> ' + (r.agentName || 'unknown') + '<br>';
  html += '<b>Chain steps:</b> ' + r.chainSteps + '<br>';
  html += '<b>Total TXs:</b> ' + r.totalTxs + '<br>';
  html += '</div>';
  if (r.genesisTxid) {
    html += '<div style="margin-bottom:8px"><b>Genesis TX:</b><br>';
    html += '<a href="' + woc + r.genesisTxid + '" target="_blank" style="color:#4488ff;word-break:break-all">' + r.genesisTxid + '</a></div>';
  }
  if (r.chainTxids && r.chainTxids.length > 0) {
    html += '<div><b>Chain TXs (' + r.chainTxids.length + '):</b><br>';
    for (var i = 0; i < r.chainTxids.length; i++) {
      html += '<span style="color:#888">Step ' + (i+1) + ':</span> <a href="' + woc + r.chainTxids[i] + '" target="_blank" style="color:#4488ff;word-break:break-all;font-size:11px">' + r.chainTxids[i] + '</a><br>';
    }
    html += '</div>';
  } else if (r.passed) {
    html += '<div style="color:#888">Chain TXs: broadcast by agent (pending confirmation)</div>';
  }
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('mol-modal').style.display = 'block';
}

// --- Auto-restart watchdog ---
// Uses sessionStorage (per-tab, not shared across browser tabs/windows on same domain).
// On Start: saves agent name/address. On page reload: auto-clicks Start with saved values.
// Polls /api/version every 10s; reloads the page when the server restarts (new version).
(function() {
  const RUNNING_KEY = 'moldock_agent_running';  // sessionStorage = per-tab
  let lastSeenVersion = null;

  function tryAutoStart() {
    const saved = sessionStorage.getItem(RUNNING_KEY);
    console.log('[autoStart] sessionStorage check:', saved);
    if (!saved) return;
    try {
      const { name, address } = JSON.parse(saved);
      const nameInput = document.getElementById('ba-name');
      const addrInput = document.getElementById('ba-paymail');
      const startBtn = document.getElementById('start-btn');
      console.log('[autoStart] elements found:', { nameInput: !!nameInput, addrInput: !!addrInput, startBtn: !!startBtn, name });
      if (nameInput && addrInput && startBtn && name) {
        nameInput.value = name;
        if (address) addrInput.value = address;
        // Wait for module script to run + BSV SDK to load (top-level await suspends module).
        // Keep polling until window.toggleBrowserAgent is defined, then click.
        let waitedMs = 0;
        const poll = setInterval(() => {
          if (typeof window.toggleBrowserAgent === 'function' && window.BSV) {
            clearInterval(poll);
            console.log('[autoStart] firing toggleBrowserAgent for', name);
            window.toggleBrowserAgent();
          } else {
            waitedMs += 250;
            if (waitedMs >= 30000) {
              clearInterval(poll);
              console.warn('[autoStart] gave up after 30s — toggleBrowserAgent or BSV not ready');
            }
          }
        }, 250);
      }
    } catch (e) {
      console.error('[autoStart] error:', e);
    }
  }

  // sessionStorage save now happens directly inside toggleBrowserAgent;
  // no wrapper patching needed.

  async function checkVersion() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (lastSeenVersion === null) {
        lastSeenVersion = d.version;
        const versionEl = document.getElementById('server-version');
        if (versionEl) {
          const dt = new Date(parseInt(d.version, 10));
          const formatted = dt.toISOString().slice(0, 19).replace('T', ' ');
          versionEl.textContent = 'v' + formatted + ' UTC';
        }
      } else if (d.version !== lastSeenVersion) {
        console.log('[watchdog] Server version changed — reloading');
        location.reload();
      }
    } catch {}
  }

  window.addEventListener('load', () => {
    // Clean up old localStorage from prior buggy version (shared across tabs).
    try {
      localStorage.removeItem('moldock_agent_running');
      localStorage.removeItem('moldock_server_version');
    } catch {}
    tryAutoStart();
    checkVersion();
    setInterval(checkVersion, 10000);
  });
})();
</script>

<script type="module">
// Load @bsv/sdk from ESM CDN for in-browser chain building & signing.
// Falls back gracefully: if CDN is unreachable, browser agent stays disabled.
let BSV = null;
try {
  BSV = await import('https://esm.sh/@bsv/sdk@1.10.1');
  window.__bsv = BSV;
  window.BSV = BSV; // for autoStart watchdog
  console.log('[browser-agent] BSV SDK loaded');
} catch (err) {
  console.warn('[browser-agent] Failed to load @bsv/sdk from CDN:', err);
}

const $=id=>document.getElementById(id);
function fmt(ms){if(!ms)return'--';if(ms<1000)return ms.toFixed(0)+'ms';if(ms<60000)return(ms/1000).toFixed(1)+'s';return(ms/60000).toFixed(1)+'m'}
function fmtBytes(b){if(!b)return'0B';if(b>1048576)return(b/1048576).toFixed(1)+'MB';if(b>1024)return(b/1024).toFixed(0)+'KB';return b+'B'}

// ========== QR Code Generator (minimal, no dependencies) ==========
// Generates a BSV-compatible QR code on a canvas element
function drawQR(canvas, text, size) {
  // Use a simple QR encoding via the Google Charts API fallback rendered as image
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
  };
  img.onerror = () => {
    // Fallback: just show the address text
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#333';
    ctx.font = '10px monospace';
    ctx.fillText('QR unavailable', 10, size/2);
  };
  // BSV URI format: bitcoin:<address>
  const uri = 'bitcoin:' + text;
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&data=' + encodeURIComponent(uri);
}

function copyAddress() {
  const addr = $('fund-address').textContent;
  if (addr && addr !== 'Loading...') {
    navigator.clipboard.writeText(addr).then(() => {
      const el = $('fund-copied');
      el.style.display = 'inline';
      setTimeout(() => { el.style.display = 'none'; }, 2000);
    });
  }
}
window.copyAddress = copyAddress;

// ========== UTXO Scan Timer ==========
const SCAN_INTERVAL_MS = 60000; // 1 minute
let lastScanTime = Date.now();
let fundingAddress = null;

function updateScanTimer() {
  const elapsed = Date.now() - lastScanTime;
  const remaining = Math.max(0, SCAN_INTERVAL_MS - elapsed);
  const secs = Math.ceil(remaining / 1000);
  const el = $('scan-timer');
  if (el) el.textContent = secs + 's';
}

async function scanForFunding() {
  lastScanTime = Date.now();
  try {
    const res = await fetch('/api/scan-funding', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if ($('fund-balance')) {
        const bal = data.balance || 0;
        $('fund-balance').textContent = bal >= 100000000
          ? (bal / 100000000).toFixed(4) + ' BSV'
          : bal.toLocaleString() + ' sats';
      }
    }
  } catch(e) { /* ignore scan errors */ }
}

// Init funding display
async function initFunding() {
  try {
    const res = await fetch('/api/discover');
    const disc = await res.json();
    fundingAddress = disc.dispatchAddress;
    if (fundingAddress && $('fund-address')) {
      $('fund-address').textContent = fundingAddress;
      drawQR($('qr-canvas'), fundingAddress, 140);
    }
  } catch(e) { /* ignore */ }
  // Initial scan
  scanForFunding();
  // Periodic scan + timer update
  setInterval(scanForFunding, SCAN_INTERVAL_MS);
  setInterval(updateScanTimer, 1000);
}
initFunding();

// Trust badge
function trustBadge(level){
  const labels=['NEW','PROVEN','TRUSTED'];
  return '<span class="trust-badge trust-'+level+'">'+(labels[level]||'?')+'</span>';
}
const nameColors=['#00ccff','#00ff88','#ffaa00','#ff6699','#aa88ff','#88ddff','#44ffaa','#ffcc44'];

// ========== Dashboard Refresh ==========
let _refreshInFlight = false;
async function refresh(){
  if (_refreshInFlight) return; // prevent overlap
  _refreshInFlight = true;
  try{
    // Single combined endpoint — 1 fetch instead of 5.
    // 5s timeout so stalled refreshes don't block subsequent ones.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const data = await fetch('/api/dashboard-data', { signal: ctrl.signal }).then(r=>r.json());
    clearTimeout(timer);
    const stats = data.stats || {};
    const agents = data.agents || [];
    const events = data.events || [];
    const results = data.results || [];
    const node = data.node || { status: 'disconnected' };

    // Node status
    const network = stats.network || 'regtest';
    $('node-status').innerHTML = node.status==='connected'
      ? 'Node: <span class="on">connected</span> &mdash; ' + network + ' height ' + node.height
      : 'Node: disconnected (' + network + ')';

    // CLI command
    const host = location.host;
    $('dl-cmd').textContent = 'npx tsx src/computeAgent.ts --server http://' + host + ' --name MyBot';

    // Stats
    $('agent-val').textContent = (stats.activeAgents||0) + '/' + (stats.totalAgents||0);
    $('agent-sub').textContent = (stats.activeAgents||0) + ' working';

    const proc = stats.processed || 0;
    $('proc-val').textContent = proc.toString();
    $('proc-sub').textContent = 'queue: ' + (stats.queueDepth || 0);

    const totalTxs = stats.totalTxs || 0;
    $('tx-val').textContent = totalTxs.toLocaleString();
    $('tx-sub').textContent = (stats.txsPerSecond||0).toFixed(1) + ' tx/s | ' + fmt(stats.elapsedMs);

    // TX volume target bar
    const TARGET = stats.txTarget || 1500000;
    const pct = Math.min(100, totalTxs / TARGET * 100);
    $('target-fill').style.width = pct.toFixed(2) + '%';
    $('target-text').textContent = totalTxs.toLocaleString() + ' / ' + TARGET.toLocaleString();

    // Enhanced target meta
    $('target-rate').textContent = (stats.txsPerSecond||0).toFixed(1) + ' tx/s';
    $('target-avg').textContent = (stats.avgTxsPerMol || 21).toString();
    $('target-elapsed').textContent = fmt(stats.elapsedMs);
    $('target-remaining').textContent = fmt(stats.timeRemainingMs);
    $('target-eta').textContent = stats.etaMs > 0 ? fmt(stats.etaMs) : '--';
    $('target-drugs').textContent = (stats.moleculeCount || '--').toString();
    $('target-receptor').textContent = (stats.receptorAtoms || '--').toString();
    if (stats.moleculeCount) $('target-drugs-sub').textContent = stats.moleculeCount;
    if (stats.receptorCount) $('target-receptors-sub').textContent = stats.receptorCount;

    // Wallet balance — update both the stats panel and the funding banner
    const walBal = stats.walletBalanceSats || 0;
    const walEl = $('target-wallet');
    if (walBal < 5000) {
      walEl.textContent = walBal.toLocaleString() + ' sats';
      walEl.className = 'warn';
    } else {
      walEl.textContent = (walBal / 100000000).toFixed(4) + ' BSV';
      walEl.className = 'good';
    }
    // Keep the funding banner balance in sync (refreshes every 500ms vs the 60s scan)
    const fundEl = $('fund-balance');
    if (fundEl) {
      fundEl.textContent = walBal >= 100000000
        ? (walBal / 100000000).toFixed(4) + ' BSV'
        : walBal.toLocaleString() + ' sats';
    }

    // Run status banner
    if (stats.stopReason) {
      $('run-status').className = 'run-status active';
      $('run-status-text').textContent = 'RUN COMPLETE: ' + stats.stopReason;
    } else {
      $('run-status').className = 'run-status';
    }

    const rate = proc > 0 ? ((stats.passed||0)/proc*100).toFixed(0) : '--';
    $('pass-val').textContent = rate + (rate!=='--' ? '%' : '');
    $('pass-sub').textContent = (stats.passed||0) + ' pass / ' + (stats.failed||0) + ' fail';

    $('bytes-val').textContent = fmtBytes(stats.totalBytes||0);
    $('bytes-sub').textContent = stats.status || '';

    const rewards = stats.totalRewards || 0;
    $('reward-val').textContent = rewards > 0 ? (rewards/100000000).toFixed(4) + ' BSV' : '0';
    $('reward-sub').textContent = rewards.toLocaleString() + ' sats';

    // Agents table
    if(agents.length===0){
      $('agents-empty').style.display='block';
      $('agents-table-wrap').style.display='none';
    }else{
      $('agents-empty').style.display='none';
      $('agents-table-wrap').style.display='table';
      $('agents-table').innerHTML=agents.map((a,i)=>{
        const color=nameColors[i%nameColors.length];
        const statusHtml=a.status==='working'
          ?'<span class="status-working">'+(a.currentMoleculeId||'').slice(0,18)+'</span>'
          :a.status==='idle'?'<span class="status-idle">idle</span>'
          :'<span class="status-offline">offline</span>';
        return '<tr class="agent-row">'+
          '<td><span class="agent-name" style="color:'+color+'">'+a.name+'</span></td>'+
          '<td>'+trustBadge(a.trustLevel)+'</td>'+
          '<td>'+statusHtml+'</td>'+
          '<td>'+a.processed+'</td>'+
          '<td class="pass">'+a.passed+'</td>'+
          '<td class="fail">'+a.failed+'</td>'+
          '<td style="color:#ffaa00">'+(a.totalRewards>0?a.totalRewards.toLocaleString()+' sats':'0')+'</td>'+
          '<td>'+a.totalTxs+'</td>'+
          '<td style="color:#888">'+fmtBytes(a.totalBytes||0)+'</td></tr>';
      }).join('');
    }

    // Event log
    $('log').innerHTML=(events||[]).slice().reverse().slice(0,80).map(e=>{
      const cls='ev-'+(e.type||'');
      const mol=e.moleculeId?' '+e.moleculeId:'';
      const sc=e.score!==undefined?' score='+e.score:'';
      const time=e.timestamp?new Date(e.timestamp).toLocaleTimeString():'';
      return '<div class="ev '+cls+'"><span style="color:#444;font-size:9px">'+time+'</span> <strong>['+e.agentName+']</strong> '+e.type.toUpperCase()+mol+sc+'</div>';
    }).join('');

    // Leaderboard
    const sorted = (results||[]).sort((a,b) => a.finalScore - b.finalScore);
    $('leaderboard').innerHTML=sorted.slice(0,20).map((r,i)=>{
      const cls=r.passed?'score good':'score bad';
      const res=r.passed?'<span class="pass">PASS</span>':'<span class="fail">FAIL</span>';
      const tgt=(r.receptorName||'').replace(/\s*\(PDB.*\)/,'').slice(0,20);
      const dataAttr=JSON.stringify(r).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
      return '<tr style="cursor:pointer" onclick="showMolModal(this.dataset.mol)" data-mol="'+dataAttr+'"><td class="rank">#'+(i+1)+'</td><td>'+r.moleculeId+'</td><td style="color:#00ccff;font-size:9px">'+tgt+'</td><td class="'+cls+'">'+r.finalScore+'</td><td>'+res+'</td><td style="color:#888">'+(r.agentName||'')+'</td><td>'+r.chainSteps+' steps</td></tr>';
    }).join('');

  }catch(e){console.error('refresh',e)}
  finally { _refreshInFlight = false; }
}
// Refresh cadence: 2s when visible, 10s when hidden.
// Was 500ms which saturated Cloudflare tunnel at 10 req/sec × N tabs.
let _refreshTimer = null;
function scheduleRefresh() {
  if (_refreshTimer) clearInterval(_refreshTimer);
  const interval = document.visibilityState === 'hidden' ? 10000 : 2000;
  _refreshTimer = setInterval(refresh, interval);
}
document.addEventListener('visibilitychange', scheduleRefresh);
scheduleRefresh();
refresh();

// Expose entry points for inline onclick handlers (module scope doesn't leak to window automatically).
window.toggleBrowserAgent = (...args) => toggleBrowserAgent(...args);
Object.defineProperty(window, 'browserAgentRunning', { get: () => browserAgentRunning });

// ========== Browser Compute Agent ==========
// Runs entirely client-side: fetches work from dispatch, computes energy,
// submits results. No @bsv/sdk needed in browser — energy.ts is pure math.

let browserAgentRunning = false;
let browserRunToken = 0; // increments on Start; loops check this to exit cleanly on Stop
let browserAgentId = null;
let browserPrivKey = null;   // BSV PrivateKey instance
let browserPubKeyHex = null; // 33-byte compressed pubkey hex
let browserNetwork = 'regtest';
let browserArc = null;       // BSV.ARC instance when network != regtest
let browserArcEndpoints = []; // list of Arcade URLs to rotate through
let baStats = { molecules: 0, passed: 0, failed: 0, txs: 0, earned: 0 };
const baScoreHistory = [];
const baBodyHexCache = new Map();
let baBackoffUntil = 0;      // monotonic wall-clock ms; broadcast pauses while now() < this

function baLog(msg, color) {
  const log = $('browser-log');
  const time = new Date().toLocaleTimeString();
  log.innerHTML += '<div style="color:'+(color||'#88cc88')+'"><span style="color:#444;font-size:9px">'+time+'</span> '+msg+'</div>';
  log.scrollTop = log.scrollHeight;
}

function baUpdateStats() {
  $('ba-molecules').textContent = baStats.molecules;
  $('ba-passed').textContent = baStats.passed;
  $('ba-failed').textContent = baStats.failed;
  $('ba-txs').textContent = baStats.txs;
  $('ba-earned').textContent = baStats.earned + ' sats';
}

function baIsPassing(score) {
  baScoreHistory.push(score);
  if (baScoreHistory.length < 5) return true;
  const sorted = [...baScoreHistory].sort((a,b) => a - b);
  return score <= sorted[Math.floor(sorted.length * 0.2)];
}

async function toggleBrowserAgent() {
  if (browserAgentRunning) {
    browserAgentRunning = false;
    $('start-btn').textContent = 'Start Computing';
    $('start-btn').className = 'stop-btn';  // will be overridden below
    $('start-btn').className = 'start-btn';
    $('agent-inputs').style.display = 'flex';
    $('ba-status').textContent = 'stopped';
    const nameDisplayStop = document.getElementById('ba-name-display');
    if (nameDisplayStop) nameDisplayStop.textContent = '';
    // Clear sessionStorage so we don't auto-restart on reload
    try { sessionStorage.removeItem('moldock_agent_running'); } catch {}
    // Release the wake lock
    try {
      if (window.__moldockWakeLock) {
        await window.__moldockWakeLock.release();
        window.__moldockWakeLock = null;
        console.log('[wake-lock] released');
      }
    } catch {}
    baLog('Agent stopped.', '#ff6644');
    return;
  }

  // Validate inputs
  const nameInput = $('ba-name');
  const paymailInput = $('ba-paymail');
  let agentName = (nameInput.value || '').trim();
  const paymail = (paymailInput.value || '').trim() || null;

  if (!agentName) {
    nameInput.style.borderColor = '#ff4444';
    nameInput.focus();
    return;
  }
  nameInput.style.borderColor = '#1a3a1a';

  // Note: server reuses existing agent record if same name re-registers (e.g. stop/start).
  // No name-availability check needed — the register call handles it.

  if (!BSV) {
    baLog('BSV SDK failed to load from CDN. Browser agent unavailable.', '#ff4444');
    $('browser-log').style.display = 'block';
    return;
  }

  // Start
  browserAgentRunning = true;
  browserRunToken++; // signal old loops to exit
  const myToken = browserRunToken;
  $('start-btn').textContent = 'Stop';
  $('start-btn').className = 'stop-btn';
  $('agent-inputs').style.display = 'none';
  $('browser-stats').style.display = 'flex';
  $('browser-log').style.display = 'block';
  $('ba-status').textContent = 'starting...';
  // Show agent name in the header
  const nameDisplay = document.getElementById('ba-name-display');
  if (nameDisplay) nameDisplay.textContent = '— ' + agentName;
  // Save state for auto-restart on page reload (per-tab via sessionStorage)
  try {
    const data = JSON.stringify({ name: agentName, address: paymail || '' });
    sessionStorage.setItem('moldock_agent_running', data);
    console.log('[autoStart] saved to sessionStorage:', data);
  } catch (e) {
    console.warn('[autoStart] save failed:', e);
  }

  // Request Screen Wake Lock to prevent browser from throttling/sleeping the tab
  // when the screen turns off. Without this, mobile & Mac browsers pause JS.
  try {
    if ('wakeLock' in navigator) {
      const lock = await navigator.wakeLock.request('screen');
      window.__moldockWakeLock = lock;
      console.log('[wake-lock] acquired');
      // Re-request on visibility change (lock is released when tab hides)
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && browserAgentRunning) {
          try {
            window.__moldockWakeLock = await navigator.wakeLock.request('screen');
            console.log('[wake-lock] re-acquired');
          } catch (e) { console.warn('[wake-lock] re-request failed', e); }
        }
      });
    } else {
      console.log('[wake-lock] API not available');
    }
  } catch (e) {
    console.warn('[wake-lock] failed:', e);
  }

  // Generate session keypair
  browserPrivKey = BSV.PrivateKey.fromRandom();
  browserPubKeyHex = browserPrivKey.toPublicKey().toString();
  baLog('Generated session keypair: ' + browserPubKeyHex.slice(0, 16) + '...', '#88cc88');

  // Discover network mode — determines whether browser uses /api/broadcast forwarder or ARC direct
  try {
    const disc = await fetch('/api/discover').then(r => r.json());
    browserNetwork = disc.network || 'regtest';
    baLog('Discovered dispatch on ' + browserNetwork, '#88cc88');
    if (browserNetwork !== 'regtest') {
      // Arcade broadcast: use Extended Format (EF) directly to Arcade.
      // Multiple endpoints rotate per request for load balancing & resilience.
      browserArcEndpoints = browserNetwork === 'mainnet'
        ? [
            'https://arcade-us-1.bsvb.tech',
            'https://arcade-eu-1.bsvb.tech',
            'https://arcade-ttn-us-1.bsvb.tech',
          ]
        : [
            'https://arcade-testnet-us-1.bsvb.tech',
            'https://arcade-ttn-us-1.bsvb.tech',
          ];
      browserArc = { URL: browserArcEndpoints[0] }; // flag for broadcastChainBrowser
      baLog('Arcade broadcast enabled: ' + browserArcEndpoints.length + ' endpoints', '#00ff88');
    }
  } catch (e) {
    baLog('Discover failed: ' + e.message, '#ff6644');
  }

  baLog('Starting as ' + agentName + (paymail ? ' (' + paymail + ')' : '') + '...', '#00ccff');

  try {
    // Register
    const regRes = await fetch('/api/agent/register', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ name: agentName, pubkey: browserPubKeyHex, paymail: paymail }),
    }).then(r => r.json());

    if (regRes.error) { baLog('Registration failed: ' + regRes.error, '#ff4444'); browserAgentRunning = false; return; }
    browserAgentId = regRes.agent.id;
    baLog('Registered! ID: ' + browserAgentId, '#00ff88');

    // Work loop
    await browserWorkLoop(myToken);
  } catch (err) {
    baLog('Error: ' + err.message, '#ff4444');
    browserAgentRunning = false;
    $('start-btn').textContent = 'Start Computing';
    $('start-btn').className = 'start-btn';
  }
}

// Local queue of pre-fetched work packages. Refilled in batches to amortize Cloudflare RTT.
let workQueue = [];
const WORK_BATCH_SIZE = 5;
let fetchInFlight = false; // prevent multiple simultaneous fetches from parallel workers

async function fetchWorkBatch() {
  if (fetchInFlight) return; // coordinator — one fetch at a time
  fetchInFlight = true;
  try {
    const r = await fetch('/api/agent/' + browserAgentId + '/work?count=' + WORK_BATCH_SIZE);
    if (!r.ok) return;
    const data = await r.json();
    if (data.works && Array.isArray(data.works)) {
      workQueue.push(...data.works);
    } else if (data.work) {
      workQueue.push(data.work);
    }
  } catch (e) {
    console.warn('fetchWorkBatch failed:', e);
  } finally {
    fetchInFlight = false;
  }
}

// Fetch + compute + build for one work item. Returns null if no work is available.
// seed can be a pre-fetched work object (from a previous pass/fail response) to skip /work.
async function prepareNextWork(seed) {
  let work = seed || null;
  if (!work) {
    // Refill queue if empty
    if (workQueue.length === 0) await fetchWorkBatch();
    if (workQueue.length === 0) return null;
    work = workQueue.shift();
    // Pre-fetch next batch when queue is half empty (overlap with chain compute/broadcast)
    if (workQueue.length <= 2) {
      fetchWorkBatch().catch(() => {});
    }
  }
  const tCompute = performance.now();
  const stepBatches = [];
  let totalScore = 0;
  for (const rAtom of work.receptor.atoms) {
    const batch = computeBatchEnergyBrowser(work.molecule.atoms, rAtom);
    stepBatches.push(batch);
    totalScore += batch.batchTotal;
  }
  const computeMs = (performance.now() - tCompute).toFixed(0);
  const passed = baIsPassing(totalScore);
  // Build chain — failures here should not kill the agent loop
  let chain = null;
  let buildMs = '0';
  try {
    const tBuild = performance.now();
    chain = buildChainBrowser(work, stepBatches);
    buildMs = (performance.now() - tBuild).toFixed(0);
  } catch (e) {
    console.error('buildChainBrowser failed:', e);
    // Return without chain — will be handled as a fail
  }
  return { work, stepBatches, totalScore, passed: chain ? passed : false, chain, computeMs, buildMs };
}

// Broadcast step TXs honoring the backoff clock + ARC lock.
// When browserArc is set (testnet/mainnet) goes direct-to-ARC; otherwise uses dispatch forwarder.
// stepTxs: array of Transaction objects (from rebuildChainWithFees) or raw hex strings (fallback)
async function broadcastChainBrowser(stepTxs) {
  // Respect backoff from previous "too-long-mempool-chain" style errors.
  const wait = baBackoffUntil - Date.now();
  if (wait > 0) {
    $('ba-status').textContent = 'backoff ' + (wait/1000).toFixed(1) + 's...';
    await new Promise(r => setTimeout(r, wait));
  }

  if (browserArc && stepTxs.length > 0 && typeof stepTxs[0] !== 'string') {
    // Arcade broadcast with Extended Format (EF). Multiple endpoints rotate per request
    // for load balancing. Parallel waves of N — TXs depend on each other but Arcade is
    // generally OK accepting them slightly out of order with a brief retry on "missing parent".
    const ARCADE_ENDPOINTS = browserArcEndpoints;
    const WAVE = 1; // sequential — chain TXs depend on each other; parallel races cause REJECTED cascades
    let endpointIdx = 0;

    async function sendOne(efHex, idx) {
      const body = Uint8Array.from(efHex.match(/.{2}/g).map(b => parseInt(b, 16)));
      for (let attempt = 0; attempt < 6; attempt++) {
        const url = ARCADE_ENDPOINTS[(endpointIdx + idx + attempt) % ARCADE_ENDPOINTS.length];
        try {
          const r = await fetch(url + '/tx', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: body,
          });
          // Parse body — Arcade returns HTTP 200 even on REJECTED status
          const respText = await r.text();
          let respJson = null;
          try { respJson = JSON.parse(respText); } catch {}
          const txStatus = respJson?.txStatus || '';
          const isOk = r.ok && txStatus !== 'REJECTED' && !respJson?.error;
          if (isOk) return null;

          const errMsg = respJson?.extraInfo || respJson?.detail || respJson?.error || respText.slice(0, 200);
          // 5xx (SQLITE_BUSY) or "missing parent"/REJECTED — retry with backoff
          const isRetryable = r.status >= 500
            || txStatus === 'REJECTED'
            || /missing|unknown|previous|not found|sqlite|busy/i.test(errMsg);
          if (isRetryable && attempt < 5) {
            const waitMs = 200 + Math.random() * 400 * Math.pow(2, attempt);
            await new Promise(res => setTimeout(res, waitMs));
            continue;
          }
          return { error: 'Arcade ' + r.status + '/' + (txStatus || 'err') + ': ' + errMsg.slice(0, 150) };
        } catch (e) {
          if (attempt < 5) {
            await new Promise(res => setTimeout(res, 300 * (attempt + 1)));
            continue;
          }
          return { error: 'network: ' + String(e.message || e) };
        }
      }
      return { error: 'retries exhausted' };
    }

    // Pre-serialize all TXs to EF
    const efHexes = stepTxs.map(tx => tx.toHexEF());

    // Send in parallel waves (chain TXs are dependent but Arcade tolerates brief reordering)
    for (let start = 0; start < efHexes.length; start += WAVE) {
      const slice = efHexes.slice(start, start + WAVE);
      const results = await Promise.allSettled(
        slice.map((hex, j) => sendOne(hex, start + j))
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === 'rejected' || (r.status === 'fulfilled' && r.value)) {
          const msg = r.status === 'rejected' ? String(r.reason?.message || r.reason) : r.value.error;
          if (/too.long.mempool|chain.too.long|limit.?ancestor/i.test(msg)) baBackoffUntil = Date.now() + 3500;
          return { ok: false, error: 'arcade step ' + (start + j) + ': ' + msg };
        }
      }
      endpointIdx = (endpointIdx + WAVE) % ARCADE_ENDPOINTS.length;
    }
    return { ok: true };
  }

  // Regtest path: /api/broadcast forwarder (batch).
  const bcastRes = await fetch('/api/broadcast', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ txHexes: stepTxs.map(t => typeof t === 'string' ? t : t.toHex()) }),
  }).then(r => r.json());
  if (!bcastRes.ok && bcastRes.backoff) {
    baBackoffUntil = Date.now() + 3500;
  }
  return bcastRes;
}

// Number of molecules to process in parallel per browser tab.
// Each chain is internally sequential (no intra-chain races) but multiple
// chains run concurrently to amortize Cloudflare RTT and keep Arcade busy.
// 3 works well — more causes Arcade contention and wasted genesis TXs.
const PARALLEL_CHAINS = 3;

async function browserWorkLoop(myToken) {
  // Spawn N parallel workers — each pulls work from the shared queue,
  // processes one molecule end-to-end, repeats. Independent chains broadcast
  // concurrently without intra-chain races.
  const workers = [];
  for (let w = 0; w < PARALLEL_CHAINS; w++) {
    workers.push(parallelChainWorker(myToken, w));
  }
  await Promise.all(workers);
}

async function parallelChainWorker(myToken, workerId) {
  // Each worker has its own pipeline: fetch+compute+build for next molecule
  // while broadcasting current one.
  let nextPrepPromise = prepareNextWork(null);

  while (browserAgentRunning && myToken === browserRunToken) {
    let prep = null;
    try {
      if (workerId === 0) $('ba-status').textContent = 'wkr0: waiting for prep...';
      prep = await nextPrepPromise;
      nextPrepPromise = null;

      if (!prep) {
        if (workerId === 0) $('ba-status').textContent = 'waiting for work...';
        await new Promise(r => setTimeout(r, 1500));
        nextPrepPromise = prepareNextWork(null);
        continue;
      }

      const { work, totalScore, passed, chain, computeMs, buildMs } = prep;
      const molId = work.molecule.id;
      if (workerId === 0) $('ba-status').textContent = molId.slice(0, 20) + '...';

      baStats.molecules++;

      if (!passed || !chain) {
        baStats.failed++;
        baLog('FAIL ' + molId + ' score=' + totalScore + ' (' + computeMs + 'ms)', '#ff6644');
        const failRes = await fetch('/api/agent/' + browserAgentId + '/fail', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ workId: work.id, finalScore: totalScore }),
        }).then(r => r.json());
        if (failRes.reward) baStats.earned += failRes.reward;
        nextPrepPromise = prepareNextWork(failRes.nextWork || null);
        baUpdateStats();
        continue;
      }

      // PASS: request fee UTXOs from dispatch, rebuild chain with fees, then broadcast.
      if (workerId === 0) $('ba-status').textContent = 'requesting fees...';
      const t2 = performance.now();

      // Step 1: Submit pass and request fee UTXOs — with timeout + retry
      let passRes = null;
      for (let passAttempt = 0; passAttempt < 3; passAttempt++) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 30000); // 30s timeout
          // Minimal payload: just workId, score, and chain length.
          // Sending chainTxHexes was burning ~100KB/call through Cloudflare tunnel.
          const r = await fetch('/api/agent/' + browserAgentId + '/pass', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              workId: work.id,
              finalScore: totalScore,
              chainLength: chain.txHexes.length,
              alreadyBroadcast: false,
            }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          passRes = await r.json();
          if (passRes.ok) break;
          // Server returned error — retry once more if it looks transient
          if (passAttempt < 2 && /No funding|Arcade 5|broadcast failed/i.test(passRes.error || '')) {
            baLog('Fees retry ' + (passAttempt+1) + ': ' + (passRes.error || '?'), '#ffaa00');
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
            continue;
          }
          break;
        } catch (e) {
          if (passAttempt < 2) {
            baLog('Fees timeout, retrying...', '#ffaa00');
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
            continue;
          }
          passRes = { ok: false, error: 'timeout: ' + (e.message || e) };
        }
      }

      if (!passRes || !passRes.ok) {
        baLog('Pass rejected: ' + (passRes?.error || 'unknown'), '#ff4444');
        // Submit fail to clear the work assignment so we can move on
        try {
          const failRes = await fetch('/api/agent/' + browserAgentId + '/fail', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ workId: work.id, finalScore: 999999 }),
          }).then(r => r.json());
          nextPrepPromise = prepareNextWork(failRes.nextWork || null);
        } catch {
          nextPrepPromise = prepareNextWork(null);
        }
        baUpdateStats();
        continue;
      }

      // Step 2: Rebuild chain step TXs with fee inputs
      const feePackage = passRes.feePackage;
      let rebuiltTxObjects = null; // Transaction objects with sourceTransaction for EF

      if (feePackage && feePackage.utxos && feePackage.utxos.length > 0) {
        if (workerId === 0) $('ba-status').textContent = 'adding fees...';
        try {
          rebuiltTxObjects = await rebuildChainWithFees(chain, feePackage.utxos);
        } catch (rebuildErr) {
          baLog('Fee rebuild failed: ' + rebuildErr.message + ' — broadcasting without fees', '#ffaa00');
        }
      }

      // Step 3: Broadcast rebuilt chain with fees
      if (workerId === 0) $('ba-status').textContent = 'broadcasting...';

      const bcastRes = await broadcastChainBrowser(rebuiltTxObjects || chain.txHexes.slice(1));
      const bcastMs = (performance.now() - t2).toFixed(0);

      if (!bcastRes.ok) {
        const errMsg = bcastRes.errors && bcastRes.errors.length
          ? 'step ' + bcastRes.errors[0].index + ': ' + bcastRes.errors[0].error
          : (bcastRes.error || 'unknown');
        baLog('Broadcast failed: ' + errMsg, '#ff4444');
        const failRes = await fetch('/api/agent/' + browserAgentId + '/fail', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ workId: work.id, finalScore: totalScore }),
        }).then(r => r.json());
        if (failRes.reward) baStats.earned += failRes.reward;
        nextPrepPromise = prepareNextWork(failRes.nextWork || null);
        baUpdateStats();
        continue;
      }

      baStats.txs += chain.txHexes.length;
      baStats.passed++;
      baStats.earned += (passRes.reward || 100);
      baLog('PASS ' + molId + ' score=' + totalScore + ' compute=' + computeMs + 'ms build=' + buildMs + 'ms bcast=' + bcastMs + 'ms ' + chain.txHexes.length + ' TXs', '#00ff88');

      // Compute correct TXIDs from the broadcast chain TXs
      const broadcastSrc = rebuiltTxObjects || chain.txHexes.slice(1);
      const broadcastTxids = broadcastSrc.map(function(txOrHex) {
        if (typeof txOrHex === 'string') return BSV.Transaction.fromHex(txOrHex).id('hex');
        return txOrHex.id('hex');
      });

      // Confirm broadcast — wait for response to get next work assignment
      const confirmRes = await fetch('/api/agent/' + browserAgentId + '/confirm', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ workId: work.id, txids: broadcastTxids }),
      }).then(r => r.json()).catch(() => ({}));
      nextPrepPromise = prepareNextWork(confirmRes.nextWork || null);

      baUpdateStats();
      if (workerId === 0) $('ba-status').textContent = 'wkr0: idle';

    } catch (err) {
      baLog('Error: ' + err.message, '#ff4444');
      // Submit fail to clear the assigned work so we can get new work
      if (prep && prep.work) {
        try {
          const failRes = await fetch('/api/agent/' + browserAgentId + '/fail', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ workId: prep.work.id, finalScore: 999999 }),
          }).then(r => r.json());
          nextPrepPromise = prepareNextWork(failRes.nextWork || null);
        } catch (e2) {
          await new Promise(r => setTimeout(r, 3000));
          nextPrepPromise = prepareNextWork(null);
        }
      } else {
        await new Promise(r => setTimeout(r, 3000));
        if (!nextPrepPromise) nextPrepPromise = prepareNextWork(null);
      }
    }
  }
}

// ========== Chain Building (browser port of computeAgent.ts) ==========

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i*2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function pushData(data) {
  // data is number[] or Uint8Array
  const arr = Array.from(data);
  if (arr.length === 0) return [0x00];
  if (arr.length === 1 && arr[0] >= 1 && arr[0] <= 16) return [0x50 + arr[0]];
  if (arr.length === 1 && arr[0] === 0x81) return [0x4f];
  if (arr.length <= 75) return [arr.length, ...arr];
  if (arr.length <= 255) return [0x4c, arr.length, ...arr];
  return [0x4d, arr.length & 0xff, (arr.length >> 8) & 0xff, ...arr];
}

function pushScriptNum(n) {
  if (n === 0) return [0x00];
  if (n === -1) return [0x4f];
  if (n >= 1 && n <= 16) return [0x50 + n];
  const neg = n < 0;
  let abs = Math.abs(n);
  const bytes = [];
  while (abs > 0) { bytes.push(abs & 0xff); abs = Math.floor(abs / 256); }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(neg ? 0x80 : 0x00);
  else if (neg) bytes[bytes.length - 1] |= 0x80;
  return pushData(bytes);
}

function buildChainScriptSigBrowser(prevTxid, inputSats, batchTotal, scoreOut, pairs) {
  const parts = [];
  // txid in little-endian
  const txidBytes = Array.from(hexToBytes(prevTxid)).reverse();
  parts.push(pushData(txidBytes));
  // 8-byte LE sats
  const satsBytes = [];
  let s = BigInt(inputSats);
  for (let i = 0; i < 8; i++) { satsBytes.push(Number(s & 0xffn)); s >>= 8n; }
  parts.push(pushData(satsBytes));
  parts.push(pushScriptNum(batchTotal));
  parts.push(pushScriptNum(scoreOut));
  for (const pair of pairs) {
    parts.push(pushScriptNum(pair.hbond));
    parts.push(pushScriptNum(pair.elec));
    parts.push(pushScriptNum(pair.vdw));
    parts.push(pushScriptNum(pair.dist));
    parts.push(pushScriptNum(pair.dsq));
  }
  // concat
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return bytesToHex(out);
}

function buildChainLockScriptBrowser(numAtoms, score, compiledAsm) {
  let cachedBodyHex = baBodyHexCache.get(compiledAsm);
  if (!cachedBodyHex) {
    const parts = compiledAsm.split('OP_DROP ');
    if (parts.length < 2) throw new Error('Could not find OP_DROP in compiled chain ASM');
    const bodyAsm = parts.slice(1).join('OP_DROP ');
    cachedBodyHex = BSV.Script.fromASM(bodyAsm).toHex();
    baBodyHexCache.set(compiledAsm, cachedBodyHex);
  }

  // 4-byte LE score prefix
  const buf = new Uint8Array(4);
  if (score !== 0) {
    const neg = score < 0;
    let abs = Math.abs(score);
    buf[0] = abs & 0xff;
    buf[1] = (abs >> 8) & 0xff;
    buf[2] = (abs >> 16) & 0xff;
    buf[3] = (Math.floor(abs / 0x1000000)) & 0xff;
    if (neg) buf[3] |= 0x80;
  }
  const scorePrefix = '04' + bytesToHex(buf);
  const fullHex = scorePrefix + '75' + cachedBodyHex;
  const rawBytes = hexToBytes(fullHex);
  return new BSV.Script([], rawBytes, undefined, false);
}

// Rebuild chain step TXs with fee UTXOs as input 1.
// The covenant scriptSig on input 0 embeds the previous txid, so adding inputs
// changes the current txid which changes the next step's scriptSig → must rebuild all.
async function rebuildChainWithFees(chain, feeUtxos) {
  const { Transaction, Script, TransactionSignature, Hash, UnlockingScript } = BSV;
  const stepTxHexes = chain.txHexes.slice(1); // skip genesis
  if (feeUtxos.length < stepTxHexes.length) {
    throw new Error('Not enough fee UTXOs: got ' + feeUtxos.length + ' need ' + stepTxHexes.length);
  }

  const rebuilt = [];
  let prevTx = Transaction.fromHex(chain.txHexes[0]); // genesis
  let prevTxid = prevTx.id('hex');

  for (let i = 0; i < stepTxHexes.length; i++) {
    const origTx = Transaction.fromHex(stepTxHexes[i]);
    const fee = feeUtxos[i];
    const feeSrcTx = Transaction.fromHex(fee.sourceTxHex);
    const feeScript = Script.fromHex(fee.scriptHex);
    const covenantOutput = origTx.outputs[0];

    // Rebuild scriptSig with updated prevTxid (first push is 0x20 + 32-byte LE txid)
    const origScriptSig = origTx.inputs[0].unlockingScript.toHex();
    const newTxidLE = Array.from(hexToBytes(prevTxid)).reverse();
    const newTxidHex = bytesToHex(new Uint8Array(newTxidLE));
    const newScriptSig = '20' + newTxidHex + origScriptSig.slice(66);

    const newTx = new Transaction();
    newTx.version = 2;
    newTx.lockTime = 0;

    // Input 0: covenant UTXO (data-push scriptSig, not signature-based)
    newTx.addInput({
      sourceTransaction: prevTx,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromHex(newScriptSig),
      sequence: 0xffffffff,
    });

    // Input 1: fee UTXO — P2PK unlock signed by browser's ephemeral key
    const feeSats = fee.satoshis;
    newTx.addInput({
      sourceTransaction: feeSrcTx,
      sourceOutputIndex: fee.vout,
      unlockingScriptTemplate: {
        sign: async function(tx, inputIndex) {
          const scope = TransactionSignature.SIGHASH_FORKID | TransactionSignature.SIGHASH_ALL;
          const input = tx.inputs[inputIndex];
          const otherInputs = tx.inputs.filter((_, idx) => idx !== inputIndex);
          const sourceTXID = input.sourceTXID || input.sourceTransaction.id('hex');
          const preimage = TransactionSignature.format({
            sourceTXID,
            sourceOutputIndex: input.sourceOutputIndex,
            sourceSatoshis: feeSats,
            transactionVersion: tx.version,
            otherInputs,
            inputIndex,
            outputs: tx.outputs,
            inputSequence: input.sequence,
            subscript: feeScript,
            lockTime: tx.lockTime,
            scope,
          });
          const rawSig = browserPrivKey.sign(Hash.sha256(preimage));
          const sig = new TransactionSignature(rawSig.r, rawSig.s, scope);
          const sigBytes = sig.toChecksigFormat();
          return new UnlockingScript([{ op: sigBytes.length, data: sigBytes }]);
        },
        estimateLength: async function() { return 74; },
      },
      sequence: 0xffffffff,
    });

    // Output 0: covenant continuation (same as original)
    newTx.addOutput({
      lockingScript: covenantOutput.lockingScript,
      satoshis: covenantOutput.satoshis,
    });

    // Sign fee input (input 1 only — input 0 uses data-push scriptSig)
    await newTx.sign();

    rebuilt.push(newTx);
    prevTx = newTx;
    prevTxid = newTx.id('hex');
  }

  return rebuilt; // returns Transaction objects (with sourceTransaction intact for EF)
}

function buildChainBrowser(work, stepBatches) {
  const { Transaction, Script } = BSV;
  const numAtoms = work.molecule.atoms.length;
  const numSteps = work.numSteps;
  const compiledAsm = work.compiledAsm;

  const genesisTx = Transaction.fromHex(work.genesisTxHex);
  const genesisTxid = work.genesisTxid;

  const txHexes = [genesisTx.toHex()];
  const stepTxids = [];

  let prevTx = genesisTx;
  let currentTxid = genesisTxid;
  let currentScore = 0;

  for (let step = 0; step < numSteps; step++) {
    const batch = stepBatches[step];
    const newScore = currentScore + batch.batchTotal;
    const scriptSigHex = buildChainScriptSigBrowser(currentTxid, 1, batch.batchTotal, newScore, batch.pairs);

    const chainTx = new Transaction();
    chainTx.version = 2;
    chainTx.lockTime = 0;
    chainTx.addInput({
      sourceTransaction: prevTx,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromHex(scriptSigHex),
      sequence: 0xffffffff,
    });
    chainTx.addOutput({
      lockingScript: buildChainLockScriptBrowser(numAtoms, newScore, compiledAsm),
      satoshis: 1,
    });

    txHexes.push(chainTx.toHex());
    const txid = chainTx.id('hex');
    stepTxids.push(txid);

    prevTx = chainTx;
    currentTxid = txid;
    currentScore = newScore;
  }

  return { txHexes, stepTxids, finalScore: currentScore };
}

// ========== Browser Energy Computation ==========
// Pure JavaScript port of energy.ts — MUST MATCH EXACTLY for spot-check to pass.

const VDW_RADIUS_BA = {1:170,2:155,3:152,4:180,5:120,6:180,7:147,8:175};
const VDW_EPSILON_BA = {1:150,2:200,3:210,4:250,5:50,6:200,7:180,8:300};
const HBOND_TYPES_BA = new Set([2,3,4]);

function computeDsqBa(l, r) {
  const dx = l.x - r.x, dy = l.y - r.y, dz = l.z - r.z;
  return dx*dx + dy*dy + dz*dz;
}
function computeIsqrtBa(dsq) {
  if (dsq <= 0) return 0;
  const dist = Math.floor(Math.sqrt(dsq));
  if (dist * dist > dsq) return dist - 1;
  if ((dist + 1) * (dist + 1) <= dsq) return dist + 1;
  return dist;
}
function computeVdwBa(dist, typeL, typeR) {
  const sigma = (VDW_RADIUS_BA[typeL] || 170) + (VDW_RADIUS_BA[typeR] || 170);
  const eps = Math.floor(((VDW_EPSILON_BA[typeL] || 150) + (VDW_EPSILON_BA[typeR] || 150)) / 2);
  if (dist <= 0) return 0;
  const ratio100 = Math.floor((sigma * 100) / dist);
  const ratio = ratio100 / 100;
  const r6 = Math.pow(ratio, 6);
  const r12 = r6 * r6;
  const lj = eps * (r12 - 2 * r6);
  return Math.max(-10000, Math.min(10000, Math.round(lj)));
}
function computeElecBa(dist, chargeL, chargeR) {
  if (dist <= 0) return 0;
  const q = chargeL * chargeR;
  const denom = 4 * dist * dist;
  if (denom === 0) return 0;
  const raw = Math.round((332 * q) / (denom * 100));
  return Math.max(-5000, Math.min(5000, raw));
}
function computeHbondBa(dist, typeL, typeR) {
  if (!HBOND_TYPES_BA.has(typeL) || !HBOND_TYPES_BA.has(typeR)) return 0;
  if (dist < 200 || dist > 400) return 0;
  const optimal = 300;
  const deviation = Math.abs(dist - optimal);
  const maxDev = 120;
  if (deviation >= maxDev) return 0;
  const score = Math.round(500 * (1 - deviation / maxDev));
  return -score;
}
function computeBatchEnergyBrowser(ligandAtoms, receptorAtom) {
  const pairs = [];
  let batchTotal = 0;
  for (const la of ligandAtoms) {
    const dsq = computeDsqBa(la, receptorAtom);
    const dist = computeIsqrtBa(dsq);
    const vdw = computeVdwBa(dist, la.type, receptorAtom.type);
    const elec = computeElecBa(dist, la.charge, receptorAtom.charge);
    const hbond = computeHbondBa(dist, la.type, receptorAtom.type);
    const total = vdw + elec + hbond;
    batchTotal += total;
    pairs.push({ dsq, dist, vdw, elec, hbond, total });
  }
  return { pairs, batchTotal };
}

</script>
</body>
</html>`;
}
