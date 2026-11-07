import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCoordinator} from '../server.mjs';
import {renderFrame} from '../public/renderer.js';
import {encodeGif} from '../public/gif.js';

test('distributed workflow, disconnect recovery, stale result rejection, ordered collection',async()=>{
 const server=createCoordinator({disconnectMs:10000,leaseMs:10000});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(action,b={})=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/${action}`,{method:'POST',body:JSON.stringify(b)});return {status:r.status,...await r.json()};};
 try {
  const host=await call('create',{name:'Host'});const h={id:host.id,code:host.code,secret:host.secret};
  const guest=await call('join',{code:host.code,name:'Guest'});const g={id:guest.id,code:host.code,secret:guest.secret};
  assert.equal((await call('start',g)).status,403);
  const started=await call('start',h);assert.equal(started.frames.length,120);
  const a=(await call('claim',h)).job,b=(await call('claim',g)).job;assert.notEqual(a.index,b.index);
  const pixels=Buffer.from(renderFrame(a)).toString('base64');
  // Rendering can exceed the tiny test heartbeat threshold; restore host liveness.
  await call('state',h);
  await call('leave',g);
  const recovered=await call('state',h);assert.ok(recovered.recovered>=1);
  assert.equal((await call('result',{...g,...b,pixels,ms:1})).status,409);
  let count=0;
  while(true){const {job}=await call('claim',h);if(!job)break;assert.equal((await call('result',{...h,...job,pixels,ms:1})).status,200);count++;}
  assert.equal(count,120);const done=await call('state',h);assert.equal(done.completed,120);assert.ok(done.finished>=done.started);
  const collected=await call('frames',h);assert.equal(collected.frames.length,120);assert.equal(collected.frames[0],pixels);
  assert.equal((await call('frames',g)).status,403);
  assert.equal((await call('result',{...h,...a,pixels,ms:1})).status,409);
  const again=await call('start',h);assert.notEqual(again.run,started.run);assert.equal(again.completed,0);
 }finally{await new Promise(r=>server.close(r));}
});

test('heartbeat timeout reclaims an abandoned frame',async()=>{
 const server=createCoordinator({disconnectMs:25});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(action,b={})=>(await fetch(`http://127.0.0.1:${server.address().port}/api/${action}`,{method:'POST',body:JSON.stringify(b)})).json();
 try {const h=await call('create');await call('start',h);const {job}=await call('claim',h);await new Promise(r=>setTimeout(r,40));const s=await call('state',h);assert.equal(s.frames[job.index].state,'queued');assert.equal(s.recovered,1);const next=await call('claim',h);assert.notEqual(next.job.token,job.token);}finally{await new Promise(r=>server.close(r));}
});

test('renderer is deterministic, animation changes, GIF has correct framing',()=>{
 const config={width:32,height:24,count:120,fps:20,index:0};const a=renderFrame(config),b=renderFrame({...config,index:30});assert.deepEqual(a,renderFrame(config));assert.notDeepEqual(a,b);
 const gif=encodeGif([a,b],config);assert.equal(new TextDecoder().decode(gif.slice(0,6)),'GIF89a');assert.equal(gif.at(-1),59);
});
