import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {writeFile,mkdir} from 'node:fs/promises';
import {createCoordinator} from '../server.mjs';
import {encodeGif} from '../public/gif.js';

test('full real render across concurrent workers with one departing client',async()=>{
 const server=createCoordinator();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const workers=[];const call=async(action,b={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/${action}`,{method:'POST',body:JSON.stringify(b)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
 try{
  const host=await call('create',{name:'Render host'});const h={id:host.id,code:host.code,secret:host.secret};
  const clients=[h];for(let i=0;i<2;i++){const d=await call('join',{code:h.code,name:'Worker '+i});clients.push({id:d.id,code:h.code,secret:d.secret});}
  await call('start',h);
  const abandoned=(await call('claim',clients[2])).job;await call('leave',clients[2]);
  await Promise.all(clients.slice(0,2).map(async client=>{
   const worker=new Worker(new URL('./render-worker.mjs',import.meta.url));workers.push(worker);
   for(;;){const {job}=await call('claim',client);if(!job)break;const message=once(worker,'message');worker.postMessage(job);const [result]=await message;await call('result',{...client,...job,pixels:Buffer.from(result.pixels).toString('base64'),ms:result.ms});}
  }));
  const state=await call('state',h);assert.equal(state.completed,120);assert.equal(state.recovered,1);assert.equal(state.frames[abandoned.index].state,'done');assert.ok(state.devices[0].completed>0);assert.ok(state.devices[1].completed>0);
  const data=await call('frames',h);const frames=data.frames.map(s=>Buffer.from(s,'base64'));assert.notDeepEqual(frames[0],frames[60]);
  const gif=encodeGif(frames,data.config);await mkdir(new URL('../output/',import.meta.url),{recursive:true});await writeFile(new URL('../output/borrowed-sky.gif',import.meta.url),gif);
  console.log(`Real render: ${((state.finished-state.started)/1000).toFixed(2)}s wall, ${(state.computeMs/1000).toFixed(2)}s summed workers, ${gif.length} GIF bytes. Same machine; not a speedup benchmark.`);
 }finally{await Promise.all(workers.map(w=>w.terminate()));await new Promise(r=>server.close(r));}
});
