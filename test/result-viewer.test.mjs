import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createPlayback} from '../public/playback.js';
import {themes} from '../public/renderer.js';

test('result viewer uses completed metadata, wires controls, and clears old downloads and playback',async()=>{
 const elements=new Map(),painted=[],callbacks=new Map();let id=0,starts=0,retries=0;
 const element=()=>({children:[],style:{},parentElement:{style:{}},value:'',hidden:false,checked:false,
  getContext:()=>({clearRect(){},putImageData:image=>painted.push(image)}),removeAttribute(key){delete this[key];},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;}});
 const get=key=>{if(!elements.has(key))elements.set(key,element());return elements.get(key);};
 const motion={matches:false,addEventListener(type,handler){this.change=handler;}};
 const context=vm.createContext({document:{hidden:false,getElementById:get,createElement:element,addEventListener(){}},themes,
  matchMedia:()=>motion,
  createPlayback:options=>createPlayback({...options,now:()=>0,request:fn=>{callbacks.set(++id,fn);return id;},cancel:id=>callbacks.delete(id)})});
 const source=await readFile(new URL('../public/result-viewer.js',import.meta.url),'utf8');
 vm.runInContext(source.replace(/^import .*;\r?$/gm,'').replace('export function','function'),context);
 context.options={imageFor:(pixels,config)=>({pixels,config}),startNew:()=>starts++,retry:()=>retries++};
 const viewer=vm.runInContext('createResultViewer(options)',context);
 const config={width:2,height:2,count:3,fps:40,theme:'night',density:'high',background:'deep'};
 const frames=Array.from({length:3},(_,i)=>new Uint8Array(4).fill(i));
 viewer.busy();assert.equal(get('final-result').hidden,false);assert.equal(get('result-content').hidden,true);
 viewer.show({frames,config,snapshot:{started:1000,finished:3000,computeMs:300,devices:[{completed:2},{completed:1},{completed:0}]},url:'blob:completed',bytes:1024});
 assert.equal(get('result-preview').width,2);assert.equal(get('result-frame').max,2);
 assert.equal(get('result-download').href,'blob:completed');assert.match(get('result-file').textContent,/40 FPS/);
 assert.deepEqual(get('result-stats').children.map(card=>card.children[1].textContent),['3','2 × 2','Night Sky','2','2.00 s','100.00 ms']);
 assert.deepEqual(JSON.parse(get('result-config').textContent),config);
 get('result-pause').onclick();assert.equal(callbacks.size,0);
 get('result-frame').value='2';get('result-frame').oninput();assert.equal(painted.at(-1).pixels,frames[2]);
 get('result-prev').onclick();assert.equal(painted.at(-1).pixels,frames[1]);
 get('result-loop').checked=false;get('result-loop').onchange();
 get('result-speed').value='2';get('result-speed').onchange();assert.equal(config.fps,40);
 get('result-restart').onclick();assert.equal(painted.at(-1).pixels,frames[0]);assert.equal(callbacks.size,1);
 get('result-new').onclick();assert.equal(starts,1);
 viewer.clear();assert.equal(callbacks.size,0);assert.equal(get('final-result').hidden,true);assert.equal(get('result-download').href,undefined);
 viewer.failed('Transfer failed');assert.equal(get('result-retry').hidden,false);get('result-retry').onclick();assert.equal(retries,1);
 motion.matches=true;
 viewer.show({frames,config,snapshot:{started:0,finished:1000,computeMs:30,devices:[]},url:'blob:reduced',bytes:1024});
 assert.equal(callbacks.size,0,'Reduced motion prevents autoplay');
 get('result-play').onclick();assert.equal(callbacks.size,1,'Explicit playback remains available');
 motion.change();assert.equal(callbacks.size,0,'Enabling reduced motion stops playback');
 viewer.clear();
});
