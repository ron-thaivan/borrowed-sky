import {createNetworkTracker,networkStats,networkLayout} from './network-state.js';

const root=document.getElementById('computing-network');
root.innerHTML=`
 <div class="network-heading"><div><p class="eyebrow">CONNECTED BY COMPUTE</p><h3 id="network-title">One sky. Many machines.</h3><p>Follow the frames as your laptops build together.</p></div><span class="network-live" id="network-live" role="status">Waiting for room state</span></div>
 <div class="network-stats">${[['connected','Connected'],['active','Rendering'],['idle','Idle'],['completed','Frames complete'],['recovered','Reassignments']].map(([id,label])=>`<div><strong id="net-${id}">—</strong><span>${label}</span></div>`).join('')}</div>
 <div class="network-stage"><svg id="network-map" viewBox="0 0 1000 440" aria-label="Distributed rendering network" role="group"><defs><radialGradient id="network-aura"><stop stop-color="#1a789a" stop-opacity=".25"/><stop offset="1" stop-color="#081426" stop-opacity="0"/></radialGradient></defs><g id="network-backdrop"></g><g id="network-links"></g><g id="network-nodes"></g><g id="network-signals" aria-hidden="true"></g></svg></div>
 <div class="network-bottom"><div class="network-inspector" id="network-inspector" aria-live="polite">Select a laptop to inspect its contribution.</div><div class="network-legend"><span class="outbound">→ Assigned</span><span class="inbound">← Accepted</span><span class="recovery">← Requeued</span></div></div>
 <div class="network-history"><span>RECENT ACTIVITY</span><ol id="network-events" aria-label="Recent server activity"></ol><p id="network-note">Signals show confirmed server activity, delayed by polling. Idle devices do not send animated traffic.</p></div>`;
