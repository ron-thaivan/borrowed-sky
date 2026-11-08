import {drawNetwork,networkConnection} from './network.js';
const $=id=>document.getElementById(id);
$('live-dashboard').innerHTML=`
 <div class="dashboard-heading"><div><p class="eyebrow">MANY LAPTOPS. ONE SHARED SKY.</p><h3 id="dashboard-title">Live Contributor Dashboard</h3><p id="dashboard-run">Ready for the first frame</p></div><span id="dashboard-live" class="live-indicator" data-connected="true" role="status">Live · updates automatically</span></div>
 <div class="dashboard-stats">
  <div class="dashboard-stat"><span>Connected devices</span><strong id="dash-connected">0</strong><small>Host + contributors</small></div>
  <div class="dashboard-stat"><span>Frames completed</span><strong id="dash-completed">0</strong><small>Accepted by the server</small></div>
  <div class="dashboard-stat"><span>Frames remaining</span><strong id="dash-remaining">120</strong><small>Queued + assigned</small></div>
  <div class="dashboard-stat"><span>Frames assigned</span><strong id="dash-assigned">0</strong><small>Currently in progress</small></div>
  <div class="dashboard-stat accent"><span>Overall progress</span><strong id="dash-percent">0%</strong><small>This rendering session</small></div>
  <div class="dashboard-stat accent"><span>Network frames / sec</span><strong id="dash-fps">0</strong><small>Rolling 5-second window</small></div>
 </div>
 <div class="dashboard-progress"><div><span id="dash-progress-label"></span><span id="dash-updated"></span></div><progress id="dash-progress" max="120" value="0" aria-label="Overall rendering progress"></progress></div>
 <section class="dashboard-section" aria-labelledby="contributors-title"><div class="dashboard-section-heading"><h4 id="contributors-title">The contributor fleet</h4><p>Every device in this room. Completed work stays credited when a device disconnects.</p><p class="dashboard-table-hint">Scroll the table sideways for all device metrics.</p></div><div class="table-wrap" tabindex="0" role="region" aria-label="Contributor metrics"><table><thead><tr><th scope="col">Device</th><th scope="col">Role</th><th scope="col">Connection</th><th scope="col">Activity</th><th scope="col">Completed</th><th scope="col">Assigned</th><th scope="col">Avg / frame</th><th scope="col">Frames / sec</th><th scope="col">Work share</th><th scope="col">Device ID</th></tr></thead><tbody id="contributor-rows"></tbody></table></div></section>
 <div class="dashboard-bottom"><section class="dashboard-section" aria-labelledby="leaderboard-title"><div class="dashboard-section-heading"><h4 id="leaderboard-title">Contributor leaderboard</h4><p id="leaderboard-note"></p></div><div class="table-wrap" tabindex="0" role="region" aria-label="Contributor ranking"><table><thead><tr><th scope="col">Rank</th><th scope="col">Device</th><th scope="col">Frames</th><th scope="col">Work share</th><th scope="col">Avg / frame</th></tr></thead><tbody id="leaderboard-rows"></tbody></table></div></section>
 <aside class="dashboard-methods"><h4>Real work. Visible progress.</h4><p><strong>Frames / sec</strong> counts accepted frames over the last 5 seconds, using elapsed run time at startup. It falls to zero when work stops.</p><p><strong>Avg / frame</strong> is accepted worker render time, excluding transfer and queue time. Lower is faster.</p><p><strong>Work share</strong> is a device's share of completed frames in this run. Pausing finishes the current frame. Missing heartbeats mark a device disconnected after 7 seconds and requeue its unfinished work.</p></aside></div>`;
