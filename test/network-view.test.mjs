import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createNetworkTracker,networkStats,networkLayout} from '../public/network-state.js';

async function view(){
 const elements=new Map(),callbacks=new Map();let frameId=0,clock=0,observer;
 class Element {
  constructor(){this.children=[];this.dataset={};this.style={};this.attributes={};this.textContent='';this.classList={toggle(){}};this.animations=0;}
  setAttribute(k,v){this.attributes[k]=String(v);}
  set textContent(value){this.text=String(value);}
  get textContent(){return this.text;}
  append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
  prepend(child){child.parent=this;this.children.unshift(child);}
  replaceChildren(...children){this.children=[];this.append(...children);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
  get lastElementChild(){return this.children.at(-1);}
  animate(){this.animations++;}
 }
 const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const media={matches:false,addEventListener(type,callback){this.change=callback;}};
 const document={hidden:false,getElementById:get,createElement:()=>new Element(),createElementNS:()=>new Element(),addEventListener(type,callback){this[type]=callback;}};
 const context=vm.createContext({document,createNetworkTracker,networkStats,networkLayout,
  matchMedia:()=>media,performance:{now:()=>clock},
  requestAnimationFrame:callback=>{callbacks.set(++frameId,callback);return frameId;},cancelAnimationFrame:id=>callbacks.delete(id),
  IntersectionObserver:class {constructor(callback){observer=callback;}observe(){}}});
 const code=await readFile(new URL('../public/network.js',import.meta.url),'utf8');
 vm.runInContext(code.replace(/^import .*;\r?$/gm,'').replace(/export function /g,'function '),context);
 return {get,media,document,callbacks,
  draw(s){context.snapshot=s;vm.runInContext("drawNetwork(snapshot,'host')",context);},
  run:code=>vm.runInContext(code,context),
  visible(value){observer([{isIntersecting:value}]);},
  paint(time){clock=time;const frames=[...callbacks.values()];callbacks.clear();for(const callback of frames)callback(time);}};
}
const device={id:'host',name:'<script>unsafe name</script>',online:true,status:'Idle',completed:0,renderTimeMs:0,assignedFrames:[]};
function snapshot(revision,events=[],overrides={}){return {code:'ROOM',revision,run:'run',config:{count:120},devices:[device],completed:0,recovered:0,network:{sequence:events.at(-1)?.sequence??0,firstSequence:1,events},...overrides};}

test('network view renders real states, finite directional signals, selection and escaped names',async()=>{
 const v=await view();v.draw(snapshot(1));
 assert.equal(v.callbacks.size,0);assert.equal(v.get('net-idle').textContent,'1');
 const node=v.get('network-nodes').children[1];node.onclick();
 assert.match(v.get('network-inspector').textContent,/<script>unsafe name<\/script>/); // Text, never HTML.
 const events=[{sequence:1,type:'assigned',device:'host',index:3,run:'run'},{sequence:2,type:'completed',device:'host',index:3,run:'run'}];
 v.draw(snapshot(2,events,{completed:1}));
 assert.equal(v.get('network-signals').children.length,2);assert.equal(v.get('net-completed').textContent,'1');
 v.paint(400);
 const [outbound,inbound]=v.get('network-signals').children.map(el=>el.attributes.transform);
 assert.notEqual(outbound,inbound);
 v.draw(snapshot(3,events,{completed:1}));assert.equal(v.get('network-signals').children.length,2);
 v.paint(2000);assert.equal(v.get('network-signals').children.length,0);assert.equal(v.callbacks.size,0);
 v.draw(snapshot(4,events,{devices:[{...device,online:false,status:'Disconnected'}]}));
 assert.equal(node.dataset.status,'disconnected');assert.equal(v.get('net-connected').textContent,'0');
 assert.equal(v.callbacks.size,0);
});
test('network view suppresses offscreen/reduced-motion traffic and clears stale or departed-room effects',async()=>{
 const v=await view();v.draw(snapshot(1));
 const event=sequence=>({sequence,type:'assigned',device:'host',index:sequence,run:'run'});
 v.media.matches=true;v.draw(snapshot(2,[event(1)]));assert.equal(v.callbacks.size,0);
 v.media.matches=false;v.visible(false);v.draw(snapshot(3,[event(1),event(2)]));assert.equal(v.callbacks.size,0);
 v.visible(true);v.draw(snapshot(4,[event(1),event(2),event(3)]));assert.equal(v.get('network-signals').children.length,1);
 v.run('networkConnection(false)');assert.equal(v.callbacks.size,0);assert.match(v.get('network-live').textContent,/last known state/);
 v.run('resetNetwork()');assert.equal(v.get('network-nodes').children.length,0);
 v.draw(snapshot(5,[event(1),event(2),event(3)]));assert.equal(v.callbacks.size,0);
});
