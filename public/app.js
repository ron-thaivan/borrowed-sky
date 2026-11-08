import './motion.js';
import {themes,getPalette,backgroundPresets} from './renderer.js';
import {drawDashboard,dashboardConnection} from './dashboard.js';
import {encodeGif} from './gif.js';
import {updateBenchmarks,benchmarkRequest} from './benchmarks.js';
import {resetNetwork} from './network.js';
import {updateFailureDemo,resetFailureDemo} from './failure-demo.js';
import {RESOLUTIONS,FRAME_COUNTS,SPEEDS,workloadSummary} from './config.js';
const $=id=>document.getElementById(id);
let session=null,state=null,worker=null,busy=false,paused=false,joining=false,generation=0,downloadUrl=null,assembledRun=null,assembling=false,animation=null;
let activeJob=null,polling=false,pollAgain=false;
const ctx=$('preview').getContext('2d');
let savingTheme=false,thumbnailsStarted=false;
let pausePending=false;
const thumbnailImages=new Map();
let previewWorker=null,previewKey=null,previewCanvas=null,previewDimensions=null;
function options(id,values){
 $(id).replaceChildren(...values.map(([value,label])=>{const option=document.createElement('option');option.value=String(value);option.textContent=label;return option;}));
}
options('workload-resolution',RESOLUTIONS.map(([w,h])=>[`${w}x${h}`,`${w} × ${h}${w===192?' (Default)':''}`]));
options('workload-count',FRAME_COUNTS.map(n=>[n,`${n} frames${n===120?' (Default)':''}`]));
options('workload-density',[['low','Low'],['medium','Medium (Default)'],['high','High']]);
options('workload-speed',SPEEDS.map(s=>[s.fps,`${s.name} · ${s.fps} FPS`]));
$('workload-resolution').onchange=()=>{const [width,height]=$('workload-resolution').value.split('x').map(Number);void saveConfiguration({width,height});};
$('workload-count').onchange=()=>saveConfiguration({count:Number($('workload-count').value)});
$('workload-density').onchange=()=>saveConfiguration({density:$('workload-density').value});
$('workload-speed').onchange=()=>saveConfiguration({fps:Number($('workload-speed').value)});
$('workload-background').onchange=()=>saveConfiguration({background:$('workload-background').value});
async function saveConfiguration(patch){
 if(!session||savingTheme)return;
 savingTheme=true;$('theme-options').disabled=true;$('start').disabled=true;
 const currentSession=session;
 try{const s=await api('configure',patch);if(session!==currentSession)return;draw(s);say('Settings saved for the next render.');}
 catch(e){if(session===currentSession)say(e.message);}
 finally{savingTheme=false;if(session===currentSession&&state)draw(state);}
}
function drawWorkload(s){
 const config=s.selectedConfig||s.config,theme=config.theme||'sunny';
 if($('workload-background').dataset.theme!==theme){
  options('workload-background',backgroundPresets[theme].map(p=>[p.id,p.name]));
  $('workload-background').dataset.theme=theme;
 }
 // Operator-supplied configurations remain readable without silently changing them.
 for(const [id,value] of [['workload-resolution',`${config.width}x${config.height}`],['workload-count',config.count],['workload-speed',config.fps]]){
  const select=$(id);if(!Array.from(select.children).some(o=>o.value===String(value))){const option=document.createElement('option');option.value=String(value);option.textContent=String(value)+' (server configuration)';select.append(option);}select.value=String(value);
 }
 $('workload-density').value=config.density||'medium';$('workload-background').value=config.background||'original';
 $('workload-summary').textContent=(s.finished?'Next render: ':'')+workloadSummary(config);
 const factor=config.width*config.height*config.count/(192*128*120);
 $('workload-warning').textContent=factor>4?'Large workload: rendering, transfers, and GIF export take more time and memory. Keep contributor tabs open; use fewer frames for a quick demo.':'All devices receive identical settings. Speed changes playback timing, not the amount of rendering work.';
}
function showSelectedThumbnail(){
 if(!state||state.started!==null){previewWorker?.terminate();previewWorker=null;previewKey=null;previewCanvas=null;return;}
 const config=state.selectedConfig||state.config;
 const key=JSON.stringify([state.code,config.theme,config.density,config.background]);
 const paint=()=>{if(previewCanvas){ctx.imageSmoothingEnabled=false;ctx.drawImage(previewCanvas,0,0,$('preview').width,$('preview').height);$('preview-label').textContent='SETTINGS PREVIEW / FRAME 1';}};
 if(key===previewKey){paint();return;}
 previewWorker?.terminate();previewCanvas=null;previewKey=key;
 const w=new Worker('/worker.js',{type:'module'});previewWorker=w;
 w.onmessage=({data})=>{
  w.terminate();if(previewKey!==key||previewWorker!==w)return;previewWorker=null;
  if(data.error)return;
  const canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;
  const c=canvas.getContext('2d');c.putImageData(makeImage(c,data.pixels,{...config,width:96,height:64}),0,0);previewCanvas=canvas;paint();
 };
 w.onerror=()=>{w.terminate();if(previewWorker===w)previewWorker=null;};
 w.postMessage({...config,width:96,height:64,index:0});
}
for(const theme of themes){
 const label=document.createElement('label');label.className='theme-card';
 const input=document.createElement('input');input.type='radio';input.name='theme';input.value=theme.id;input.checked=theme.id==='sunny';
 const canvas=document.createElement('canvas');canvas.width=64;canvas.height=40;canvas.setAttribute('aria-hidden','true');canvas.dataset.theme=theme.id;
 const title=document.createElement('strong');title.textContent=theme.name;
 const description=document.createElement('span');description.textContent=theme.description;
 label.append(input,canvas,title,description);$('theme-grid').append(label);
 input.onchange=()=>saveConfiguration({theme:theme.id});
}
function thumbnails(){
 if(thumbnailsStarted)return;thumbnailsStarted=true;
 // Generate small genuine procedural previews off the UI thread.
 const w=new Worker('/worker.js',{type:'module'});let i=0;
 const send=()=>w.postMessage({width:64,height:40,index:0,count:120,theme:themes[i].id});
 w.onmessage=({data})=>{
  if(data.error){w.terminate();return;}
  const canvas=document.querySelector('canvas[data-theme="'+themes[i].id+'"]'),c=canvas.getContext('2d');
  c.putImageData(makeImage(c,data.pixels,{width:64,height:40,theme:themes[i].id}),0,0);
  thumbnailImages.set(themes[i].id,canvas);showSelectedThumbnail();
  if(++i<themes.length)send();else w.terminate();
 };
 w.onerror=()=>w.terminate();send();
}
function makeImage(context,pixels,config){
 const image=context.createImageData(config.width,config.height),palette=getPalette(config.theme,config.background);
 for(let i=0,j=0;i<pixels.length;i++,j+=4){const c=palette[pixels[i]];image.data[j]=c[0];image.data[j+1]=c[1];image.data[j+2]=c[2];image.data[j+3]=255;}
 return image;
}