const rows=new Map(),ranks=new Map();
let hasSnapshot=false;
for(const id of ['dash-connected','dash-completed','dash-remaining','dash-assigned','dash-percent','dash-fps'])$(id).textContent='—';
$('dashboard-run').textContent='Waiting for room state';
$('dashboard-live').textContent='Connecting to the server';
const number=n=>n.toLocaleString(undefined,{maximumFractionDigits:2});
const average=ms=>ms===null?'—':(ms/1000).toFixed(2)+' s';
function put(el,value){const text=String(value);if(el.textContent!==text)el.textContent=text;}
function rowFor(cache,id,count){
 if(!cache.has(id)){
  const row=document.createElement('tr');
  for(let i=0;i<count;i++)row.append(document.createElement('td'));
  cache.set(id,row);
 }
 return cache.get(id);
}
function syncRows(body,cache,ids){
 const keep=new Set(ids);
 for(const [id,row] of cache)if(!keep.has(id)){row.remove();cache.delete(id);}
 // Only move rows if order changed; preserve selection and horizontal scrolling.
 ids.forEach((id,i)=>{const row=cache.get(id);if(body.children[i]!==row)body.insertBefore(row,body.children[i]||null);});
}
export function dashboardConnection(connected){
 networkConnection(connected);
 const el=$('dashboard-live');
 put(el,connected?'Live · updates automatically':hasSnapshot?'Connection lost · showing last snapshot':'Waiting for server connection');
 el.dataset.connected=String(connected);
}
export function drawDashboard(s,self){
 const d=s.dashboard;if(!d)return;
 drawNetwork(s,self);
 hasSnapshot=true;
 dashboardConnection(true);
 put($('dash-connected'),d.connected);put($('dash-completed'),d.completed);
 put($('dash-remaining'),d.remaining);put($('dash-assigned'),d.assigned);
 put($('dash-percent'),Math.floor(d.progressPercent)+'%');put($('dash-fps'),number(d.fps));
 $('dash-progress').max=s.config.count;$('dash-progress').value=d.completed;
 put($('dash-progress-label'),d.completed+' of '+s.config.count+' frames complete · '+d.queued+' queued');
 put($('dash-updated'),'Server snapshot '+new Date(d.updatedAt).toLocaleTimeString());
 put($('dashboard-run'),s.finished?'Render complete':s.started?'Rendering together':'Ready for the first frame');
 const byId=new Map(s.devices.map(device=>[device.id,device]));
 const leaders=new Set(d.leaderboard.filter(r=>r.isLeader).map(r=>r.id));
 for(const device of s.devices){
  const row=rowFor(rows,device.id,10),cells=row.children;
  const values=[device.name+(device.id===self?' (you)':''),device.role,device.simulatedFailure?'Disconnected · simulated':device.online?'Connected':'Disconnected',device.status,
   device.completed,device.assigned,average(device.averageFrameMs),number(device.fps),device.workSharePercent.toFixed(1)+'%',device.id.slice(0,8)];
  values.forEach((v,i)=>put(cells[i],v));
  cells[3].dataset.status=device.status.toLowerCase();
  cells[2].dataset.online=String(device.online);
  cells[5].title=device.assignedFrames.length?'Frame '+device.assignedFrames.map(i=>i+1).join(', '):'No active assignment';
  row.classList.toggle('is-leader',leaders.has(device.id));row.classList.toggle('is-offline',!device.online);
 }
 syncRows($('contributor-rows'),rows,s.devices.map(device=>device.id));
 for(const entry of d.leaderboard){
  const device=byId.get(entry.id),row=rowFor(ranks,entry.id,5);
  const values=[device.completed?String(entry.rank).padStart(2,'0'):'—',
   device.name+(entry.isLeader?(leaders.size>1?' · Joint leader':' · Top contributor'):''),
   device.completed,device.workSharePercent.toFixed(1)+'%',average(device.averageFrameMs)];
  values.forEach((v,i)=>put(row.children[i],v));row.classList.toggle('is-leader',entry.isLeader);
 }
 syncRows($('leaderboard-rows'),ranks,d.leaderboard.map(entry=>entry.id));
 put($('leaderboard-note'),d.completed?'Ranked by accepted frames in this render. Ties share a rank.':'The first accepted frame starts the leaderboard.');
}
