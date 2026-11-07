import './motion.js';
import {palette} from './renderer.js';
import {encodeGif} from './gif.js';
const $=id=>document.getElementById(id);
let session=null,state=null,worker=null,busy=false,paused=false,joining=false,generation=0,downloadUrl=null,assembledRun=null,assembling=false,animation=null;
let activeJob=null,polling=false,pollAgain=false;
const ctx=$('preview').getContext('2d');
const say=text=>$('message').textContent=text;
async function api(action,body={}) {
 const res=await fetch('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...session,...body}),signal:AbortSignal.timeout(10000)});
 const data=await res.json();if(!res.ok)throw Object.assign(new Error(data.error),{status:res.status});return data;
}
let frameImages=new WeakMap();
function configurePreview(config){
 const canvas=$('preview');
 if(canvas.width!==config.width||canvas.height!==config.height){canvas.width=config.width;canvas.height=config.height;frameImages=new WeakMap();}
 canvas.parentElement.style.aspectRatio=`${config.width} / ${config.height}`;
 $('resolution').textContent=`${config.width} × ${config.height} / ${config.fps} FPS`;
 $('duration').textContent=`${(config.count/config.fps).toFixed(1)} seconds. One shared sky.`;
 $('progress').max=config.count;
}
function imageFor(pixels){
 let image=frameImages.get(pixels);if(image)return image;
 if(pixels.length!==$('preview').width*$('preview').height)throw new Error('Unexpected preview frame dimensions');
 image=ctx.createImageData($('preview').width,$('preview').height);const rgba=image.data;
 for(let i=0,j=0;i<pixels.length;i++,j+=4){const c=palette[pixels[i]];rgba[j]=c[0];rgba[j+1]=c[1];rgba[j+2]=c[2];rgba[j+3]=255;}
 frameImages.set(pixels,image);return image;
}
function showFrame(pixels){ctx.putImageData(imageFor(pixels),0,0);}
function stopAnimation(){cancelAnimationFrame(animation);animation=null;}
function playFrames(frames,fps){
 stopAnimation();let start=null,last=-1;
 const paint=time=>{if(start===null)start=time;const index=Math.floor((time-start)*fps/1000)%frames.length;if(index!==last){showFrame(frames[index]);last=index;}animation=requestAnimationFrame(paint);};
 animation=requestAnimationFrame(paint);
}
function base64(pixels){let s='';for(let i=0;i<pixels.length;i++)s+=String.fromCharCode(pixels[i]);return btoa(s);}
function decode(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
function resetWorker(){generation++;worker?.terminate();worker=null;busy=false;activeJob=null;}
function updatePauseButton(){$('pause').textContent=paused?'Resume contribution':'Pause my contribution';}
function draw(s){
 if(state?.code===s.code&&s.revision<state.revision)return;
 if(state?.run!==s.run){
  resetWorker();stopAnimation();paused=false;updatePauseButton();
  $('download').hidden=true;assembledRun=null;
  if(downloadUrl){URL.revokeObjectURL(downloadUrl);downloadUrl=null;}
 }
 configurePreview(s.config);
 state=s;const isHost=session.id===s.host;
 $('room-code').textContent=s.code;$('start').hidden=!isHost;$('start').disabled=!!s.started&&!s.finished;
 $('start').textContent=s.finished?'Render again ↗':'Start rendering ↗';
 $('role-note').textContent=isHost?'You are hosting. Share the invite, then start. Your laptop contributes too.':'You are contributing. The host starts the render and downloads the finished animation.';
 $('phase').textContent=s.finished?'COMPLETE':s.started?'RENDERING':'READY';
 $('percent').innerHTML=Math.floor(s.completed/s.config.count*100)+'<span>%</span>';
 $('frame-count').textContent=`${s.completed} / ${s.config.count} frames`;$('progress').value=s.completed;
 $('elapsed').textContent=s.started?(((s.finished||Date.now())-s.started)/1000).toFixed(1)+'s':'0.0s';
 $('compute').textContent=(s.computeMs/1000).toFixed(1)+'s';$('recovered').textContent=s.recovered;
 $('transfer').textContent=(s.uploadBytes/1024).toFixed(0)+' KB';
 const grid=$('frame-grid');
 if(grid.children.length!==s.config.count)grid.replaceChildren(...Array.from({length:s.config.count},()=>document.createElement('div')));
 for(let i=0;i<s.config.count;i++){const status=s.frames[i]?.state||'queued';const el=grid.children[i];if(el.dataset.state!==status){el.dataset.state=status;el.className='frame '+status;el.title=`Frame ${i+1}: ${status}`;}}
 $('device-count').textContent=s.devices.filter(d=>d.online).length+' ONLINE';
 $('devices').replaceChildren(...s.devices.map(d=>{const row=document.createElement('tr');const jobs=s.frames.filter(f=>f.state==='working'&&f.device===d.id);const values=[d.name+(d.id===session.id?' (you)':'')+(d.id===s.host?' · host':''),d.status+(d.status==='Rendering'&&d.paused?' (pausing)':''),jobs.map(f=>String(f.index+1).padStart(3,'0')).join(', ')||'—',`${d.completed} (${d.contributionPercent.toFixed(1)}%)`,(d.renderTimeMs/1000).toFixed(2)+'s',d.averageFrameMs===null?'—':(d.averageFrameMs/1000).toFixed(2)+'s'];for(const [i,value]of values.entries()){const td=document.createElement('td');td.textContent=value;if(i===1)td.className=d.online?'online':'offline';row.append(td);}return row;}));
 if(s.finished&&isHost&&assembledRun!==s.run&&!assembling) assemble(s.run);
}
async function assemble(run){
 assembling=true;const gen=generation;
 try {say('Collecting frames and assembling GIF…');const data=await api('frames');if(!session||state.run!==run||gen!==generation)return;
 const frames=data.frames.map(decode);const gif=encodeGif(frames,data.config);
 if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=URL.createObjectURL(new Blob([gif],{type:'image/gif'}));$('download').href=downloadUrl;$('download').hidden=false;assembledRun=run;
 playFrames(frames,data.config.fps);$('preview-label').textContent='FINISHED / LOOPING';say(`Animation ready — ${(gif.length/1024/1024).toFixed(1)} MB GIF. Payload metric excludes base64 and protocol overhead.`);
 }catch(e){say('Assembly failed: '+e.message);}finally{assembling=false;}
}
async function contribute(){
 if(!session||paused||busy||!state?.started||state.finished)return;
 busy=true;const gen=generation;
 try {const {job}=await api('claim',{run:state.run});if(gen!==generation)return;if(!job){busy=false;return;}
 activeJob=job;
 worker=new Worker('/worker.js',{type:'module'});
 worker.onmessage=async({data})=>{
  if(gen!==generation)return;worker?.terminate();worker=null;
  try{if(data.error)throw new Error(data.error);showFrame(data.pixels);$('preview-label').textContent=`LOCAL FRAME ${job.index+1} / ${job.count}`;await api('result',{index:job.index,run:job.run,token:job.token,pixels:base64(data.pixels),ms:data.ms});}
  catch(e){if(e.status!==409)say(e.message);}finally{if(gen===generation){activeJob=null;busy=false;contribute();}}
 };
 worker.onerror=e=>{say('Worker failed: '+e.message);resetWorker();paused=true;$('pause').textContent='Resume contribution';};worker.postMessage(job);
 }catch(e){if(gen===generation){busy=false;say(e.message);}}
}
async function enter(action){
 if(joining)return;joining=true;$('create').disabled=$('join').disabled=true;
 try{const s=await api(action,{name:$('name').value.trim(),code:$('code').value.trim().toUpperCase()});session={code:s.code,id:s.id,secret:s.secret};sessionStorage.setItem('borrowed-sky',JSON.stringify(session));$('lobby').hidden=true;$('room').hidden=false;say('');draw(s);$('studio').scrollIntoView({block:'start'});contribute();}
 catch(e){say(e.message);}finally{joining=false;$('create').disabled=$('join').disabled=false;}
}
async function poll(){
 if(!session)return;
 if(polling){pollAgain=true;return;}
 polling=true;const currentSession=session,job=activeJob;
 try{
  const payload={run:state?.run??null,paused};
  if(job)payload.assignment={index:job.index,run:job.run,token:job.token};
  const s=await api('state',payload);
  if(session!==currentSession)return;
  draw(s);
  // Do not terminate a newer job if this heartbeat described a previous one.
  if(job&&activeJob===job&&!s.leaseRenewed)resetWorker();
  $('connection').textContent='Connected';contribute();
 }catch(e){if(session===currentSession){$('connection').textContent='Reconnecting…';say(e.message);}}
 finally{polling=false;if(pollAgain){pollAgain=false;void poll();}}
}
async function tick(){await poll();setTimeout(tick,900);}
$('create').onclick=()=>enter('create');$('join').onclick=()=>enter('join');
$('start').onclick=async()=>{try{const currentSession=session;const s=await api('start');if(session!==currentSession)return;draw(s);say('Render started. Invite more laptops while it runs.');contribute();}catch(e){say(e.message);}};
$('pause').onclick=()=>{paused=!paused;updatePauseButton();say(paused?'Pausing after the current frame. This laptop stays connected.':'Contribution resumed.');void poll();};
$('leave').onclick=async()=>{const old=session;resetWorker();session=null;state=null;sessionStorage.removeItem('borrowed-sky');stopAnimation();paused=false;$('pause').textContent='Pause my contribution';$('room').hidden=true;$('lobby').hidden=false;$('download').hidden=true;if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=null;assembledRun=null;try{await api('leave',old);}catch{}say('You left the room. Unfinished work is available to other devices.');};
$('copy').onclick=async()=>{const link=new URL(location.href);link.searchParams.set('room',session.code);if(['localhost','127.0.0.1'].includes(location.hostname)){say(`Room ${session.code}. On other laptops, open the server’s Wi-Fi address printed in its terminal, then enter this code.`);return;}try{await navigator.clipboard.writeText(link.href);say('Invite link copied.');}catch{say('Share this invite: '+link.href);}};
window.addEventListener('pagehide',()=>{if(session)navigator.sendBeacon('/api/leave',new Blob([JSON.stringify(session)],{type:'application/json'}));});
$('code').value=new URL(location.href).searchParams.get('room')||'';
try{session=JSON.parse(sessionStorage.getItem('borrowed-sky')||'null');if(session){$('lobby').hidden=true;$('room').hidden=false;}}catch{session=null;}
tick();
