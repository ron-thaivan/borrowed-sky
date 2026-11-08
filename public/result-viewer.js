import {createPlayback} from './playback.js';
import {themes} from './renderer.js';

export function createResultViewer({imageFor,startNew,retry}){
 const $=id=>document.getElementById(id),root=$('final-result');
 root.innerHTML=`<div class="result-heading"><div><p class="eyebrow">MADE TOGETHER / READY TO KEEP</p><h3>Your shared sky</h3></div><span id="result-badge">Finishing up</span></div>
 <p id="result-message" role="status" aria-live="polite"></p>
 <div id="result-content" hidden><div class="result-canvas"><canvas id="result-preview" aria-label="Completed animation preview"></canvas></div>
 <div class="result-controls" role="group" aria-label="Animation playback controls"><button id="result-play">Play</button><button id="result-pause">Pause</button><button id="result-restart">Restart</button><label><input type="checkbox" id="result-loop" checked> Loop preview</label><label for="result-speed">Preview speed</label><select id="result-speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></div>
 <div class="result-scrub"><button id="result-prev" aria-label="Previous frame">←</button><label for="result-frame">Frame</label><input id="result-frame" type="range" min="0" step="1"><output id="result-position" for="result-frame"></output><button id="result-next" aria-label="Next frame">→</button></div>
 <p class="result-note">Playback controls affect this preview only. Your GIF keeps the rendered session’s timing and loops continuously.</p>
 <div class="result-download"><div><strong>Your animation is ready.</strong><p id="result-file"></p></div><a id="result-download" class="button" download>Download GIF ↓</a></div>
 <dl id="result-stats" class="result-stats"></dl><details><summary>Full rendering configuration</summary><pre id="result-config"></pre></details></div>
 <button id="result-retry" hidden>Retry GIF assembly</button><div class="result-next"><p>Keep the room and your crew. Choose settings above, or render the same sky again.</p><button id="result-new">Start a new render ↗</button></div>`;
 let player=null,currentFrame=0;
 const reducedMotion=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion: reduce)'):null;
 reducedMotion?.addEventListener('change',()=>{if(reducedMotion.matches)player?.pause();});
 const canvas=$('result-preview'),context=canvas.getContext('2d');
 function clear(){player?.dispose();player=null;root.hidden=true;$('result-content').hidden=true;$('result-retry').hidden=true;$('result-download').removeAttribute('href');context.clearRect(0,0,canvas.width,canvas.height);canvas.width=1;canvas.height=1;}
 $('result-play').onclick=()=>player?.play();$('result-pause').onclick=()=>player?.pause();$('result-restart').onclick=()=>player?.restart();
 $('result-loop').onchange=()=>player?.setLoop($('result-loop').checked);
 $('result-speed').onchange=()=>player?.setSpeed(Number($('result-speed').value));
 $('result-frame').oninput=()=>player?.seek(Number($('result-frame').value));
 $('result-prev').onclick=()=>player?.seek(currentFrame-1);$('result-next').onclick=()=>player?.seek(currentFrame+1);
 $('result-new').onclick=startNew;$('result-retry').onclick=retry;
 document.addEventListener('visibilitychange',()=>player?.setVisible(!document.hidden));
 return {
  clear,
  busy(){clear();root.hidden=false;$('result-badge').textContent='Preparing GIF';$('result-message').textContent='All frames received. Collecting your animation and encoding the GIF…';},
  failed(message){root.hidden=false;$('result-badge').textContent='Export needs attention';$('result-message').textContent=message;$('result-retry').hidden=false;},
  setStarting(value){$('result-new').disabled=value;},
  show({frames,config,snapshot,url,bytes}){
   clear();root.hidden=false;$('result-content').hidden=false;$('result-badge').textContent='Render complete';
   $('result-message').textContent='GIF generated successfully. Play, explore, and download your shared sky.';
   canvas.width=config.width;canvas.height=config.height;canvas.parentElement.style.aspectRatio=`${config.width} / ${config.height}`;
   $('result-frame').max=frames.length-1;$('result-loop').checked=true;$('result-speed').value='1';
   $('result-download').href=url;$('result-download').download='borrowed-sky-'+config.theme+'.gif';
   $('result-file').textContent=`${(bytes/1024/1024).toFixed(2)} MiB · ${frames.length} frames · ${config.fps} FPS · infinite loop`;
   const contributors=snapshot.devices.filter(d=>d.completed>0).length;
   const stats=[['Frames',frames.length],['Resolution',`${config.width} × ${config.height}`],['Cloud theme',themes.find(t=>t.id===config.theme)?.name||config.theme],['Contributing devices',contributors],['Rendering wall time',`${((snapshot.finished-snapshot.started)/1000).toFixed(2)} s`],['Average frame render time',`${(snapshot.computeMs/frames.length).toFixed(2)} ms`]];
   $('result-stats').replaceChildren(...stats.map(([label,value])=>{const card=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=String(value);card.append(dt,dd);return card;}));
   $('result-config').textContent=JSON.stringify(config,null,2);
   player=createPlayback({count:frames.length,fps:config.fps,onFrame:index=>context.putImageData(imageFor(frames[index],config),0,0),onState:s=>{
    currentFrame=s.frame;$('result-frame').value=s.frame;$('result-position').textContent=`${s.frame+1} / ${frames.length}`;
    $('result-play').disabled=s.playing;$('result-pause').disabled=!s.playing;$('result-prev').disabled=s.frame===0;$('result-next').disabled=s.frame===frames.length-1;
   }});player.setVisible(!document.hidden);if(!reducedMotion?.matches)player.play();
  }
 };
}