const $=id=>document.getElementById(id),NS='http://www.w3.org/2000/svg';
const tracker=createNetworkTracker(),nodes=new Map();
const motion=matchMedia('(prefers-reduced-motion: reduce)');
let current=null,self=null,selected=null,layout=null,raf=null,signals=[],visible=true,connected=true;
function svg(tag,attrs={},text){const el=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;return el;}
function put(id,text){if($(id).textContent!==String(text))$(id).textContent=text;}
function stopSignals(){cancelAnimationFrame(raf);raf=null;signals=[];$('network-signals').replaceChildren();}
function canAnimate(){return visible&&!document.hidden&&connected&&!motion.matches;}
function inspect(){
 const d=current?.devices.find(d=>d.id===selected);
 const text=d?`${d.name}${d.id===self?' (you)':''} · ${d.status}${d.simulatedFailure?' (simulated failure)':''}${d.paused&&d.status==='Rendering'?' — pausing after this frame':''} · ${d.completed} frames accepted · ${(d.renderTimeMs/1000).toFixed(2)}s render time${d.assignedFrames?.length?' · Working on frame '+d.assignedFrames.map(i=>i+1).join(', '):''}`:'Coordinator · Node.js server · Assigns frames, validates uploads, and recovers unfinished work. The host laptop contributes as a separate node.';
 put('network-inspector',text);
 for(const [id,node] of nodes){node.group.classList.toggle('selected',id===selected);node.group.setAttribute('aria-pressed',String(id===selected));}
}
function select(id){selected=id;inspect();}
function nodeFor(id,coordinator=false){
 if(nodes.has(id))return nodes.get(id);
 const group=svg('g',{'class':coordinator?'network-node coordinator':'network-node',tabindex:'0',role:'button','aria-pressed':'false'});
 const box=svg('rect',{x:-94,y:-40,width:188,height:80,rx:18,'class':'node-box'});
 const icon=svg('path',{d:coordinator?'M-10 -29h20v8h-20z M-10 -17h20v8h-20z':'M-12 -29h24v16h-24z M-17 -9h34','class':'node-icon'});
 const name=svg('text',{y:12,'class':'node-name','text-anchor':'middle'});
 const status=svg('text',{y:29,'class':'node-status','text-anchor':'middle'});
 const badge=svg('text',{y:57,'class':'node-badge','text-anchor':'middle'});
 group.append(box,icon,name,status,badge);group.onclick=()=>select(id);
 group.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(id);}};
 $('network-nodes').append(group);
 const node={group,box,name,status,badge};nodes.set(id,node);return node;
}
function flash(node,color){if(canAnimate())node.box.animate?.([{stroke:color,strokeWidth:4},{stroke:color,strokeWidth:1}],{duration:850});}
function describe(e){
 const name=current.devices.find(d=>d.id===e.device)?.name||'Contributor',frame=`Frame ${e.index+1}`;
 return e.type==='assigned'?`${frame} ${e.reassigned?'reassigned':'assigned'} → ${name}`:
  e.type==='completed'?`${frame} accepted ← ${name}`:
  e.type==='recovered'?`${frame} requeued ← ${name} (${e.reason})`:
  `${name} ${e.type}${e.simulated?' (simulation)':''}`;
}
function paint(time){
 raf=null;if(!canAnimate()){stopSignals();return;}
 signals=signals.filter(s=>{
  const progress=(time-s.start)/850;
  if(progress>=1){s.el.remove();return false;}
  const t=Math.max(0,progress),p=s.reverse?1-t:t;
  s.el.setAttribute('transform',`translate(${layout.center.x+(s.point.x-layout.center.x)*p} ${layout.center.y+(s.point.y-layout.center.y)*p})`);
  s.el.style.opacity=progress<0?'0':String(Math.min(1,t*8,(1-t)*8));return true;
 });
 if(signals.length)raf=requestAnimationFrame(paint);
}
function eventEffect(e,order){
 const node=nodes.get(e.device),point=layout.points.get(e.device);if(!node||!point)return;
 const color=e.type==='recovered'?'#ffc178':e.type==='completed'?'#72f5c1':'#65dfff';
 if(['assigned','completed','recovered'].includes(e.type)){
  node.badge.textContent=`#${String(e.index+1).padStart(3,'0')} · ${e.type==='completed'?'accepted':e.type==='recovered'?'requeued':e.reassigned?'reassigned':'assigned'}`;
  if(!canAnimate())return;
  flash(node,color);
  if(e.type==='completed')document.getElementById('frame-grid')?.children[e.index]?.animate?.([{boxShadow:'0 0 0 3px #72f5c1'},{boxShadow:'0 0 0 0 transparent'}],{duration:900});
  if(signals.length>=48){signals.shift().el.remove();}
  const el=svg('g');el.append(svg('circle',{r:12,fill:color,opacity:.12}),svg('circle',{r:4,fill:color}),svg('text',{x:0,y:-16,fill:color,'text-anchor':'middle','class':'signal-label'},`#${e.index+1}`));
  $('network-signals').append(el);el.style.opacity='0';
  signals.push({el,point,reverse:e.type!=='assigned',start:performance.now()+Math.min(order*55,660)});
  if(raf===null)raf=requestAnimationFrame(paint);
 }else if(e.type==='joined'||e.type==='reconnected'){
  if(canAnimate())node.group.animate?.([{opacity:0},{opacity:1}],{duration:700});
 }
}
export function networkConnection(value){
 connected=value;root.dataset.connected=String(value);
 put('network-live',value?'Live · server activity':'Connection lost · last known state');
 if(!value)stopSignals();
}
export function resetNetwork(){tracker.reset();stopSignals();current=null;selected=null;nodes.clear();$('network-nodes').replaceChildren();$('network-links').replaceChildren();$('network-events').replaceChildren();}
export function drawNetwork(s,id){
 const update=tracker.consume(s);if(update.stale)return;
 if(update.first){nodes.clear();$('network-nodes').replaceChildren();selected=null;}
 if(update.changed){stopSignals();$('network-events').replaceChildren();for(const node of nodes.values())node.badge.textContent='';}
 current=s;self=id;networkConnection(true);
 const next=networkLayout(s.devices);
 if(!layout||next.height!==layout.height||next.points.size!==layout.points.size)stopSignals();
 layout=next;
 for(const [key,value] of Object.entries(networkStats(s)))put('net-'+key,value);
 $('network-map').setAttribute('viewBox',`0 0 1000 ${layout.height}`);
 const center=layout.center;
 $('network-backdrop').replaceChildren(svg('circle',{cx:center.x,cy:center.y,r:260,fill:'url(#network-aura)'}),svg('circle',{cx:center.x,cy:center.y,r:116,'class':'network-ring'}),svg('circle',{cx:center.x,cy:center.y,r:150,'class':'network-ring outer'}));
 const hub=nodeFor('coordinator',true);hub.group.setAttribute('transform',`translate(${center.x} ${center.y})`);hub.name.textContent='Coordinator';hub.status.textContent='NODE.JS SERVER';hub.group.setAttribute('aria-label','Inspect coordinator');hub.badge.textContent=`${s.completed} / ${s.config.count} FRAMES ACCEPTED`;
 const links=[];
 for(const d of s.devices){
  const p=layout.points.get(d.id),node=nodeFor(d.id);
  node.group.setAttribute('transform',`translate(${p.x} ${p.y})`);node.group.dataset.status=d.status.toLowerCase();
  node.group.setAttribute('aria-label',`${d.name}${d.id===id?' (you)':''}, ${d.status}${d.simulatedFailure?' (simulated failure)':''}, ${d.completed} frames completed. Select for details.`);
  node.name.textContent=d.name.length>19?d.name.slice(0,18)+'…':d.name;
  node.status.textContent=d.simulatedFailure?'SIMULATED FAILURE':`${d.id===id?'YOU · ':''}${d.status.toUpperCase()}`;
  if(d.assignedFrames?.length)node.badge.textContent=`RENDERING #${String(d.assignedFrames[0]+1).padStart(3,'0')}`;
  else node.badge.textContent=`${d.completed} FRAMES ACCEPTED`;
  links.push(svg('line',{x1:center.x,y1:center.y,x2:p.x,y2:p.y,'class':'network-link '+d.status.toLowerCase()}));
 }
 $('network-links').replaceChildren(...links);
 const events=update.events;
 events.slice(-48).forEach(eventEffect);
 for(const e of events){const li=document.createElement('li');li.textContent=describe(e);li.dataset.type=e.type;$('network-events').prepend(li);while($('network-events').children.length>5)$('network-events').lastElementChild.remove();}
 put('network-note',update.gap?'Some earlier activity fell outside the recent history. Current counts are authoritative; missing transfers are not reconstructed.':'Signals show confirmed server activity, delayed by polling. Idle devices do not send animated traffic.');
 inspect();
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopSignals();});
motion.addEventListener('change',()=>{if(motion.matches)stopSignals();});
if(typeof IntersectionObserver!=='undefined')new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(!visible)stopSignals();},{threshold:0}).observe(root);
