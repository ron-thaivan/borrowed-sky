import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCoordinator} from '../server.mjs';
import {renderFrame,getPalette,themes} from '../public/renderer.js';
import {encodeGif} from '../public/gif.js';

test('all themes work with larger configured frames, renewable leases, dashboard and GIF',async t=>{
 let time=1000;
 const server=createCoordinator({config:{width:320,height:240,count:3,fps:12},disconnectMs:100000,now:()=>time});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=async(action,body={})=>{
  const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/'+action,{method:'POST',body:JSON.stringify(body)});
  return {status:res.status,...await res.json()};
 };
 const auth=d=>({code:d.code,id:d.id,secret:d.secret});
 const host=auth(await call('create')),guest=auth(await call('join',{code:host.code}));
 let oldRun=null;
 for(const {id:theme} of themes){
  time+=100000;
  assert.equal((await call('configure',{...host,theme})).status,200);
  const state=await call('start',host),run=state.run;
  if(oldRun)assert.equal((await call('pause',{...guest,run:oldRun,paused:true})).status,409);
  const {job}=await call('claim',{...guest,run});
  assert.deepEqual([job.width,job.height,job.theme],[320,240,theme]);
  time+=29000;
  assert.equal((await call('state',{...guest,run,assignment:job})).leaseRenewed,true);
  time+=2000;
  const upload=async(client,job,ms)=>{
   const pixels=Buffer.from(renderFrame(job)).toString('base64');
   assert.ok(pixels.length>100000);
   assert.equal((await call('result',{...client,...job,pixels,ms})).status,200);
  };
  await upload(guest,job,31000);
  const partial=await call('state',host),d=partial.devices.find(d=>d.id===guest.id);
  assert.equal(d.averageFrameMs,31000);
  assert.equal(d.workSharePercent,100);
  assert.ok(Math.abs(d.contributionPercent-100/3)<1e-10);
  assert.equal(partial.dashboard.completed,1);
  assert.equal(partial.dashboard.leaderboard[0].id,guest.id);
  for(let i=0;i<2;i++)await upload(host,(await call('claim',{...host,run})).job,200);
  const collected=await call('frames',host);
  assert.equal(collected.config.theme,theme);
  const gif=encodeGif(collected.frames.map(p=>Buffer.from(p,'base64')),collected.config);
  assert.deepEqual([...gif.slice(6,10)],[64,1,240,0]);
  assert.deepEqual(gif.slice(13,781),Uint8Array.from(getPalette(theme).flat()));
  assert.equal((await call('state',guest)).dashboard.progressPercent,100);
  oldRun=run;
 }
});
