import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createCoordinator} from '../server.mjs';
import {validateConfig, frameRequestLimit, HARD_MAX_REQUEST_BYTES} from '../public/config.js';

async function setup(t, options={}) {
 let time=1000;
 const server=createCoordinator({config:{width:8,height:8,count:2},disconnectMs:100000,now:()=>time,...options});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}`;
 const raw=async(action,body)=>{const r=await fetch(`${url}/api/${action}`,{method:'POST',body});return {status:r.status,...await r.json()};};
 const call=(action,body={})=>raw(action,JSON.stringify(body));
 const host=await call('create'),guest=await call('join',{code:host.code});
 const auth=d=>({code:d.code,id:d.id,secret:d.secret});
 const h=auth(host),g=auth(guest),started=await call('start',h);
 const pixels=Buffer.alloc(started.config.width*started.config.height).toString('base64');
 return {call,raw,url,h,g,started,pixels,setTime:value=>{time=value;}};
}

test('only matching authenticated assignment proofs renew leases; expired results stay rejected',async t=>{
 const {call,h,g,started,pixels,setTime}=await setup(t);
 const {job}=await call('claim',h);
 setTime(29000);
 for(const body of [
  {...g,assignment:job}, {...h,assignment:{...job,index:1}},
  {...h,assignment:{...job,run:'old'}}, {...h,assignment:{...job,token:'wrong'}}, h
 ]) assert.equal((await call('state',body)).leaseRenewed,false);
 assert.equal((await call('state',{...h,secret:'wrong',assignment:job})).status,403);
 assert.equal((await call('state',{...h,run:started.run,assignment:job})).leaseRenewed,true);
 setTime(32000); // Beyond original expiry, but renewed lease remains valid.
 assert.equal((await call('result',{...h,...job,pixels,ms:31000})).status,200);
 const next=(await call('claim',h)).job;
 setTime(62000); // Exactly expired, even though still online.
 assert.equal((await call('state',{...h,assignment:next})).leaseRenewed,false);
 assert.equal((await call('result',{...h,...next,pixels,ms:1})).status,409);
 const replacement=(await call('claim',g)).job;
 assert.notEqual(replacement.token,next.token);
 assert.equal((await call('result',{...h,...next,pixels,ms:1})).status,409);
});

test('ordinary heartbeats do not renew leases and disconnects recover renewed work',async t=>{
 const {call,h,g,setTime}=await setup(t,{disconnectMs:7000});
 const {job}=await call('claim',h);
 for(let time=6000;time<=31000;time+=5000){setTime(time);await call('state',h);}
 assert.equal((await call('state',h)).frames[job.index].state,'queued');
 const next=(await call('claim',h)).job;
 assert.equal((await call('state',{...h,assignment:next})).leaseRenewed,true);
 setTime(38000);
 const state=await call('state',g);
 assert.equal(state.devices.find(d=>d.id===h.id).status,'Disconnected');
 assert.equal(state.frames[next.index].state,'queued');
 assert.equal((await call('state',{...h,assignment:next})).leaseRenewed,false);
});

test('pause finishes assigned work; resume and new runs reset pause and contribution statistics',async t=>{
 const {call,h,g,started,pixels}=await setup(t);
 const {job}=await call('claim',g);
 let state=await call('state',{...g,run:started.run,paused:true,assignment:job});
 assert.equal(state.devices.find(d=>d.id===g.id).status,'Rendering');
 assert.equal(state.leaseRenewed,true);
 assert.equal((await call('claim',g)).job.token,job.token);
 assert.equal((await call('result',{...g,...job,pixels,ms:125})).status,200);
 state=await call('state',g);
 const device=state.devices.find(d=>d.id===g.id);
 assert.equal(device.status,'Paused');assert.equal(device.completed,1);
 assert.equal(device.renderTimeMs,125);assert.equal(device.averageFrameMs,125);
 assert.equal(device.contributionPercent,50);assert.equal(device.uploadBytes,64);
 assert.equal((await call('claim',g)).job,null);
 state=await call('state',{...g,run:started.run,paused:false});
 assert.equal(state.devices.find(d=>d.id===g.id).status,'Idle');
 const next=(await call('claim',g)).job;
 await call('result',{...g,...next,pixels,ms:75});
 for(const d of [h,g])await call('state',{...d,run:started.run,paused:true});
 state=await call('start',h);
 assert.ok(state.devices.every(d=>!d.paused&&d.completed===0&&d.renderTimeMs===0&&d.status==='Idle'));
 state=await call('state',{...g,run:started.run,paused:true,assignment:job});
 assert.equal(state.leaseRenewed,false);assert.equal(state.devices.find(d=>d.id===g.id).paused,false);
 assert.ok((await call('claim',g)).job);
 assert.equal((await call('result',{...g,...job,pixels,ms:1})).status,409);
});

test('configured larger frames upload and collect; malformed and oversized bodies are rejected',async t=>{
 const {call,raw,url,h,pixels}=await setup(t,{config:{width:320,height:240,count:1,fps:25}});
 const {job}=await call('claim',h);
 assert.ok(pixels.length>100000);
 for(const body of ['{','null','[]'])assert.equal((await raw('state',body)).status,400);
 assert.equal((await raw('state',JSON.stringify({...h,padding:'🌤'.repeat(6000)}))).status,413);
 for(const invalid of [pixels.slice(4),'!'+pixels.slice(1)])assert.equal((await call('result',{...h,...job,pixels:invalid,ms:1})).status,400);
 assert.equal((await call('result',{...h,...job,pixels,ms:-1})).status,400);
 assert.equal((await call('result',{...h,...job,pixels,padding:'x'.repeat(17000),ms:1})).status,413);
 const chunkedStatus=await new Promise((resolve,reject)=>{
  const req=http.request(`${url}/api/result`,{method:'POST'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
  // Before parsing a room ID, the stream cap must accommodate all UI presets.
  req.on('error',reject);req.write('x'.repeat(frameRequestLimit({width:576,height:384})));req.end('x');
 });
 assert.equal(chunkedStatus,413);
 assert.equal((await call('result',{...h,...job,pixels,ms:40})).status,200);
 const frames=await call('frames',h);
 assert.deepEqual(frames.config,{width:320,height:240,count:1,fps:25,theme:'sunny',density:'medium',background:'original'});assert.equal(frames.frames[0],pixels);
});

test('configuration bounds preserve defaults and enforce a hard request ceiling',()=>{
 assert.deepEqual(validateConfig(),{width:192,height:128,count:120,fps:20,theme:'sunny',density:'medium',background:'original'});
 for(const config of [{width:0},{height:1.5},{count:601},{fps:101},{width:2049},{width:2048,height:2048,count:120}])assert.throws(()=>createCoordinator({config}));
 assert.throws(()=>createCoordinator({maxRequestBytes:HARD_MAX_REQUEST_BYTES+1}));
 assert.throws(()=>createCoordinator({maxRequestBytes:100}));
 assert.ok(frameRequestLimit(validateConfig({width:2048,height:2048,count:1}))<HARD_MAX_REQUEST_BYTES);
});

