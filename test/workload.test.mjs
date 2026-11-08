import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {createCoordinator} from '../server.mjs';
import {DEFAULT_CONFIG,CONFIG_KEYS,RESOLUTIONS,FRAME_COUNTS,SPEEDS,configureWorkload} from '../public/config.js';
import {renderFrame,getPalette,themes} from '../public/renderer.js';
import {encodeGif} from '../public/gif.js';

test('all 972 preset combinations validate and unsafe or unknown settings are rejected',()=>{
 let count=0;
 for(const [width,height] of RESOLUTIONS)for(const frames of FRAME_COUNTS)for(const {fps} of SPEEDS)
 for(const {id:theme} of themes)for(const density of ['low','medium','high'])for(const background of ['original','soft','deep']){
  const patch={width,height,count:frames,fps,theme,density,background};
  assert.deepEqual(configureWorkload(DEFAULT_CONFIG,patch),patch);count++;
 }
 assert.equal(count,972);
 for(const patch of [{width:999},{width:576,height:128},{count:999},{count:-1},{fps:60},{density:'extreme'},{background:'#fff'},{theme:'unknown'}])assert.throws(()=>configureWorkload(DEFAULT_CONFIG,patch));
 assert.throws(()=>configureWorkload({...DEFAULT_CONFIG,width:2048,height:2048,count:16},{count:60}));
});

test('density and background choices are visibly distinct, deterministic across workers, and preserve defaults',async()=>{
 const workers=[new Worker(new URL('./render-worker.mjs',import.meta.url)),new Worker(new URL('./render-worker.mjs',import.meta.url))];
 const work=(worker,job)=>{const pending=once(worker,'message');worker.postMessage(job);return pending.then(([result])=>result.pixels);};
 try{
  for(const {id:theme} of themes){
   const cloudCounts=[];
   for(const density of ['low','medium','high']){
    const job={width:32,height:24,count:120,index:30,theme,density};
    const result=renderFrame(job);cloudCounts.push(result.filter(v=>v>=128&&v<248).length);
    for(const background of ['original','soft','deep'])for(const {fps} of SPEEDS){
     const actual=await Promise.all(workers.map(w=>work(w,{...job,background,fps})));
     assert.deepEqual(actual[0],result);assert.deepEqual(actual[1],result);
    }
   }
   assert.ok(cloudCounts[0]<cloudCounts[1]&&cloudCounts[1]<cloudCounts[2],theme+' cloud coverage increases');
   const colors=['original','soft','deep'].map(bg=>JSON.stringify(getPalette(theme,bg)));
   assert.equal(new Set(colors).size,3);
   assert.deepEqual(renderFrame({width:32,height:24,count:120,index:0,theme}),renderFrame({width:32,height:24,count:120,index:0,theme,density:'medium',background:'original'}));
  }
  // Real frames at every resolution/count pair, including wrapped indices.
  for(const [width,height] of RESOLUTIONS)for(const count of FRAME_COUNTS){
   const job={...DEFAULT_CONFIG,width,height,count,index:count-1,density:'high',theme:'sunset',background:'soft'};
   const [a,b]=await Promise.all(workers.map((w,i)=>work(w,{...job,index:job.index+i*count})));
   assert.equal(a.length,width*height);assert.deepEqual(a,b);
  }
 }finally{await Promise.all(workers.map(w=>w.terminate()));}
});

