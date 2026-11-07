import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCoordinator} from '../server.mjs';

async function fixture(t){
 let time=100000;
 const server=createCoordinator({now:()=>time});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const call=async(action,body={})=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/'+action,{method:'POST',body:JSON.stringify(body)});
  return {status:response.status,...await response.json()};
 };
 const credentials=d=>({code:d.code,id:d.id,secret:d.secret});
 const host=credentials(await call('create',{name:'Host laptop'}));
 const guest=credentials(await call('join',{code:host.code,name:'Guest laptop'}));
 const result=async(client,ms=100)=>{
  const {job}=await call('claim',client);assert.ok(job);
  const body={...client,...job,pixels:Buffer.alloc(job.width*job.height).toString('base64'),ms};
  assert.equal((await call('result',body)).status,200);return body;
 };
 return {call,host,guest,result,advance:ms=>{time+=ms;}};
}
const device=(s,id)=>s.devices.find(d=>d.id===id);
test('dashboard reports accepted counts, assignments, averages, rates, shares and ranked ties',async t=>{
 const {call,host,guest,result,advance}=await fixture(t);
 let s=await call('state',host);
 assert.equal(s.dashboard.connected,2);assert.equal(s.dashboard.remaining,120);
 assert.equal(s.dashboard.fps,0);assert.equal(device(s,host.id).averageFrameMs,null);
 assert.equal(device(s,host.id).role,'Host');assert.equal(device(s,guest.id).role,'Contributor');
 assert.ok(s.dashboard.leaderboard.every(d=>!d.isLeader));
 assert.ok(s.devices.every(d=>!('secret' in d)));
 await call('start',host);advance(1000);
 const pending=(await call('claim',guest)).job;
 s=await call('state',host);
 assert.equal(s.dashboard.assigned,1);assert.equal(s.dashboard.queued,119);
 assert.equal(device(s,guest.id).status,'Rendering');assert.equal(device(s,guest.id).assigned,1);
 assert.deepEqual(device(s,guest.id).assignedFrames,[pending.index]);
 const accepted=await result(host,200);
 assert.equal((await call('result',accepted)).status,409);
 await result(host,400);await result(guest,500);
 s=await call('state',host);
 assert.equal(s.dashboard.completed,3);assert.equal(s.dashboard.remaining,117);
 assert.equal(s.dashboard.assigned,0);assert.equal(s.dashboard.progressPercent,2.5);
 assert.equal(s.dashboard.fps,3);assert.equal(s.dashboard.sampleDurationMs,1000);
 assert.equal(device(s,host.id).averageFrameMs,300);assert.equal(device(s,host.id).fps,2);
 assert.ok(Math.abs(device(s,host.id).workSharePercent-200/3)<1e-10);
 assert.equal(device(s,guest.id).averageFrameMs,500);assert.equal(device(s,guest.id).status,'Idle');
 assert.equal(s.dashboard.leaderboard[0].id,host.id);assert.ok(s.dashboard.leaderboard[0].isLeader);
 await result(guest,300);
 s=await call('state',guest);
 assert.deepEqual(s.dashboard.leaderboard.map(d=>d.rank),[1,1]);
 assert.ok(s.dashboard.leaderboard.every(d=>d.isLeader));
 assert.ok(s.devices.every(d=>d.workSharePercent===50));
 assert.equal(s.dashboard.fps,s.devices.reduce((n,d)=>n+d.fps,0));
 const same=await call('state',host);
 assert.deepEqual(same.dashboard,s.dashboard);assert.deepEqual(same.devices,s.devices);
 advance(4000);s=await call('state',host);
 assert.equal(s.dashboard.sampleDurationMs,5000);assert.equal(s.dashboard.fps,.8);
 advance(1000);s=await call('state',host);
 assert.equal(s.dashboard.fps,0);assert.ok(s.devices.every(d=>d.fps===0));
 assert.equal(s.dashboard.completed,4);assert.equal(device(s,host.id).averageFrameMs,300);
});

