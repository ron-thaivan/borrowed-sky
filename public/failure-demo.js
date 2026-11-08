const root=document.getElementById('failure-demo');
root.innerHTML=`<div id="failure-host" hidden><div class="failure-heading"><div><p class="eyebrow">FAULT TOLERANCE / LIVE DEMO</p><h3>Keep the sky moving.</h3><p>Make one contributor unavailable and watch its real work return to the queue.</p></div><button id="failure-open" class="secondary" aria-expanded="false" aria-controls="failure-picker">Simulate Worker Failure</button></div>
<div id="failure-picker" hidden><label for="failure-target">Connected contributor</label><select id="failure-target"></select><button id="failure-trigger">Fail selected worker</button><button id="failure-cancel" class="secondary">Cancel</button><p>The host is protected. Idle or paused devices may have no unfinished frame to recover.</p></div><div id="failure-resets"></div><p id="failure-help"></p></div>
<p id="failure-self" hidden role="status">Your worker is unavailable for a host-triggered simulation. Its lease was revoked; polling continues. The host can reset the simulation, or start a new render, to restore contribution.</p>
<p id="failure-notice" role="status" aria-live="polite"></p>`;
const $=id=>document.getElementById(id);
let state=null,session=null,request=null,apply=null,pending=false,identity=null,resetSignature=null;
function put(id,text){if($(id).textContent!==text)$(id).textContent=text;}
function candidates(){return state.devices.filter(d=>d.id!==state.host&&d.online&&!d.simulatedFailure);}
function controls(){
 const host=state?.host===session?.id;
 $('failure-host').hidden=!host;
 $('failure-self').hidden=!state?.devices.find(d=>d.id===session?.id)?.simulatedFailure;
 if(!host)return;
 const active=state.started!==null&&state.finished===null;
 const devices=candidates(),selected=$('failure-target').value;
 const signature=JSON.stringify(devices.map(d=>[d.id,d.name,d.status,d.assignedFrames]));
 if($('failure-target').dataset.signature!==signature){
  const option=(value,text)=>{const el=document.createElement('option');el.value=value;el.textContent=text;return el;};
  $('failure-target').replaceChildren(option('','Choose a contributor'),...devices.map(d=>option(d.id,`${d.name} · ${d.status}${d.assignedFrames?.length?' · frame '+d.assignedFrames.map(i=>i+1).join(', '):' · no active frame'}`)));
  $('failure-target').value=devices.some(d=>d.id===selected)?selected:'';
  $('failure-target').dataset.signature=signature;
 }
 $('failure-open').disabled=pending||!active||!devices.length;
 $('failure-target').disabled=pending||!active;
 $('failure-trigger').disabled=pending||!active||!devices.some(d=>d.id===$('failure-target').value);
 $('failure-cancel').disabled=pending;
 put('failure-help',!active?'Start a render to demonstrate recovery. Reset controls remain available after completion.':!devices.length?(state.devices.some(d=>d.simulatedFailure)?'Reset a simulated worker below to repeat the demonstration. The host remains available.':'Connect another laptop to simulate a failure. The host cannot be selected.'):'For a visible recovery, select a Rendering contributor. Reset a failed worker below to repeat the demo. A new run clears all simulations.');
 const failed=state.devices.filter(d=>d.simulatedFailure),key=JSON.stringify([pending,failed.map(d=>[d.id,d.name])]);
 if(resetSignature!==key){
  resetSignature=key;
  $('failure-resets').replaceChildren(...failed.map(d=>{const button=document.createElement('button');button.className='secondary';button.textContent='Reset simulation: '+d.name;button.disabled=pending;button.onclick=()=>act('restore-worker',d.id);return button;}));
 }
}
export function resetFailureDemo(){state=null;session=null;identity=null;pending=false;resetSignature=null;request=null;apply=null;$('failure-picker').hidden=true;$('failure-open').setAttribute('aria-expanded','false');put('failure-notice','');}
export function updateFailureDemo(s,credentials,api,draw){
 const next=credentials.code+credentials.id;
 if(identity!==next){resetFailureDemo();identity=next;}
 if(state&&state.run!==s.run){$('failure-picker').hidden=true;$('failure-open').setAttribute('aria-expanded','false');put('failure-notice','');}
 state=s;session=credentials;request=api;apply=draw;controls();
 if(s.failureNotice){
  const notice=s.failureNotice,target=s.devices.find(d=>d.id===notice.targetId),frames=notice.recoveredFrames;
  const text=frames.length?`${frames.length} unfinished frame${frames.length===1?'':'s'} (${frames.map(i=>i+1).join(', ')}) recovered and returned to the queue. Other available devices can claim this work.`:'No unfinished frame was held when the simulation took effect; no recovery was counted.';
  put('failure-notice',`${target?.simulatedFailure?'Simulated failure':'Simulation ended'}: ${notice.name}. ${text}`);
 }
}
async function act(action,targetId){
 if(pending||!state||!session)return;
 const owner=identity,run=state.run,api=request,draw=apply;
 pending=true;controls();
 try{
  const s=await api(action,{targetId,run});
  if(identity!==owner||state?.run!==run)return;
  draw(s);
  if(action==='restore-worker')put('failure-notice','Simulation reset. This worker can contribute again when connected and unpaused. Revoked leases remain invalid.');
 }catch(e){if(identity===owner&&state?.run===run)put('failure-notice',e.message);}
 finally{if(identity===owner){pending=false;controls();}}
}
$('failure-open').onclick=()=>{$('failure-picker').hidden=false;$('failure-open').setAttribute('aria-expanded','true');controls();$('failure-target').focus();};
$('failure-cancel').onclick=()=>{$('failure-picker').hidden=true;$('failure-open').setAttribute('aria-expanded','false');$('failure-open').focus();};
$('failure-target').onchange=controls;
$('failure-trigger').onclick=()=>act('simulate-failure',$('failure-target').value);
