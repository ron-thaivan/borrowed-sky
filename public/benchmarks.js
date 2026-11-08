const root=document.getElementById('benchmarks');
root.innerHTML=`<div class="bench-heading"><div><p class="eyebrow">MEASURED / NOT ESTIMATED</p><h3>Performance lab</h3></div><button id="bench-refresh" class="small secondary">Refresh history</button></div>
<p>Compare completed renders in this room. Devices below count browser identities that delivered at least one accepted frame, not idle connections.</p>
<details class="benchmark-protocol"><summary>Set up a comparable benchmark</summary><fieldset id="bench-setup"><legend>Optional controlled benchmark — before each render</legend>
<label for="bench-series">Test series and conditions</label><input id="bench-series" maxlength="160" placeholder="e.g. Lab A · plugged in · Chrome · same Wi-Fi">
<label class="bench-confirm"><input id="bench-confirm" type="checkbox"> For this run, I confirm distinct physical laptops, the same coordinator, network, power/browser settings and background load as this series, with the baseline laptop included. Warm-up policy is consistent.</label>
<p>For a baseline, render with only one laptop contributing. Then add a second and third laptop and repeat the same workload. Start resumes all joined devices; leave unused devices out of the room. Repeat each configuration to assess variability.</p></fieldset></details>
<p id="bench-status" role="status"></p><div id="bench-cards" class="bench-cards"></div>
<label for="bench-baseline">Single-device baseline</label><select id="bench-baseline"><option value="">First eligible baseline per run</option></select>
<div id="bench-charts" class="bench-charts"></div>
<h4>Previous completed runs</h4><div class="bench-scroll" tabindex="0" role="region" aria-label="Benchmark history, scroll for all metrics"><table><thead><tr><th>Completed / configuration</th><th>Devices</th><th>Wall time</th><th>Total Worker Render Time</th><th>Frames/s</th><th>Average frame</th><th>Payload</th><th>Speedup / time saved</th></tr></thead><tbody id="bench-history"></tbody></table></div>
<div class="bench-definitions"><p><strong>Wall time</strong> is coordinator start to last accepted frame upload. It includes coordination and transfer, but excludes final GIF assembly. Run throughput is completed frames ÷ wall seconds.</p><p><strong>Total Worker Render Time</strong> adds accepted frame render durations, including OS scheduling. Average frame time divides this sum by accepted frames. Neither measures CPU utilization; worker time ÷ wall time is not speedup.</p><p><strong>Accepted payload</strong> counts raw indexed frame bytes, excluding base64, HTTP, retries and GIF. Speedup = single-device wall time ÷ multi-device wall time. Conditions are host-attested, not automatically verified. Recovery runs are excluded from speedup.</p></div>
<p>History retains the latest 50 completed runs in this room, in coordinator memory. Restarting the server clears it. Download a copy to keep your measurements.</p><button id="bench-export" class="small secondary" disabled>Download measurements JSON ↓</button>`;
const $=id=>document.getElementById(id);
const number=(n,d=2)=>n==null?'—':n.toLocaleString(undefined,{maximumFractionDigits:d});
let owner=null,key=null,request=null,serial=0,runs=[],lastRun=null;
const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
export function resetBenchmarks(){owner=null;key=null;request=null;runs=[];lastRun=null;serial++;root.hidden=true;}
export function benchmarkRequest(){
 return $('bench-confirm').checked?{benchmark:{series:$('bench-series').value,confirmed:true}}:{};
}
export function updateBenchmarks(state,session,api){
 root.hidden=state.host!==session.id;if(root.hidden)return;
 const nextOwner=session.code+session.id;
 if(owner!==nextOwner){owner=nextOwner;key=null;runs=[];lastRun=null;$('bench-series').value='';$('bench-confirm').checked=false;$('bench-baseline').replaceChildren(new Option('First eligible baseline per run',''));render();}
 if(lastRun!==state.run){$('bench-confirm').checked=false;lastRun=state.run;}
 $('bench-setup').disabled=state.started!==null&&state.finished===null;
 request=api;
 const nextKey=owner+':'+(state.finished===null?'pending':state.run);
 if(key!==nextKey){key=nextKey;void refresh();}
}
async function refresh(){
 if(!request)return;const ticket=++serial,identity=owner;
 $('bench-status').textContent='Loading measured runs…';
 try{const result=await request('benchmarks',{baselineId:$('bench-baseline').value||null});
  if(ticket!==serial||identity!==owner)return;runs=result.runs;
  const selected=$('bench-baseline').value;
  $('bench-baseline').replaceChildren(new Option('First eligible baseline per run',''),...runs.filter(r=>r.deviceCount===1).map(r=>new Option(new Date(r.completedAt).toLocaleString()+' · '+r.config.theme,r.id)));
  $('bench-baseline').value=runs.some(r=>r.id===selected)?selected:'';render();
  $('bench-status').textContent=runs.length?`${runs.length} completed runs · updated ${new Date().toLocaleTimeString()}`:'No completed runs yet. Render a sky to record the first measurement.';
 }catch(e){if(ticket===serial&&identity===owner){if(e.status===400)$('bench-baseline').value='';key=null;$('bench-status').textContent='History unavailable: '+e.message;}}
}
function render(){
 const cards=$('bench-cards');cards.replaceChildren();
 for(const count of [1,2,3]){const run=runs.findLast(r=>r.deviceCount===count),card=el('article');card.append(el('span',count+'-device · latest run'),el('strong',run?number(run.wallTimeMs/1000)+' s':'No measured run'),el('small',run?number(run.fps)+' frames/s · '+run.config.theme+' · '+run.config.width+'×'+run.config.height+' / '+run.config.count+' frames':'Complete this configuration to compare'));cards.append(card);}
 const latest=runs.at(-1),card=el('article');card.append(el('span','Latest accepted work'),el('strong',latest?latest.framesCompleted+' frames':'—'),el('small',latest?number(latest.payloadBytes/1024)+' KiB payload':'Waiting for a completed render'));cards.append(card);
 const charts=$('bench-charts');charts.replaceChildren();
 for(const [field,label,scale,unit] of [['wallTimeMs','Rendering wall time',.001,'s'],['fps','Run throughput',1,'frames/s'],['averageFrameMs','Average frame processing time',1,'ms/frame']]){
  const chart=el('article');chart.append(el('h4',label),el('p','Last 8 runs · workload labels shown; bars alone do not imply comparable conditions.'));
  const recent=runs.slice(-8),max=Math.max(1,...recent.map(r=>(r[field]||0)*scale));
  for(const r of recent){const row=el('div');row.className='bench-bar-row';row.append(el('span',new Date(r.completedAt).toLocaleTimeString()+' · '+r.deviceCount+' devices · '+r.config.theme+' · '+r.config.width+'×'+r.config.height+' / '+r.config.count+'f'));
   const track=el('div');track.className='bench-track';const bar=el('div');bar.className='bench-bar';bar.style.width=((r[field]||0)*scale/max*100)+'%';track.append(bar);row.append(track,el('strong',number(r[field]==null?null:r[field]*scale)+' '+unit));chart.append(row);}
  if(!recent.length)chart.append(el('p','No measurements yet.'));charts.append(chart);
 }
 const body=$('bench-history');body.replaceChildren();
 for(const r of [...runs].reverse()){
  const row=el('tr'),c=r.config,comparison=r.comparison;
  const values=[new Date(r.completedAt).toLocaleString()+' · '+c.width+'×'+c.height+' · '+c.count+' frames · '+c.fps+' playback FPS · '+c.theme+' · '+(r.conditions?.series||'Unconfirmed conditions'),r.deviceCount,number(r.wallTimeMs/1000)+' s',number(r.workerTimeMs/1000)+' s',number(r.fps),number(r.averageFrameMs)+' ms',number(r.payloadBytes/1024)+' KiB',comparison.speedup===null?comparison.reason:number(comparison.speedup)+'× / '+number(comparison.timeReductionPercent)+'%'];
  for(const value of values)row.append(el('td',String(value)));body.append(row);
 }
 $('bench-export').disabled=!runs.length;
}
$('bench-refresh').onclick=refresh;$('bench-baseline').onchange=refresh;
$('bench-export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({exportedAt:new Date().toISOString(),runs},null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download='borrowed-sky-benchmarks.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
