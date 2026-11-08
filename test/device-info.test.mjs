import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,randomUUID} from 'node:crypto';
import {createCoordinator} from '../server.mjs';
import {createDeviceReporter,validateDeviceInfo,deviceInfoLabels} from '../public/device-info.js';

function browserEnv(){
 const values=new Map();
 return {crypto:webcrypto,localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},
  navigator:{hardwareConcurrency:8,deviceMemory:8,platform:'Win32',userAgent:'Mozilla/5.0 Chrome/125.0.0.0 Safari/537.36'}};
}

test('browser identity persists across reloads and tabs without fingerprinting or secure-context randomUUID',()=>{
 const env=browserEnv(),report=createDeviceReporter(env),first=report();
 assert.equal(first.logicalProcessors,8);assert.equal(first.memoryGiB,8);assert.equal(first.os,'Windows');assert.equal(first.browser,'Chrome');
 assert.equal(report().browserId,first.browserId);
 assert.equal(createDeviceReporter(env)().browserId,first.browserId);
 assert.notEqual(createDeviceReporter(browserEnv())().browserId,first.browserId);
 env.navigator.hardwareConcurrency=4;env.navigator.deviceMemory=undefined;
 const updated=report();assert.equal(updated.browserId,first.browserId);assert.equal(updated.logicalProcessors,4);assert.equal(updated.memoryGiB,null);
 assert.deepEqual(Object.keys(first).sort(),['browser','browserId','logicalProcessors','memoryGiB','os']);
 assert.ok(!JSON.stringify(first).includes('125.0'));
});

test('blocked storage, malformed saved identity, unavailable APIs and hints are safe',()=>{
 const env=browserEnv();env.localStorage.setItem('borrowed-sky-browser-id','not a uuid');
 assert.doesNotThrow(()=>validateDeviceInfo(createDeviceReporter(env)()));
 Object.defineProperty(env,'localStorage',{get(){throw Error('Blocked');}});
 const report=createDeviceReporter(env);assert.equal(report().browserId,report().browserId);
 assert.deepEqual(createDeviceReporter({})(),{browserId:null,logicalProcessors:null,memoryGiB:null,os:'Unknown',browser:'Unknown'});
 const nav={};for(const key of ['hardwareConcurrency','deviceMemory','platform','userAgentData','userAgent'])Object.defineProperty(nav,key,{get(){throw Error('Unavailable');}});
 assert.doesNotThrow(()=>validateDeviceInfo(createDeviceReporter({navigator:nav})()));
 const hints=createDeviceReporter({navigator:{userAgentData:{platform:'Chrome OS',brands:[{brand:'Chromium',version:'123'}]},deviceMemory:32}})();
 assert.equal(hints.os,'ChromeOS');assert.equal(hints.browser,'Chromium');assert.equal(hints.memoryGiB,32);
});

test('reports reject invalid resources and extra personal fields; unknown values stay explicit',()=>{
 for(const invalid of [null,[],1,{browserId:'host'},{logicalProcessors:0},{logicalProcessors:1.5},{logicalProcessors:2048},{logicalProcessors:'8'},
  {memoryGiB:-1},{memoryGiB:3},{memoryGiB:Infinity},{memoryGiB:NaN},{memoryGiB:2048},{os:'<script>'},{browser:'invented'},
  {hostname:'private-name'},{cpuUsage:90},{availableMemory:123},{secret:'stolen'}])assert.throws(()=>validateDeviceInfo(invalid));
 assert.deepEqual(deviceInfoLabels(null),{environment:'Not reported',hardware:'Not reported'});
 assert.match(deviceInfoLabels(validateDeviceInfo({})).hardware,/Processors unavailable.*RAM unavailable/);
 assert.match(deviceInfoLabels({logicalProcessors:8,memoryGiB:4,os:'Linux',browser:'Firefox',browserLabel:'Browser abcdef12'}).hardware,/8 logical processors.*~4 GiB RAM/);
});

async function setup(t){
 let time=1000;
 const server=createCoordinator({config:{width:8,height:8,count:3},now:()=>time});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(action,body={})=>{const res=await fetch(base+'/api/'+action,{method:'POST',body:JSON.stringify(body)});return {status:res.status,...await res.json()};};
 return {call,base,setTime:value=>{time=value;}};
}
const auth=s=>({code:s.code,id:s.id,secret:s.secret});
const report=()=>({browserId:randomUUID(),logicalProcessors:8,memoryGiB:8,os:'Windows',browser:'Chrome'});

