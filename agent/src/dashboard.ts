/**
 * Dashboard HTML template for MolDock Agent Swarm.
 * Pure function — no state, no imports. Just returns the HTML string.
 */

export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>MolDock Agent Swarm</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace; background: #0a0a0a; color: #e0e0e0; padding: 20px; max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 22px; color: #00ff88; margin-bottom: 4px; }
  .subtitle { font-size: 12px; color: #555; margin-bottom: 16px; }
  .node-status { font-size: 11px; color: #555; margin-bottom: 12px; }
  .node-status .on { color: #00ff88; }
  .controls { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .btn { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 8px 14px; color: #00ff88; font-family: inherit; font-size: 12px; cursor: pointer; transition: all 0.15s; }
  .btn:hover { background: #222; border-color: #00ff88; }
  .btn.danger { color: #ff4444; border-color: #333; }
  .btn.danger:hover { border-color: #ff4444; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .card { background: #1a1a1a; border: 1px solid #222; border-radius: 8px; padding: 14px; }
  .card h2 { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .card .val { font-size: 22px; font-weight: bold; color: #00ff88; }
  .card .sub { font-size: 10px; color: #555; margin-top: 3px; }
  .progress-bar { background: #222; border-radius: 3px; height: 4px; margin-top: 6px; overflow: hidden; }
  .progress-fill { background: linear-gradient(90deg, #00ff88, #00cc66); height: 100%; transition: width 0.3s; }
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
  .download-bar { background: linear-gradient(135deg, #1a1a2e, #16213e); border: 1px solid #0f3460; border-radius: 8px; padding: 14px 18px; margin-bottom: 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .download-bar .dl-title { font-size: 13px; color: #00ccff; font-weight: bold; }
  .download-bar .dl-cmd { background: #0a0a0a; border: 1px solid #333; border-radius: 4px; padding: 6px 12px; font-size: 11px; color: #e0e0e0; font-family: inherit; cursor: pointer; user-select: all; flex: 1; min-width: 300px; }
  .download-bar .dl-cmd:hover { border-color: #00ccff; }
  .download-bar .dl-or { color: #555; font-size: 10px; }
  .download-bar .dl-btn { background: #0f3460; border: 1px solid #00ccff; border-radius: 6px; padding: 6px 14px; color: #00ccff; font-family: inherit; font-size: 11px; cursor: pointer; text-decoration: none; }
  .download-bar .dl-btn:hover { background: #16213e; }
  .waiting-msg { text-align: center; padding: 30px; color: #555; font-size: 13px; }
  .waiting-msg .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ffaa00; animation: pulse 1.5s infinite; margin-right: 8px; }
  @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
</style>
</head>
<body>
<h1>MolDock Agent Swarm</h1>
<div class="subtitle">On-chain molecular docking via BSV covenant chains &mdash; distributed agent network</div>
<div class="node-status" id="node-status">Node: checking...</div>

<div class="download-bar">
  <span class="dl-title">Run an Agent &mdash; Earn BSV</span>
  <code class="dl-cmd" onclick="this.select?.()" id="dl-cmd">node moldock-agent.mjs --server http://localhost:3456</code>
  <span class="dl-or">or</span>
  <a class="dl-btn" href="/moldock-agent.mjs" download>Download Agent</a>
  <span style="color:#555;font-size:10px" id="agent-count"></span>
</div>

<div class="controls">
  <button class="btn" onclick="dock(20,3,3)">20 mol / 3 atoms</button>
  <button class="btn" onclick="dock(50,3,3)">50 mol / 3 atoms</button>
  <button class="btn" onclick="dock(100,3,3)">100 mol / 3 atoms</button>
  <button class="btn" onclick="dock(30,5,8)">30 mol / 5x8</button>
  <button class="btn" onclick="dock(20,8,12)">20 mol / 8x12</button>
  <button class="btn" style="color:#00ccff;border-color:#00ccff" onclick="dockReal(27)">CDK2 Real (27)</button>
  <button class="btn" style="color:#00ccff;border-color:#00ccff" onclick="dockReal(54)">CDK2 Real x2</button>
  <button class="btn danger" onclick="fetch('/api/abort',{method:'POST'})">Abort</button>
</div>

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

async function dock(n,atoms,rec){try{const r=await fetch('/api/dock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({numMolecules:n,numAtoms:atoms,numReceptorAtoms:rec})});const d=await r.json();if(d.error)alert(d.error)}catch(e){console.error(e)}}

async function dockReal(n){try{const r=await fetch('/api/dock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({numMolecules:n,useReal:true})});const d=await r.json();if(d.error)alert(d.error)}catch(e){console.error(e)}}

// Trust badge HTML
function trustBadge(level){
  const labels=['NEW','PROVEN','TRUSTED'];
  return '<span class="trust-badge trust-'+level+'">'+(labels[level]||'?')+'</span>';
}

// Agent name colors (cycle)
const nameColors=['#00ccff','#00ff88','#ffaa00','#ff6699','#aa88ff','#88ddff','#44ffaa','#ffcc44'];

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
    $('node-status').innerHTML=node.status==='connected'
      ?'Node: <span class="on">connected</span> &mdash; height '+node.height
      :'Node: disconnected';

    // Update download command with actual server URL
    const host=location.host;
    $('dl-cmd').textContent='node moldock-agent.mjs --server http://'+host;

    // Agent count badge
    const ac=agents.length;
    $('agent-count').textContent=ac>0?ac+' agent'+(ac>1?'s':'')+' connected':'no agents yet';

    // Stats cards
    $('agent-val').textContent=(stats.activeAgents||0)+'/'+(stats.totalAgents||0);
    $('agent-sub').textContent=(stats.activeAgents||0)+' working';

    const proc=stats.processed||0;
    const total=stats.totalMolecules||0;
    $('proc-val').textContent=total>0?proc+'/'+total:proc.toString();
    $('proc-sub').textContent=stats.config?(stats.config.numAtoms||'?')+' atoms x '+(stats.config.numReceptorAtoms||'?')+' receptor':'';
    if(total>0)$('proc-bar').style.width=(proc/total*100)+'%';

    $('tx-val').textContent=(stats.totalTxs||0).toLocaleString();
    $('tx-sub').textContent=(stats.txsPerSecond||0).toFixed(1)+' tx/s | '+fmt(stats.elapsedMs);

    const rate=proc>0?((stats.passed||0)/proc*100).toFixed(0):'--';
    $('pass-val').textContent=rate+(rate!=='--'?'%':'');
    $('pass-sub').textContent=(stats.passed||0)+' pass / '+(stats.failed||0)+' fail';

    $('bytes-val').textContent=fmtBytes(stats.totalBytes||0);
    $('bytes-sub').textContent=stats.status||'';

    const rewards=stats.totalRewards||0;
    $('reward-val').textContent=rewards>0?(rewards/100000000).toFixed(4)+' BSV':'0';
    $('reward-sub').textContent=rewards.toLocaleString()+' sats';

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
          ?'<span class="status-working">'+(a.currentMoleculeId||'').slice(0,12)+'</span>'
          :a.status==='idle'
            ?'<span class="status-idle">idle</span>'
            :'<span class="status-offline">offline</span>';
        const rewardStr=a.totalRewards>0?a.totalRewards.toLocaleString()+' sats':'0';
        const bytesStr=fmtBytes(a.totalBytes||0);
        return '<tr class="agent-row">'+
          '<td><span class="agent-name" style="color:'+color+'">'+a.name+'</span></td>'+
          '<td>'+trustBadge(a.trustLevel)+'</td>'+
          '<td>'+statusHtml+'</td>'+
          '<td>'+a.processed+'</td>'+
          '<td class="pass">'+a.passed+'</td>'+
          '<td class="fail">'+a.failed+'</td>'+
          '<td style="color:#ffaa00">'+rewardStr+'</td>'+
          '<td>'+a.totalTxs+'</td>'+
          '<td style="color:#888">'+bytesStr+'</td>'+
          '</tr>';
      }).join('');
    }

    // Event log
    $('log').innerHTML=(events||[]).slice().reverse().slice(0,60).map(e=>{
      const cls='ev-'+(e.type||'');
      const mol=e.moleculeId?' '+e.moleculeId:'';
      const sc=e.score!==undefined?' score='+e.score:'';
      const rw=e.rewardSats?' +'+e.rewardSats+' sats':'';
      const time=e.timestamp?new Date(e.timestamp).toLocaleTimeString():'';
      return '<div class="ev '+cls+'"><span style="color:#444;font-size:9px">'+time+'</span> <strong>['+e.agentName+']</strong> '+e.type.toUpperCase()+mol+sc+rw+'</div>';
    }).join('');

    // Leaderboard
    $('leaderboard').innerHTML=(results.ranked||[]).slice(0,25).map((r,i)=>{
      const cls=r.passed?'score good':'score bad';
      const res=r.passed?'<span class="pass">PASS</span>':'<span class="fail">FAIL</span>';
      return '<tr><td class="rank">#'+(i+1)+'</td><td>'+r.moleculeId+'</td><td class="'+cls+'">'+r.finalScore+'</td><td>'+res+'</td><td style="color:#888">'+(r.agentName||'')+'</td><td>'+r.totalTxs+'</td></tr>';
    }).join('');

  }catch(e){console.error('refresh error',e)}
}
setInterval(refresh,500);
refresh();
</script>
</body>
</html>`;
}
