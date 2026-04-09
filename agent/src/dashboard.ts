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
</style>
</head>
<body>
<h1>MolDock Agent Swarm</h1>
<div class="subtitle">On-chain molecular docking via BSV covenant chains &mdash; AI agents exchange value autonomously</div>
<div class="node-status" id="node-status">Node: checking...</div>

<!-- Browser Compute Agent -->
<div class="agent-banner">
  <div class="banner-top">
    <div>
      <h2>&#x1f9ec; Browser Compute Agent</h2>
      <div class="banner-desc">Run a compute agent directly in your browser. Earn BSV by verifying molecular docking calculations on-chain.</div>
    </div>
    <button class="start-btn" id="start-btn" onclick="toggleBrowserAgent()">Start Computing</button>
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

<!-- TX Volume Target -->
<div class="target-bar">
  <div class="target-label">Transaction Volume Target: 1,500,000 TXs in 24h</div>
  <div class="target-progress">
    <div class="target-fill" id="target-fill" style="width:0%"></div>
    <span class="target-text" id="target-text">0 / 1,500,000</span>
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
      <thead><tr><th>#</th><th>Molecule</th><th>Score</th><th>Result</th><th>Agent</th><th>TXs</th></tr></thead>
      <tbody id="leaderboard"></tbody>
    </table>
  </div>
</div>

<script>
const $=id=>document.getElementById(id);
function fmt(ms){if(!ms)return'--';if(ms<1000)return ms.toFixed(0)+'ms';if(ms<60000)return(ms/1000).toFixed(1)+'s';return(ms/60000).toFixed(1)+'m'}
function fmtBytes(b){if(!b)return'0B';if(b>1048576)return(b/1048576).toFixed(1)+'MB';if(b>1024)return(b/1024).toFixed(0)+'KB';return b+'B'}

// Trust badge
function trustBadge(level){
  const labels=['NEW','PROVEN','TRUSTED'];
  return '<span class="trust-badge trust-'+level+'">'+(labels[level]||'?')+'</span>';
}
const nameColors=['#00ccff','#00ff88','#ffaa00','#ff6699','#aa88ff','#88ddff','#44ffaa','#ffcc44'];

// ========== Dashboard Refresh ==========
async function refresh(){
  try{
    const[stats,agents,events,results,node]=await Promise.all([
      fetch('/api/stats').then(r=>r.json()),
      fetch('/api/agents').then(r=>r.json()),
      fetch('/api/events').then(r=>r.json()),
      fetch('/api/results').then(r=>r.json()),
      fetch('/api/node').then(r=>r.json()).catch(()=>({status:'disconnected'})),
    ]);

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
    const TARGET = 1500000;
    const pct = Math.min(100, totalTxs / TARGET * 100);
    $('target-fill').style.width = pct.toFixed(2) + '%';
    $('target-text').textContent = totalTxs.toLocaleString() + ' / 1,500,000';

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
    $('leaderboard').innerHTML=sorted.slice(0,25).map((r,i)=>{
      const cls=r.passed?'score good':'score bad';
      const res=r.passed?'<span class="pass">PASS</span>':'<span class="fail">FAIL</span>';
      return '<tr><td class="rank">#'+(i+1)+'</td><td>'+r.moleculeId+'</td><td class="'+cls+'">'+r.finalScore+'</td><td>'+res+'</td><td style="color:#888">'+(r.agentName||'')+'</td><td>'+r.totalTxs+'</td></tr>';
    }).join('');

  }catch(e){console.error('refresh',e)}
}
setInterval(refresh,500);
refresh();

// ========== Browser Compute Agent ==========
// Runs entirely client-side: fetches work from dispatch, computes energy,
// submits results. No @bsv/sdk needed in browser — energy.ts is pure math.