test('pause persists through heartbeats, preserves in-flight work and authenticates the device',async t=>{
 const {call,host,guest,advance}=await fixture(t);
 assert.equal((await call('pause',{...guest,secret:'wrong',paused:true})).status,403);
 assert.equal((await call('pause',{...guest,paused:'yes'})).status,400);
 assert.equal((await call('start',guest)).status,403);
 await call('start',host);advance(1000);
 const {job}=await call('claim',guest);
 let s=await call('pause',{...guest,paused:true});
 assert.equal(device(s,guest.id).paused,true);
 assert.equal(device(s,guest.id).status,'Rendering');assert.equal(s.dashboard.assigned,1);
 assert.equal((await call('claim',guest)).job.token,job.token);
 assert.equal((await call('result',{...guest,...job,pixels:Buffer.alloc(job.width*job.height).toString('base64'),ms:200})).status,200);
 s=await call('state',guest);assert.equal(device(s,guest.id).status,'Paused');
 assert.equal(device(s,host.id).paused,false);assert.equal(s.dashboard.connected,2);
 assert.equal((await call('state',host)).devices.find(d=>d.id===guest.id).status,'Paused');
 s=await call('pause',{...guest,paused:false});assert.equal(device(s,guest.id).status,'Idle');
 assert.ok((await call('claim',guest)).job);
 assert.equal((await call('frames',guest)).status,403);
});

test('disconnect, lease expiry, reconnect and leave preserve credit and recover assignments',async t=>{
 const {call,host,guest,result,advance}=await fixture(t);
 await call('start',host);advance(1000);await result(guest,250);
 const {job}=await call('claim',guest);
 advance(7001);
 let s=await call('state',host);
 assert.equal(device(s,guest.id).status,'Disconnected');
 assert.equal(s.dashboard.connected,1);assert.equal(s.dashboard.assigned,0);
 assert.equal(s.recovered,1);assert.equal(device(s,guest.id).completed,1);
 assert.equal(device(s,guest.id).workSharePercent,100);
 const stale={...guest,...job,pixels:Buffer.alloc(job.width*job.height).toString('base64'),ms:200};
 assert.equal((await call('result',stale)).status,409);
 s=await call('state',guest);assert.equal(device(s,guest.id).status,'Idle');
 assert.equal(s.dashboard.connected,2);
 const next=(await call('claim',guest)).job;assert.notEqual(next.token,job.token);
 // Keep the device alive while its lease expires.
 for(let i=0;i<6;i++){advance(5000);await call('state',guest);}
 advance(1);s=await call('state',guest);
 assert.equal(device(s,guest.id).status,'Idle');assert.equal(device(s,guest.id).assigned,0);
 assert.equal(s.recovered,2);
 await call('claim',guest);await call('leave',guest);
 s=await call('state',host);assert.equal(device(s,guest.id).status,'Disconnected');
 assert.equal(s.recovered,3);assert.equal(s.dashboard.completed,1);
});

test('new runs clear metrics and resume devices; unnamed devices get identifiers',async t=>{
 const {call,host,guest,result,advance}=await fixture(t);
 const unnamed=await call('join',{code:host.code,name:'   '});
 assert.match(device(unnamed,unnamed.id).name,/^Device [0-9a-f]{6}$/);
 await call('start',host);advance(1000);
 for(let i=0;i<120;i++)await result(host,100);
 await call('pause',{...guest,paused:true});
 let s=await call('state',host);assert.equal(s.dashboard.completed,120);
 assert.equal(s.dashboard.remaining,0);assert.equal(s.dashboard.progressPercent,100);
 assert.equal(device(s,host.id).averageFrameMs,100);
 s=await call('start',host);
 assert.equal(s.dashboard.completed,0);assert.equal(s.dashboard.fps,0);
 assert.equal(s.dashboard.remaining,120);assert.equal(s.dashboard.assigned,0);
 assert.ok(s.devices.every(d=>d.averageFrameMs===null&&d.workSharePercent===0&&d.completed===0));
 assert.ok(s.dashboard.leaderboard.every(d=>!d.isLeader));
 assert.equal(device(s,guest.id).status,'Idle');
});
