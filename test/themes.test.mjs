import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {themes,renderFrame,getPalette,palette} from '../public/renderer.js';
import {encodeGif} from '../public/gif.js';
import {createCoordinator} from '../server.mjs';

const config={width:32,height:24,index:0,count:120,fps:20};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
test('all environments reproduce pixels in independent workers, out of order, and loop',async()=>{
 const workers=[new Worker(new URL('./render-worker.mjs',import.meta.url)),new Worker(new URL('./render-worker.mjs',import.meta.url))];
 try {
  for(const {id:theme} of themes){
   for(const index of [83,0,30,82,119]){
    const job={...config,theme,index},expected=renderFrame(job);
    const actual=await Promise.all(workers.map(async w=>{const message=once(w,'message');w.postMessage(job);return (await message)[0].pixels;}));
    for(const pixels of actual)assert.deepEqual(pixels,expected,theme+' frame '+index);
    assert.deepEqual(renderFrame({...job,index:index+config.count}),expected);
   }
   assert.notDeepEqual(renderFrame({...config,theme}),renderFrame({...config,theme,index:30}));
  }
 }finally{await Promise.all(workers.map(w=>w.terminate()));}
});
test('sunny default, distinct RGB environments, valid palettes and rejected unknown themes',()=>{
 assert.deepEqual(renderFrame(config),renderFrame({...config,theme:'sunny'}));
 assert.deepEqual(palette,getPalette('sunny'));
 const hashes=themes.map(({id:theme})=>{
  const colors=getPalette(theme);assert.equal(colors.length,256);
  assert.ok(colors.flat().every(v=>Number.isInteger(v)&&v>=0&&v<=255));
  return digest(Uint8Array.from([...renderFrame({...config,theme})].flatMap(i=>colors[i])));
 });
 assert.equal(new Set(hashes).size,4);
 assert.throws(()=>renderFrame({...config,theme:'invalid'}),/Unknown/);
 assert.throws(()=>getPalette('invalid'),/Unknown/);
});
test('lightning is brief, frame-based, and visible at full scene resolution',()=>{
 const job={...config,width:96,height:64,theme:'storm'};
 for(const index of [0,81,84,119])assert.ok(!renderFrame({...job,index}).includes(255));
 for(const index of [82,83])assert.ok(renderFrame({...job,index}).includes(255));
});
test('GIF global color table matches the selected environment',()=>{
 for(const {id:theme} of themes){
  const job={...config,theme},frame=renderFrame(job),gif=encodeGif([frame],job);
  assert.equal(new TextDecoder().decode(gif.slice(0,6)),'GIF89a');
  assert.equal(gif[6]|gif[7]<<8,config.width);
  assert.equal(gif[8]|gif[9]<<8,config.height);
  assert.deepEqual(gif.slice(13,781),Uint8Array.from(getPalette(theme).flat()));
  assert.equal(gif.at(-1),59);
 }
 assert.deepEqual(encodeGif([renderFrame(config)],config),encodeGif([renderFrame(config)],{...config,theme:'sunny'}));
});
test('host chooses next theme; active configuration is immutable and shared through collection',async()=>{
 const server=createCoordinator();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(action,b={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/'+action,{method:'POST',body:JSON.stringify(b)});return {status:r.status,...await r.json()};};
 try{
  const host=await call('create'),h={code:host.code,id:host.id,secret:host.secret};
  assert.equal(host.config.theme,'sunny');assert.equal(host.selectedTheme,'sunny');
  const guest=await call('join',{code:h.code}),g={code:h.code,id:guest.id,secret:guest.secret};
  assert.equal((await call('configure',{...g,theme:'night'})).status,403);
  assert.equal((await call('configure',{...h,theme:'invalid'})).status,400);
  for(const {id:theme} of themes){
   const prior=(await call('state',h)).config.theme;
   assert.equal((await call('configure',{...h,theme})).selectedTheme,theme);
   // Selecting the next theme must not recolor an already finished run.
   assert.equal((await call('state',h)).config.theme,prior);
   assert.equal((await call('start',{...h,theme:'invalid'})).config.theme,theme);
   assert.equal((await call('configure',{...h,theme:'sunny'})).status,409);
   const late=await call('join',{code:h.code});assert.equal(late.config.theme,theme);
   const hostJob=(await call('claim',h)).job,guestJob=(await call('claim',g)).job;
   for(const job of [hostJob,guestJob])assert.equal(job.theme,theme);
   const pixels=Buffer.alloc(192*128).toString('base64');
   await call('result',{...g,...guestJob,pixels,ms:1});
   for(;;){const {job}=await call('claim',h);if(!job)break;assert.equal(job.theme,theme);assert.equal((await call('result',{...h,...job,pixels,ms:1})).status,200);}
   const collected=await call('frames',h);assert.equal(collected.config.theme,theme);assert.equal(collected.frames.length,120);
  }
 }finally{await new Promise(r=>server.close(r));}
});