test('registration supports old clients and multiple independent sessions sharing a browser label',async t=>{
 const {call,base}=await setup(t),info=report();
 const host=await call('create',{deviceInfo:info});assert.equal(host.status,200);
 const guest=await call('join',{code:host.code,deviceInfo:info});
 const legacy=await call('join',{code:host.code,name:'Legacy'});
 assert.notEqual(host.id,guest.id);assert.notEqual(host.secret,guest.secret);
 const state=await call('state',auth(host));assert.equal(state.devices.length,3);assert.equal(state.dashboard.connected,3);
 for(const id of [host.id,guest.id])assert.equal(state.devices.find(d=>d.id===id).deviceInfo.browserLabel,'Browser '+info.browserId.slice(0,8));
 assert.equal(state.devices.find(d=>d.id===legacy.id).deviceInfo,null);
 assert.ok(!JSON.stringify(state).includes(info.browserId),'full persistent ID is not exposed to other contributors');
 assert.equal((await call('configure',{...auth(guest),theme:'night'})).status,403);
 await call('start',auth(host));
 const claims=await Promise.all([host,guest,legacy].map(d=>call('claim',auth(d))));
 assert.equal(new Set(claims.map(c=>c.job.index)).size,3);
 for(let i=0;i<3;i++)assert.equal((await call('result',{...auth([host,guest,legacy][i]),...claims[i].job,pixels:Buffer.alloc(64).toString('base64'),ms:5})).status,200);
 const done=await call('state',auth(host));assert.equal(done.completed,3);assert.deepEqual(done.devices.map(d=>d.completed),[1,1,1]);
 assert.equal((await fetch(base+'/device-info.js')).status,200);
});

test('authenticated reconnect refreshes resources without reviving stale assignments',async t=>{
 const {call,setTime}=await setup(t),host=await call('create'),info=report();
 const guest=await call('join',{code:host.code,deviceInfo:info}),h=auth(host),g=auth(guest);
 await call('start',h);const job=(await call('claim',g)).job;
 setTime(9000);const offline=await call('state',h);assert.equal(offline.recovered,1);
 const newer={...info,logicalProcessors:4,memoryGiB:null,os:'Linux',browser:'Firefox'};
 const back=await call('state',{...g,deviceInfo:newer,assignment:job});
 assert.equal(back.leaseRenewed,false);assert.equal(back.recovered,1);
 const device=back.devices.find(d=>d.id===g.id);assert.equal(device.online,true);assert.equal(device.deviceInfo.logicalProcessors,4);assert.equal(device.deviceInfo.memoryGiB,null);assert.equal(device.deviceInfo.reportedAt,9000);
 const retained=await call('state',g);assert.deepEqual(retained.devices.find(d=>d.id===g.id).deviceInfo,device.deviceInfo);
 assert.equal((await call('result',{...g,...job,pixels:Buffer.alloc(64).toString('base64'),ms:1})).status,409);
 const replacement=(await call('claim',h)).job;assert.equal(replacement.index,job.index);assert.notEqual(replacement.token,job.token);
 assert.equal((await call('state',{...g,secret:h.secret,deviceInfo:info})).status,403);
 assert.equal((await call('state',{...g,deviceInfo:{logicalProcessors:'bad'}})).status,400);
 assert.deepEqual((await call('state',h)).devices.find(d=>d.id===g.id).deviceInfo,device.deviceInfo);
});

test('invalid registration reports do not allocate device slots; valid heartbeats preserve lease renewal',async t=>{
 const {call,setTime}=await setup(t),host=await call('create'),h=auth(host);
 assert.equal((await call('create',{deviceInfo:{memoryGiB:-8}})).status,400);
 assert.equal((await call('join',{code:h.code,deviceInfo:{os:'arbitrary'}})).status,400);
 assert.equal((await call('state',h)).devices.length,1);
 await call('start',h);const job=(await call('claim',h)).job;
 for(let n=6000;n<=31000;n+=5000){setTime(n);const s=await call('state',{...h,assignment:job,deviceInfo:report()});assert.equal(s.leaseRenewed,true);assert.equal(s.recovered,0);}
 assert.equal((await call('result',{...h,...job,pixels:Buffer.alloc(64).toString('base64'),ms:30000})).status,200);
});