let browserAgentRunning = false;
let browserAgentId = null;
let baStats = { molecules: 0, passed: 0, failed: 0, txs: 0, earned: 0 };
const baScoreHistory = [];

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
    $('start-btn').className = 'start-btn';
    $('ba-status').textContent = 'stopped';
    baLog('Agent stopped.', '#ff6644');
    return;
  }

  // Start
  browserAgentRunning = true;
  $('start-btn').textContent = 'Stop';
  $('start-btn').className = 'stop-btn';
  $('browser-stats').style.display = 'flex';
  $('browser-log').style.display = 'block';
  $('ba-status').textContent = 'starting...';

  // Generate random agent name
  const agentName = 'Browser-' + Math.random().toString(36).slice(2, 6);
  baLog('Starting as ' + agentName + '...', '#00ccff');

  try {
    // Register
    const regRes = await fetch('/api/agent/register', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ name: agentName, pubkey: '0'.repeat(66), paymail: null }),
    }).then(r => r.json());

    if (regRes.error) { baLog('Registration failed: ' + regRes.error, '#ff4444'); browserAgentRunning = false; return; }
    browserAgentId = regRes.agent.id;
    baLog('Registered! ID: ' + browserAgentId, '#00ff88');

    // Work loop
    await browserWorkLoop();
  } catch (err) {
    baLog('Error: ' + err.message, '#ff4444');
    browserAgentRunning = false;
    $('start-btn').textContent = 'Start Computing';
    $('start-btn').className = 'start-btn';
  }
}

async function browserWorkLoop() {
  while (browserAgentRunning) {
    try {
      $('ba-status').textContent = 'requesting work...';
      const workRes = await fetch('/api/agent/' + browserAgentId + '/work').then(r => r.json());
      if (workRes.error) {
        $('ba-status').textContent = 'waiting...';
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const work = workRes.work;
      const molId = work.molecule.id;
      const numAtoms = work.molecule.atoms.length;
      const numSteps = work.numSteps;
      $('ba-status').textContent = molId.slice(0, 20) + '...';
      baLog('Computing: ' + molId + ' (' + numAtoms + ' atoms x ' + numSteps + ' steps)');

      // Compute energy (pure math, no BSV SDK needed)
      const t0 = performance.now();
      let totalScore = 0;
      for (const rAtom of work.receptor.atoms) {
        const batch = computeBatchEnergyBrowser(work.molecule.atoms, rAtom);
        totalScore += batch.batchTotal;
      }
      const elapsed = (performance.now() - t0).toFixed(0);

      baStats.molecules++;
      baStats.txs += numSteps + 1;

      const passed = baIsPassing(totalScore);

      if (passed) {
        baStats.passed++;
        baLog('PASS score=' + totalScore + ' (' + elapsed + 'ms)', '#00ff88');

        // Submit pass (no chain TXs in browser — dispatch handles broadcasting)
        const passRes = await fetch('/api/agent/' + browserAgentId + '/pass', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ workId: work.id, finalScore: totalScore, chainTxHexes: [] }),
        }).then(r => r.json());

        if (passRes.ok) {
          const reward = 100 + (10 * numSteps);
          baStats.earned += 100; // dispatch pays 100 sats per work
          // Confirm
          await fetch('/api/agent/' + browserAgentId + '/confirm', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ workId: work.id, txids: [] }),
          });
        }
      } else {
        baStats.failed++;
        baLog('FAIL score=' + totalScore + ' (' + elapsed + 'ms)', '#ff6644');
        await fetch('/api/agent/' + browserAgentId + '/fail', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ workId: work.id, finalScore: totalScore }),
        });
        baStats.earned += 100;
      }

      baUpdateStats();
      $('ba-status').textContent = 'idle';

    } catch (err) {
      baLog('Error: ' + err.message, '#ff4444');
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ========== Browser Energy Computation ==========
// Pure JavaScript port of energy.ts — runs in any browser, no dependencies.

function computeBatchEnergyBrowser(ligandAtoms, receptorAtom) {
  const pairs = [];
  let batchTotal = 0;
  for (const lAtom of ligandAtoms) {
    const dx = lAtom.x - receptorAtom.x;
    const dy = lAtom.y - receptorAtom.y;
    const dz = lAtom.z - receptorAtom.z;
    const dsq = dx * dx + dy * dy + dz * dz;

    // isqrt approximation (matching on-chain Script)
    let dist = 0;
    if (dsq > 0) {
      let x = dsq;
      let y = (x + 1) >> 1;
      while (y < x) { x = y; y = (x + Math.floor(dsq / x)) >> 1; }
      dist = x;
    }

    // van der Waals
    const vdw = dist > 0 ? Math.floor(10000 / (dist * dist)) : 10000;

    // Electrostatic
    const q1 = lAtom.charge || 0;
    const q2 = receptorAtom.charge || 0;
    const elec = dist > 0 ? Math.floor((q1 * q2) / dist) : 0;

    // H-bond
    const hbond = (lAtom.type === receptorAtom.type && dist < 350) ? -500 : 0;

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
