// CSS animates decorative clouds and the homepage panel; suspend work when it is not visible or useful.
export function createAmbientMotion(doc,media,Observer,storage=null){
 const root=doc.documentElement,button=doc.getElementById('motion-toggle');
 let choice=null;try{const value=storage?.getItem('borrowed-sky-motion');if(value==='on'||value==='off')choice=value;}catch{}
 let rendering=false,visible=true,manualPause=choice===null?media.matches:choice==='off';
 function sync(){
  root.dataset.motionAllowed=String(!manualPause);
  root.dataset.decorativeMotion=rendering||manualPause||doc.hidden||!visible?'paused':'running';
  if(button){button.textContent=manualPause?(media.matches?'Enable motion':'Resume motion'):'Pause motion';button.setAttribute('aria-pressed',String(manualPause));button.title='Pause or resume floating clouds and the homepage panel. Your choice is saved for this site.';}
 }
 if(button)button.onclick=()=>{manualPause=!manualPause;choice=manualPause?'off':'on';try{storage?.setItem('borrowed-sky-motion',choice);}catch{}sync();};
 media.addEventListener('change',()=>{if(choice===null)manualPause=media.matches;sync();});doc.addEventListener('visibilitychange',sync);
 const hero=doc.querySelector('.intro');
 if(Observer&&hero){const observer=new Observer(entries=>{for(const entry of entries)if(entry.target===hero)visible=entry.isIntersecting;sync();});observer.observe(hero);}
 sync();return {setRendering(value){rendering=!!value;sync();}};
}
let storage=null;try{storage=globalThis.localStorage;}catch{}
const ambient=typeof document!=='undefined'&&typeof matchMedia==='function'?createAmbientMotion(document,matchMedia('(prefers-reduced-motion: reduce)'),globalThis.IntersectionObserver,storage):null;
export function setRenderingMotion(rendering){ambient?.setRendering(rendering);}
