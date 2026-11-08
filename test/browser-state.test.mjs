import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {palette,themes,getPalette,backgroundPresets} from '../public/renderer.js';
import {RESOLUTIONS,FRAME_COUNTS,SPEEDS,workloadSummary} from '../public/config.js';

// Exercise the actual browser controller with a minimal DOM; no browser dependency.
async function browser() {
 const elements=new Map();
 const results={shown:[],cleared:0,errors:[]};
 const context2d={createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),putImageData:()=>{},clearRect(){},drawImage(){}};
 const element=()=>({children:[],dataset:{},style:{},parentElement:{style:{}},value:'',width:192,height:128,
  getContext:()=>context2d,setAttribute(){},replaceChildren(...children){this.children=children;},append(...children){this.children.push(...children);}});
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 const context=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},palette,themes,getPalette,backgroundPresets,RESOLUTIONS,FRAME_COUNTS,SPEEDS,workloadSummary,
  updateFailureDemo(){},resetFailureDemo(){},drawDashboard(){},dashboardConnection(){},resetNetwork(){},updateBenchmarks(){},benchmarkRequest(){return {};},Worker:class {postMessage(){} terminate(){}},
  updateShell(){},sessionShell(){},shellConnection(){},
  createResultViewer:()=>({clear(){results.cleared++;},busy(){},failed(message){results.errors.push(message);},show(value){results.shown.push(value);},setStarting(){}}),
  URL,Uint8Array,Uint8ClampedArray,AbortSignal,Blob,console,
  location:{href:'http://localhost:3000/',hostname:'localhost'},
  window:{addEventListener(){}},navigator:{},sessionStorage:{getItem:()=>null},
  setTimeout(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},
  fetch:()=>{throw new Error('Unexpected network request');}});
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 vm.runInContext(source.replace(/^import .*;\r?$/gm,''),context);
 vm.runInContext("session={id:'guest'}",context);
 const draw=state=>{context.snapshot=state;vm.runInContext('draw(snapshot)',context);};
 return {context,get,draw,results,run:code=>vm.runInContext(code,context)};
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

test('workload panel shows synchronized settings, locks contributors and active runs, and keeps finished palettes',async()=>{
 const {draw,run,get}=await browser();
 const config={width:192,height:128,count:120,fps:20,theme:'sunny',density:'medium',background:'original'};
 const selectedConfig={width:576,height:384,count:240,fps:40,theme:'night',density:'high',background:'deep'};
 draw(snapshot(config,{selectedConfig,selectedTheme:'night'}));
 assert.equal(get('theme-options').disabled,true);
 assert.equal(get('workload-resolution').value,'576x384');assert.equal(get('workload-count').value,'240');
 assert.equal(get('workload-density').value,'high');assert.equal(get('workload-background').value,'deep');assert.equal(get('workload-speed').value,'40');
 assert.match(get('workload-summary').textContent,/18.0×/);assert.match(get('workload-warning').textContent,/Large workload/);
 run("session={id:'host'}");draw(snapshot(config,{revision:2,selectedConfig,selectedTheme:'night'}));
 assert.equal(get('theme-options').disabled,false);
 draw(snapshot(selectedConfig,{revision:3,selectedConfig,selectedTheme:'night',started:1000}));assert.equal(get('theme-options').disabled,true);
 // Avoid triggering host collection; inspect a completed run as a contributor.
 run("session={id:'guest'}");draw(snapshot(selectedConfig,{revision:4,selectedConfig:config,selectedTheme:'sunny',started:1000,finished:2000}));
 const image=run('imageFor(new Uint8Array(576*384).fill(20))');
 assert.deepEqual([...image.data.slice(0,3)],getPalette('night','deep')[20]);
 assert.match(get('workload-summary').textContent,/Next render/);
});

test('large preview playback stays within its decoded-image memory budget',async()=>{
 const {draw,run}=await browser();
 draw(snapshot({width:576,height:384,count:240,fps:40,theme:'sunny',density:'medium',background:'original'}));
 run('for(let i=0;i<40;i++)imageFor(new Uint8Array(576*384).fill(i))');
 assert.ok(run('cachedImageBytes<=24*1024*1024'));
 assert.ok(run('frameImages.size<40'));
});

test('simulated worker stops its active computation and resumes only after server reset',async()=>{
 const {draw,run,context}=await browser();
 const config={width:8,height:8,count:2,fps:20,theme:'sunny'};
 draw(snapshot(config,{started:1000,devices:[{id:'guest',paused:false,simulatedFailure:false}]}));
 run("activeJob={index:0,run:'first',token:'old'};busy=true;worker={terminate(){}};");
 const generation=run('generation');
 draw(snapshot(config,{revision:2,started:1000,devices:[{id:'guest',paused:false,simulatedFailure:true}]}));
 assert.equal(run('activeJob'),null);assert.equal(run('busy'),false);assert.ok(run('generation')>generation);
 await run('contribute()'); // Unexpected requests throw in this harness.
 let claims=0;
 context.fetch=async()=>{claims++;return {ok:true,json:async()=>({job:null})};};
 draw(snapshot(config,{revision:3,started:1000,devices:[{id:'guest',paused:false,simulatedFailure:false}]}));
 await run('contribute()');assert.equal(claims,1);
});

test('late collection cannot show an old animation after a new run or leave',async()=>{
 for(const leave of [false,true]){
  const {draw,run,context,results}=await browser();
  const config={width:2,height:2,count:1,fps:20,theme:'sunny'};
  draw(snapshot(config,{started:1000,finished:2000}));
  run("session={id:'host'}");let respond;
  context.fetch=()=>new Promise(resolve=>{respond=resolve;});
  const pending=run("assemble('first')");
  if(leave)run('resetWorker();session=null;state=null;stopAnimation()');
  else draw(snapshot(config,{run:'second',revision:2,started:3000}));
  respond({ok:true,json:async()=>({run:'first',config,frames:['AAAAAA==']})});
  await pending;assert.equal(results.shown.length,0);assert.equal(run('assembledRun'),null);
  assert.equal(run('assembling'),false);
 }
});

test('collection errors wait for explicit retry and mismatched runs cannot be exported',async()=>{
 const {draw,run,context,results}=await browser();
 const config={width:2,height:2,count:1,fps:20,theme:'sunny'};
 const finished=snapshot(config,{started:1000,finished:2000});draw(finished);run("session={id:'host'}");
 let requests=0;context.fetch=async()=>{requests++;return {ok:true,json:async()=>({run:'wrong',config,frames:['AAAAAA==']})};};
 await run("assemble('first')");assert.equal(results.shown.length,0);assert.equal(results.errors.length,1);
 draw({...finished,revision:2});assert.equal(requests,1);
});

