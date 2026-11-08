import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
test('section navigation tracks fresh positions, hidden sections and sticky mobile header',()=>{
 const callbacks={},frames=[];
 const sections=['overview','contributors','analytics'].map((id,i)=>({id,top:i*800,visible:true,getClientRects(){return this.visible?[{}]:[];},getBoundingClientRect(){return {top:this.top};}}));
 const links=sections.map(s=>({hash:'#'+s.id,hidden:false,setAttribute(k,v){this[k]=v;},removeAttribute(k){delete this[k];},addEventListener(){}}));
 const context=vm.createContext({document:{querySelectorAll:()=>links,querySelector:selector=>selector==='.app-header'?{getBoundingClientRect:()=>({bottom:82})}:selector==='.workspace-rail'?{getBoundingClientRect:()=>({bottom:175})}:sections.find(s=>'#'+s.id===selector)},window:{innerWidth:1200,addEventListener:(name,fn)=>{callbacks[name]=fn;}},requestAnimationFrame:fn=>frames.push(fn)});
 vm.runInContext(readFileSync(new URL('../public/motion.js',import.meta.url),'utf8'),context);
 frames.shift()();assert.equal(links[0]['aria-current'],'location');
 sections[0].top=-900;sections[1].top=-100;sections[2].top=700;
 callbacks.scroll();callbacks.scroll();assert.equal(frames.length,1);frames.shift()();assert.equal(links[1]['aria-current'],'location');
 context.window.innerWidth=390;sections[2].top=190;callbacks.resize();frames.shift()();assert.equal(links[2]['aria-current'],'location');
 links[2].hidden=true;callbacks.scroll();frames.shift()();assert.equal(links[1]['aria-current'],'location');assert.equal(links[2]['aria-current'],undefined);
});
