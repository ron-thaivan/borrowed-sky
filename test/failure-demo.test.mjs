import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCoordinator} from '../server.mjs';

async function fixture(t){
 let time=1000;
 const server=createCoordinator({config:{width:2,height:2,count:4},now:()=>time});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const call=async(action,body={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/${action}`,{method:'POST',body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
 const auth=s=>({code:s.code,id:s.id,secret:s.secret});
 const host=auth(await call('create',{name:'Host'})),guest=auth(await call('join',{code:host.code,name:'Guest'})),other=auth(await call('join',{code:host.code,name:'Other'}));
 const start=await call('start',host),command={...host,run:start.run,targetId:guest.id};
 const result=(device,job)=>call('result',{...device,...job,pixels:'AAAAAA==',ms:25});
 return {call,host,guest,other,start,command,result,advance:ms=>{time+=ms;}};
}
const device=(snapshot,id)=>snapshot.devices.find(d=>d.id===id);

test('simulated failure uses real recovery, rejects late results, and does not revive through authenticated traffic',async t=>{
 const {call,host,guest,other,command,result}=await fixture(t);
 const completed=(await call('claim',guest)).job;await result(guest,completed);
 const abandoned=(await call('claim',guest)).job;
 await call('state',{...guest,assignment:abandoned});
 const failed=await call('simulate-failure',command);
 assert.equal(failed.status,200);assert.equal(device(failed,guest.id).status,'Disconnected');assert.equal(device(failed,guest.id).simulatedFailure,true);
 assert.equal(failed.frames[abandoned.index].state,'queued');assert.equal(failed.frames[abandoned.index].device,null);assert.equal(failed.recovered,1);
 assert.deepEqual(failed.failureNotice.recoveredFrames,[abandoned.index]);assert.equal(device(failed,guest.id).completed,1);
 const recovery=failed.network.events.find(e=>e.type==='recovered');assert.equal(recovery.reason,'simulated worker failure');assert.equal(recovery.simulated,true);
 assert.equal((await call('simulate-failure',command)).status,409);
 for(let i=0;i<3;i++){
  const state=await call('state',{...guest,assignment:abandoned});assert.equal(state.leaseRenewed,false);assert.equal(device(state,guest.id).online,false);assert.equal(state.recovered,1);
  assert.equal((await call('claim',guest)).job,null);
  assert.equal((await result(guest,abandoned)).status,409);
 }
 const replacement=(await call('claim',other)).job;
 assert.equal(replacement.index,abandoned.index);assert.notEqual(replacement.token,abandoned.token);
 assert.equal((await result(other,replacement)).status,200);
 const after=await call('state',host);
 assert.ok(after.network.events.some(e=>e.type==='assigned'&&e.device===other.id&&e.index===abandoned.index&&e.reassigned));
 assert.equal(after.network.events.filter(e=>e.type==='recovered').length,1);
 assert.equal(after.network.events.filter(e=>e.type==='disconnected'&&e.device===guest.id).length,1);
 assert.ok(!after.network.events.some(e=>e.type==='reconnected'&&e.device===guest.id));
});

test('only authenticated host can fail or restore a connected non-host in the current run',async t=>{
 const {call,host,guest,other,command}=await fixture(t);
 for(const action of ['simulate-failure','restore-worker']){
  assert.equal((await call(action,{...command,...guest})).status,403);
  assert.equal((await call(action,{...command,secret:'wrong'})).status,403);
  assert.equal((await call(action,{...command,targetId:host.id})).status,400);
  assert.equal((await call(action,{...command,targetId:'missing'})).status,404);
  assert.equal((await call(action,{...command,run:'old'})).status,409);
  assert.equal((await call(action,{...host,targetId:guest.id})).status,409);
 }
 await call('leave',other);
 assert.equal((await call('simulate-failure',{...command,targetId:other.id})).status,409);
 const state=await call('state',host);assert.equal(device(state,host.id).online,true);assert.equal(state.recovered,0);
});

test('reset is repeatable without resurrecting leases; idle failures do not claim fictitious recovery',async t=>{
 const {call,host,guest,command,result}=await fixture(t);
 const first=(await call('claim',guest)).job;
 await call('simulate-failure',command);
 let state=await call('restore-worker',command);
 assert.equal(device(state,guest.id).simulatedFailure,false);assert.equal(device(state,guest.id).online,true);
 assert.equal((await result(guest,first)).status,409);
 const second=(await call('claim',guest)).job;assert.notEqual(second.token,first.token);
 await call('simulate-failure',command);state=await call('restore-worker',command);assert.equal(state.recovered,2);
 const count=state.network.sequence;assert.equal((await call('restore-worker',command)).network.sequence,count);
 const next=(await call('claim',host)).job;await result(host,next);
 state=await call('simulate-failure',command);assert.deepEqual(state.failureNotice.recoveredFrames,[]);assert.equal(state.recovered,2);
 await call('restore-worker',command);
 while(true){const {job}=await call('claim',host);if(!job)break;await result(host,job);}
 assert.equal((await call('simulate-failure',command)).status,409);
});

test('real timeout and lease recovery still work; reset does not invent physical connectivity; new runs clear failures',async t=>{
 const {call,host,guest,other,command,result,advance}=await fixture(t);
 await call('claim',guest);await call('simulate-failure',command);
 advance(7000);
 let state=await call('restore-worker',command);assert.equal(device(state,guest.id).online,false);assert.equal(device(state,guest.id).simulatedFailure,false);
 state=await call('state',guest);assert.equal(device(state,guest.id).online,true);
 const job=(await call('claim',guest)).job;advance(7000);
 state=await call('state',host);assert.equal(state.frames[job.index].state,'queued');assert.equal(state.recovered,2);
 assert.equal(state.network.events.filter(e=>e.type==='recovered').at(-1).reason,'device disconnected');
 await call('state',other);await call('claim',other);
 for(let i=0;i<6;i++){advance(5000);await call('state',other);}
 state=await call('state',host);assert.equal(state.network.events.filter(e=>e.type==='recovered').at(-1).reason,'lease expired');
 await call('state',guest);await call('simulate-failure',command);
 while(true){const {job}=await call('claim',host);if(!job)break;await result(host,job);}
 const restarted=await call('start',host);assert.equal(restarted.failureNotice,null);assert.ok(restarted.devices.every(d=>!d.simulatedFailure));
 assert.equal((await call('restore-worker',command)).status,409);
 assert.ok((await call('claim',{...guest,run:restarted.run})).job);
});
