import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {encodeInWorker} from '../public/export.js';
import {encodeGif} from '../public/gif.js';

function worker(){
 const w=new Worker(new URL('./fixtures/export-worker-node.mjs',import.meta.url));
 const bridge={postMessage:(data,transfer)=>w.postMessage(data,transfer),terminate:()=>w.terminate()};
 w.on('message',data=>bridge.onmessage?.({data}));w.on('error',error=>bridge.onerror?.(error));return bridge;
}
test('export worker transfers ownership and preserves GIF bytes and frame order',async()=>{
 const config={width:32,height:24,count:3,fps:40,theme:'sunset',background:'soft'};
 const frames=Array.from({length:3},(_,i)=>new Uint8Array(32*24).fill(i));
 const expected=encodeGif(frames,config);
 const pending=encodeInWorker(frames,config,new AbortController().signal,worker);
 assert.ok(frames.every(f=>f.byteLength===0));
 const result=await pending;assert.deepEqual(result.gif,expected);
 assert.deepEqual(result.frames.map(f=>f[0]),[0,1,2]);
});
test('export cancellation, worker errors and synchronous startup errors reject and terminate',async()=>{
 for(const mode of ['abort','error','messageerror','reported','startup']){
  let terminated=false;const c=new AbortController();let w;
  const pending=encodeInWorker([new Uint8Array(4)],{width:2,height:2,fps:20},c.signal,()=>w={terminate(){terminated=true;},postMessage(){if(mode==='startup')throw Error('startup');}});
  if(mode==='abort')c.abort();
  if(mode==='error')w.onerror({message:'worker error'});
  if(mode==='messageerror')w.onmessageerror();
  if(mode==='reported')w.onmessage({data:{error:'encoder error'}});
  await assert.rejects(pending);assert.equal(terminated,true);
 }
 const c=new AbortController();c.abort();
 await assert.rejects(encodeInWorker([],{},c.signal,()=>{throw Error('must not construct');}),/cancelled/);
});
test('maximum interactive export completes off-thread with all indexed frames returned',async()=>{
 const config={width:576,height:384,count:240,fps:40,theme:'night'};
 const frames=Array.from({length:240},(_,i)=>new Uint8Array(576*384).fill(i));
 let ticks=0;const timer=setInterval(()=>ticks++,1);
 try{
  const result=await encodeInWorker(frames,config,new AbortController().signal,worker);
  assert.ok(ticks>0);assert.equal(result.frames.length,240);
  result.frames.forEach((f,i)=>{assert.equal(f.length,576*384);assert.equal(f[0],i);assert.equal(f.at(-1),i);});
  assert.equal(result.gif.at(-1),59);assert.ok(result.gif.length<60*1024*1024);
 }finally{clearInterval(timer);}
});
