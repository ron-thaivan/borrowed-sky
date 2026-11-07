import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {palette,themes,getPalette} from '../public/renderer.js';

// Exercise the actual browser controller with a minimal DOM; no browser dependency.
async function browser() {
 const elements=new Map();
 const context2d={createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),putImageData:()=>{},clearRect(){},drawImage(){}};
 const element=()=>({children:[],dataset:{},style:{},parentElement:{style:{}},value:'',width:192,height:128,
  getContext:()=>context2d,setAttribute(){},replaceChildren(...children){this.children=children;},append(...children){this.children.push(...children);}});
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 const context=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},palette,themes,getPalette,
  drawDashboard(){},dashboardConnection(){},resetNetwork(){},updateBenchmarks(){},benchmarkRequest(){return {};},Worker:class {postMessage(){} terminate(){}},
  URL,Uint8Array,Uint8ClampedArray,AbortSignal,Blob,console,
  location:{href:'http://localhost:3000/',hostname:'localhost'},
  window:{addEventListener(){}},navigator:{},sessionStorage:{getItem:()=>null},
  setTimeout(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},
  fetch:()=>{throw new Error('Unexpected network request');}});
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 vm.runInContext(source.replace(/^import .*;\r?$/gm,''),context);
 vm.runInContext("session={id:'guest'}",context);
 const draw=state=>{context.snapshot=state;vm.runInContext('draw(snapshot)',context);};
 return {context,get,draw,run:code=>vm.runInContext(code,context)};
}
const snapshot=(config,overrides={})=>({code:'ROOM',host:'host',run:'first',revision:1,config,devices:[],frames:[],completed:0,computeMs:0,uploadBytes:0,recovered:0,started:null,finished:null,...overrides});

test('browser preview dimensions, image data, progress, and labels use the active configuration',async()=>{
 const {get,draw,run}=await browser();
 draw(snapshot({width:320,height:240,count:42,fps:25}));
 assert.equal(get('preview').width,320);assert.equal(get('preview').height,240);
 assert.equal(get('preview').parentElement.style.aspectRatio,'320 / 240');
 assert.equal(get('progress').max,42);assert.equal(get('frame-grid').children.length,42);
 assert.equal(get('resolution').textContent,'320 × 240 / 25 FPS');
 const image=run('imageFor(new Uint8Array(320*240))');
 assert.equal(image.width,320);assert.equal(image.height,240);assert.equal(image.data.length,320*240*4);
 assert.throws(()=>run('imageFor(new Uint8Array(192*128))'));
 draw(snapshot({width:192,height:128,count:120,fps:20},{run:'second',revision:2}));
 assert.equal(get('preview').width,192);assert.equal(get('progress').max,120);
 assert.equal(get('resolution').textContent,'192 × 128 / 20 FPS');
 assert.equal(run('imageFor(new Uint8Array(192*128)).height'),128);
});

test('new run clears local pause and stale snapshots cannot restore an old run',async()=>{
 const {draw,run,get}=await browser();
 const config={width:8,height:8,count:2,fps:20};
 draw(snapshot(config));
 run('paused=true;updatePauseButton()');
 draw(snapshot(config,{revision:2}));
 assert.equal(run('paused'),true); // Ordinary polling preserves local pause intent.
 draw(snapshot(config,{run:'second',revision:3}));
 assert.equal(run('paused'),false);assert.equal(get('pause').textContent,'Pause my contribution');
 draw(snapshot(config,{revision:2}));
 assert.equal(run('state.run'),'second');
});

test('themed preview keeps configured dimensions and changes palette on a new run',async()=>{
 const {draw,run}=await browser();
 const config={width:320,height:240,count:12,fps:12,theme:'sunset'};
 draw(snapshot(config));
 let image=run('imageFor(new Uint8Array(320*240).fill(150))');
 assert.deepEqual([...image.data.slice(0,3)],getPalette('sunset')[150]);
 draw(snapshot({...config,theme:'night'},{run:'second',revision:2}));
 image=run('imageFor(new Uint8Array(320*240).fill(150))');
 assert.deepEqual([...image.data.slice(0,3)],getPalette('night')[150]);
});

test('heartbeat retains active lease proof without overwriting server-backed pause state',async()=>{
 const {draw,run,context}=await browser();
 const config={width:8,height:8,count:2,fps:20,theme:'sunny'};
 draw(snapshot(config,{started:1000}));
 run("activeJob={index:0,run:'first',token:'lease'};busy=true;paused=true");
 let payload;
 context.fetch=async(url,options)=>{
  payload=JSON.parse(options.body);
  return {ok:true,json:async()=>snapshot(config,{started:1000,revision:2,leaseRenewed:true})};
 };
 await run('poll()');
 assert.deepEqual(payload.assignment,{index:0,run:'first',token:'lease'});
 assert.ok(!Object.hasOwn(payload,'paused'));
 assert.equal(run('activeJob.token'),'lease');
 assert.equal(run('busy'),true);
});