// Independent reader for the encoder's literal-only LZW stream. Verify every
// pixel, frame order, data block, and delay, not just the GIF header/trailer.
function checkGif(gif,config){
 const word=i=>gif[i]|gif[i+1]<<8;
 assert.equal(word(6),config.width);assert.equal(word(8),config.height);
 assert.deepEqual(gif.slice(13,781),Uint8Array.from(getPalette(config.theme,config.background).flat()));
 let position=800,frames=0,delay=0;
 while(gif[position]!==59){
  assert.deepEqual([...gif.slice(position,position+4)],[33,249,4,0]);delay+=word(position+4);position+=8;
  assert.equal(gif[position],44);assert.equal(word(position+5),config.width);assert.equal(word(position+7),config.height);position+=10;
  assert.equal(gif[position++],8);
  let bits=0,buffer=0,pixels=0,ended=false;
  for(let length=gif[position++];length;length=gif[position++]){
   for(let i=0;i<length;i++){
    buffer|=gif[position++]<<bits;bits+=8;
    while(bits>=9&&!ended){const code=buffer&511;buffer>>>=9;bits-=9;if(code===257){ended=true;break;}if(code===256)continue;assert.equal(code,frames%256);pixels++;}
   }
  }
  assert.ok(ended);assert.equal(pixels,config.width*config.height);frames++;
 }
 assert.equal(position,gif.length-1);assert.equal(frames,config.count);assert.equal(delay,Math.round(config.count*100/config.fps));
}
test('GIF exports decode correctly for every resolution/count and speed, including maximum workload',()=>{
 for(const [width,height] of RESOLUTIONS)for(const count of FRAME_COUNTS){
  const frames=Array.from({length:count},(_,i)=>new Uint8Array(width*height).fill(i%256));
  const config={width,height,count,fps:40,theme:'night',background:'deep'};
  checkGif(encodeGif(frames,config),config);
 }
 for(const {fps} of SPEEDS){const config={width:2,height:2,count:60,fps,theme:'sunny',background:'original'};checkGif(encodeGif(Array.from({length:60},(_,i)=>new Uint8Array(4).fill(i)),config),config);}
});

test('host configuration is shared, immutable during runs, and collected in exact frame order',async t=>{
 const server=createCoordinator({disconnectMs:120000,leaseMs:120000});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const call=async(action,body={})=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/${action}`,{method:'POST',body:JSON.stringify(body)});return {status:res.status,...await res.json()};};
 const auth=s=>({id:s.id,secret:s.secret,code:s.code}),h=auth(await call('create')),g=auth(await call('join',{code:h.code}));
 const settings={width:576,height:384,count:60,fps:40,theme:'storm',density:'low',background:'soft'};
 assert.equal((await call('configure',{...g,...settings})).status,403);
 const selected=await call('configure',{...h,...settings});assert.deepEqual(selected.selectedConfig,settings);assert.deepEqual(selected.config,DEFAULT_CONFIG);
 assert.deepEqual((await call('state',g)).selectedConfig,settings);
 assert.equal((await call('configure',{...h,density:'wrong'})).status,400);
 const start=await call('start',{...h,width:1,count:1});assert.deepEqual(start.config,settings);assert.equal(start.frames.length,60);
 assert.equal((await call('configure',{...h,count:240})).status,409);
 assert.deepEqual((await call('join',{code:h.code})).config,settings);
 const a=(await call('claim',{...h,width:1,count:1})).job,b=(await call('claim',g)).job;
 for(const job of [a,b])assert.deepEqual(Object.fromEntries(CONFIG_KEYS.map(key=>[key,job[key]])),settings);
 const upload=(device,job)=>call('result',{...device,...job,pixels:Buffer.alloc(settings.width*settings.height,job.index).toString('base64'),ms:10});
 assert.equal((await upload(g,b)).status,200);assert.equal((await upload(h,a)).status,200);
 for(let i=2;i<60;i++)assert.equal((await upload(h,(await call('claim',h)).job)).status,200);
 const collected=await call('frames',h);assert.deepEqual(collected.config,settings);
 assert.equal(collected.frames.length,60);collected.frames.forEach((p,i)=>assert.equal(Buffer.from(p,'base64')[0],i));
 await call('configure',{...h,width:192,height:128,count:240,fps:10,theme:'night',density:'high',background:'deep'});
 assert.deepEqual((await call('frames',h)).config,settings); // Previous download keeps its own palette and timing.
 const again=await call('start',h);assert.equal(again.frames.length,240);assert.equal(again.config.fps,10);
 assert.equal((await upload(h,a)).status,409);
});