const say=text=>$('message').textContent=text;
async function api(action,body={}) {
 const res=await fetch('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...session,...body}),signal:AbortSignal.timeout(10000)});
 const data=await res.json();if(!res.ok)throw Object.assign(new Error(data.error),{status:res.status});return data;
}
let frameImages=new Map(),cachedImageBytes=0;
const IMAGE_CACHE_BYTES=24*1024*1024;
function configurePreview(config){
 const canvas=$('preview');
 const signature=JSON.stringify([config.width,config.height,config.theme,config.background]);
 if(previewDimensions!==signature){canvas.width=config.width;canvas.height=config.height;frameImages=new Map();cachedImageBytes=0;previewDimensions=signature;}
 canvas.parentElement.style.aspectRatio=`${config.width} / ${config.height}`;
 $('resolution').textContent=`${config.width} × ${config.height} / ${config.fps} FPS`;
 $('duration').textContent=`${(config.count/config.fps).toFixed(1)} seconds. One shared sky.`;
 $('progress').max=config.count;
}
function imageFor(pixels,config=state.config){
 let image=frameImages.get(pixels);if(image)return image;
 if(pixels.length!==$('preview').width*$('preview').height)throw new Error('Unexpected preview frame dimensions');
 image=makeImage(ctx,pixels,config);
 while(cachedImageBytes+image.data.byteLength>IMAGE_CACHE_BYTES&&frameImages.size){const key=frameImages.keys().next().value;cachedImageBytes-=frameImages.get(key).data.byteLength;frameImages.delete(key);}
 if(image.data.byteLength<=IMAGE_CACHE_BYTES){frameImages.set(pixels,image);cachedImageBytes+=image.data.byteLength;}return image;
}
function showFrame(pixels,config=state.config){ctx.putImageData(imageFor(pixels,config),0,0);}
function stopAnimation(){cancelAnimationFrame(animation);animation=null;}
function playFrames(frames,config){
 const {fps}=config;
 stopAnimation();let start=null,last=-1;
 const paint=time=>{if(start===null)start=time;const index=Math.floor((time-start)*fps/1000)%frames.length;if(index!==last){showFrame(frames[index],config);last=index;}animation=requestAnimationFrame(paint);};
 animation=requestAnimationFrame(paint);
}
function base64(pixels){let s='';for(let i=0;i<pixels.length;i++)s+=String.fromCharCode(pixels[i]);return btoa(s);}
function decode(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
function resetWorker(){generation++;worker?.terminate();worker=null;busy=false;activeJob=null;previewWorker?.terminate();previewWorker=null;previewKey=null;previewCanvas=null;}
function updatePauseButton(){$('pause').textContent=paused?'Resume contribution':'Pause my contribution';}
function draw(s){
 if(state?.code===s.code&&s.revision<state.revision)return;
 if(state?.run!==s.run){
  resetWorker();stopAnimation();paused=false;updatePauseButton();
  frameImages.clear();cachedImageBytes=0;
  $('download').hidden=true;assembledRun=null;
  if(downloadUrl){URL.revokeObjectURL(downloadUrl);downloadUrl=null;}
 }
 configurePreview(s.started===null?(s.selectedConfig||s.config):s.config);
 if(state?.run!==s.run){ctx.clearRect(0,0,s.config.width,s.config.height);$('preview-label').textContent='WAITING FOR FIRST FRAME';}
 state=s;const isHost=session.id===s.host;
 const me=s.devices.find(d=>d.id===session.id);if(!pausePending&&me)paused=!!me.paused;
 $('pause').disabled=pausePending;
 $('pause').textContent=paused?'Resume contribution':'Pause my contribution';
 if(me?.simulatedFailure&&(busy||activeJob))resetWorker();
 updateFailureDemo(s,session,api,draw);
 drawDashboard(s,session.id);
 drawWorkload(s);
 updateBenchmarks(s,session,api);
 thumbnails();
 $('theme-options').disabled=savingTheme||!isHost||!!s.started&&!s.finished;
 for(const input of document.querySelectorAll('input[name="theme"]'))input.checked=input.value===(s.selectedTheme||'sunny');
 $('theme-status').textContent=savingTheme?'SAVING':s.started&&!s.finished?'LOCKED DURING RENDER':isHost?'YOUR CHOICE':'HOST SELECTS';
 $('render-title').textContent=themes.find(t=>t.id===((s.started?s.config.theme:s.selectedTheme)||'sunny')).name+' loop';
 showSelectedThumbnail();

 $('room-code').textContent=s.code;$('start').hidden=!isHost;$('start').disabled=savingTheme||s.started!==null&&s.finished===null;
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
 if(s.finished&&isHost&&assembledRun!==s.run&&!assembling) assemble(s.run);
}
async function assemble(run){
 assembling=true;const gen=generation;
 try {say('Collecting frames and assembling GIF…');const data=await api('frames');if(!session||state.run!==run||gen!==generation)return;
 const frames=data.frames.map(decode);const gif=encodeGif(frames,data.config);
 if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=URL.createObjectURL(new Blob([gif],{type:'image/gif'}));$('download').href=downloadUrl;$('download').download='borrowed-sky-'+data.config.theme+'.gif';$('download').hidden=false;assembledRun=run;
 playFrames(frames,data.config);$('preview-label').textContent='FINISHED / LOOPING';say(`Animation ready — ${(gif.length/1024/1024).toFixed(1)} MB GIF. Payload metric excludes base64 and protocol overhead.`);
 }catch(e){say('Assembly failed: '+e.message);}finally{assembling=false;}
}
async function contribute(){
 if(!session||paused||busy||!state?.started||state.finished||state.devices.some(d=>d.id===session.id&&d.simulatedFailure))return;
 busy=true;const gen=generation;
 try {const {job}=await api('claim',{run:state.run});if(gen!==generation)return;if(!job){busy=false;return;}
 activeJob=job;
 worker=new Worker('/worker.js',{type:'module'});
 worker.onmessage=async({data})=>{
  if(gen!==generation)return;worker?.terminate();worker=null;
  try{if(data.error)throw new Error(data.error);showFrame(data.pixels,job);$('preview-label').textContent=`LOCAL FRAME ${job.index+1} / ${job.count}`;await api('result',{index:job.index,run:job.run,token:job.token,pixels:base64(data.pixels),ms:data.ms});}
  catch(e){if(e.status!==409)say(e.message);}finally{if(gen===generation){activeJob=null;busy=false;contribute();}}
 };
 worker.onerror=e=>{if(gen!==generation)return;resetWorker();void setPaused(true).then(()=>say('Worker failed: '+e.message));};worker.postMessage(job);
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
  const payload={run:state?.run??null};
  if(job)payload.assignment={index:job.index,run:job.run,token:job.token};
  const s=await api('state',payload);
  if(session!==currentSession)return;
  draw(s);
  // Do not terminate a newer job if this heartbeat described a previous one.
  if(job&&activeJob===job&&!s.leaseRenewed)resetWorker();
  $('connection').textContent='Connected';contribute();
 }catch(e){if(session===currentSession){$('connection').textContent='Reconnecting…';dashboardConnection(false);say(e.message);}}
 finally{polling=false;if(pollAgain){pollAgain=false;void poll();}}
}
async function tick(){await poll();setTimeout(tick,900);}
$('create').onclick=()=>enter('create');$('join').onclick=()=>enter('join');
$('start').onclick=async()=>{try{const currentSession=session;const s=await api('start',benchmarkRequest());if(session!==currentSession)return;draw(s);say('Render started. Invite more laptops while it runs.');contribute();}catch(e){say(e.message);}};
async function setPaused(value){
 if(!session||pausePending)return;
 const id=session.id,run=state?.run??null,previous=paused;pausePending=true;paused=value;$('pause').disabled=true;
 try{
  const s=await api('pause',{paused:value,run});if(session?.id!==id)return;
  pausePending=false;draw(s);
  say(value?'Pausing after the current frame. This laptop stays connected.':'Contribution resumed.');
 }catch(e){if(session?.id===id){if(state?.run===run)paused=previous;say('Could not update pause state: '+e.message);}}
 finally{pausePending=false;$('pause').disabled=false;if(session?.id===id)contribute();}
}
$('pause').onclick=()=>setPaused(!paused);
$('leave').onclick=async()=>{const old=session;resetWorker();resetNetwork();resetFailureDemo();session=null;state=null;sessionStorage.removeItem('borrowed-sky');stopAnimation();paused=false;$('pause').textContent='Pause my contribution';$('room').hidden=true;$('lobby').hidden=false;$('download').hidden=true;if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=null;assembledRun=null;try{await api('leave',old);}catch{}say('You left the room. Unfinished work is available to other devices.');};
$('copy').onclick=async()=>{const link=new URL(location.href);link.searchParams.set('room',session.code);if(['localhost','127.0.0.1'].includes(location.hostname)){say(`Room ${session.code}. On other laptops, open the server’s Wi-Fi address printed in its terminal, then enter this code.`);return;}try{await navigator.clipboard.writeText(link.href);say('Invite link copied.');}catch{say('Share this invite: '+link.href);}};
window.addEventListener('pagehide',()=>{if(session)navigator.sendBeacon('/api/leave',new Blob([JSON.stringify(session)],{type:'application/json'}));});
$('code').value=new URL(location.href).searchParams.get('room')||'';
try{session=JSON.parse(sessionStorage.getItem('borrowed-sky')||'null');if(session){$('lobby').hidden=true;$('room').hidden=false;}}catch{session=null;}
tick();

