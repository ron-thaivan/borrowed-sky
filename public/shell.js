import {themes} from './renderer.js';
const $=id=>document.getElementById(id);
const put=(id,value)=>{const text=String(value);if($(id).textContent!==text)$(id).textContent=text;};
export function sessionShell(active){
 for(const id of ['brand-home','footer-home','skip-workspace'])$(id).href=active?'#overview':'#studio';
 $('session-header').hidden=!active;$('landing-nav').hidden=active;
 $('session-recover').hidden=true;
 if(active){put('header-room-code','—');put('header-role','Connecting');shellConnection(null);}
}
export function shellConnection(connected,unavailable=false){
 $('connection').dataset.connected=connected===null?'pending':String(connected);
 put('connection',connected===null?'Connecting…':connected?'Connected':unavailable?'Room unavailable':'Reconnecting…');
 $('session-recover').hidden=!unavailable;
}
export function updateShell(s,session,{paused=false,pending=false,pausePending=false,saving=false,resultReady=false}={}){
 const host=s.host===session.id,active=s.started!==null&&s.finished===null,finished=s.finished!==null;
 const config=s.started===null?(s.selectedConfig||s.config):s.config;
 const me=s.devices.find(d=>d.id===session.id),connected=s.devices.filter(d=>d.online).length;
 const rendering=s.devices.filter(d=>d.status==='Rendering').length;
 $('session-header').hidden=false;$('landing-nav').hidden=true;
 for(const id of ['brand-home','footer-home','skip-workspace'])$(id).href='#overview';
 put('header-room-code',s.code);put('header-role',host?'Host':'Contributor');shellConnection(true);
 put('overview-completed',s.completed);put('overview-remaining',Math.max(0,config.count-s.completed));put('overview-devices',connected);
 put('overview-fps',(s.dashboard?.fps??0).toLocaleString(undefined,{maximumFractionDigits:2}));
 const theme=themes.find(t=>t.id===(config.theme||'sunny'))?.name||config.theme;
 put('active-config',`${finished?'Completed session':active?'Active configuration':'Selected configuration'} · ${theme} · ${config.width} × ${config.height} · ${config.count} frames · ${config.fps} FPS · ${config.density||'medium'} density · ${config.background||'original'} background`);
 const summary=finished?(host?(resultReady?'Your GIF is ready. Open the animation viewer to play or download it.':'All frames are complete. Open export status to follow GIF preparation or retry an export.'):'Rendering complete. The host can preview and download the shared animation.'):
  active?(me?.simulatedFailure?'Your worker is unavailable in a recovery simulation. The host can restore it.':rendering?`Rendering in progress · ${rendering} device${rendering===1?'':'s'} working${paused?' · your contribution is paused':''}.`:'Waiting for an available contributor. Resume a device to continue.'):
  host?'Choose your scene, share the room, and start when your crew is ready.':'You’re connected. The host will choose the scene and start the render.';
 put('session-summary',summary);
 $('overview').dataset.phase=finished?'complete':active?'rendering':'ready';
 $('nav-analytics').hidden=!host;$('host-control-summary').hidden=!host;
 const recoveryVisible=host||!!me?.simulatedFailure||!!s.failureNotice;
 $('host-controls').hidden=!recoveryVisible;$('nav-controls').hidden=!recoveryVisible;
 // Keep preparation and retry reachable, not just successful exports.
 $('nav-result').hidden=!host||!finished;$('view-result').hidden=!host||!finished;
 put('view-result',resultReady?'Open animation viewer →':'Open export status →');
 $('host-start').hidden=!host;$('host-pause').hidden=!host;
 $('host-start').disabled=!host||pending||saving||active;$('host-pause').disabled=!host||pausePending;
 put('host-start',pending?'Starting…':finished?'Start a new render ↗':'Start rendering ↗');
 put('host-pause',pausePending?'Updating…':paused?'Resume my contribution':'Pause my contribution');
}
