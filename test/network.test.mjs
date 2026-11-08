import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCoordinator} from '../server.mjs';
import {createNetworkTracker,networkStats,networkLayout} from '../public/network-state.js';

async function fixture(t,config={width:2,height:2,count:3}){
 let time=1000;
 const server=createCoordinator({config,now:()=>time});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(action,body={})=>{const res=await fetch(base+'/api/'+action,{method:'POST',body:JSON.stringify(body)});return {status:res.status,...await res.json()};};
 const created=await call('create',{name:'Host'}),h={code:created.code,id:created.id,secret:created.secret};
 return {call,h,created,base,advance:ms=>{time+=ms;}};
}
test('network observes genuine assignments, uploads, joins and recoveries between polls exactly once',async t=>{
 const {call,h,created,advance}=await fixture(t);
 const tracker=createNetworkTracker();assert.deepEqual(tracker.consume(created).events,[]);
 const start=await call('start',h);tracker.consume(start);
 const guest=await call('join',{code:h.code,name:'Guest'}),g={code:guest.code,id:guest.id,secret:guest.secret};
 const a=(await call('claim',h)).job;
 await call('claim',h); // Repeating a claim must not emit a fictional assignment.
 await call('state',{...h,assignment:a}); // Renewal is not a new transfer.
 assert.equal((await call('result',{...h,...a,pixels:'AAAAAA==',ms:2})).status,200);
 assert.equal((await call('result',{...h,...a,pixels:'AAAAAA==',ms:2})).status,409);
 const b=(await call('claim',g)).job;
 await call('leave',g);
 const replacement=(await call('claim',h)).job;
 assert.equal(replacement.index,b.index);
 const snapshot=await call('state',h),events=tracker.consume(snapshot).events;
 assert.deepEqual(events.map(e=>e.type),['joined','assigned','completed','assigned','disconnected','recovered','assigned']);
 assert.equal(events.at(-1).reassigned,true);
 assert.equal(events[5].device,g.id);assert.equal(events[5].reason,'device disconnected');
 assert.deepEqual(networkStats(snapshot),{connected:1,active:1,idle:0,completed:1,recovered:1});
 assert.deepEqual(tracker.consume(await call('state',h)).events,[]);
 assert.ok(tracker.consume(snapshot).stale);
 assert.ok(!JSON.stringify(snapshot.network).includes(h.secret));
 assert.ok(!JSON.stringify(snapshot.network).includes(replacement.token));
 const late=createNetworkTracker();assert.deepEqual(late.consume(snapshot).events,[]);
 await call('state',g); // Reconnect without fabricating a transfer.
 const back=tracker.consume(await call('state',h));assert.deepEqual(back.events.map(e=>e.type),['reconnected']);
 advance(7000);
 const expired=await call('state',g);
 assert.equal(expired.network.events.filter(e=>e.type==='recovered').length,2);
 assert.equal(expired.devices.find(d=>d.id===h.id).status,'Disconnected');
});
test('network history is bounded, gaps are explicit, new runs do not replay old transfers',async t=>{
 const {call,h,created}=await fixture(t,{width:2,height:2,count:70});
 const tracker=createNetworkTracker();tracker.consume(created);await call('start',h);
 for(let i=0;i<70;i++){const {job}=await call('claim',h);await call('result',{...h,...job,pixels:'AAAAAA==',ms:1});}
 const done=await call('state',h);assert.equal(done.network.events.length,128);
 const update=tracker.consume(done);assert.ok(update.gap);assert.equal(update.events.length,128);
 const next=await call('start',h);assert.ok(tracker.consume(next).changed);
 assert.deepEqual(tracker.consume(await call('state',h)).events,[]);
 await call('claim',h);const fresh=tracker.consume(await call('state',h));
 assert.equal(fresh.events.length,1);assert.equal(fresh.events[0].run,next.run);
 tracker.reset();assert.deepEqual(tracker.consume(done).events,[]);
});
test('network exposes only authenticated room snapshots and serves buildless assets',async t=>{
 const {call,h,base}=await fixture(t);
 const unauthorized=await call('state',{...h,secret:'wrong'});
 assert.equal(unauthorized.status,403);assert.equal(unauthorized.network,undefined);
 for(const path of ['/network.js','/network-state.js','/network.css'])assert.equal((await fetch(base+path)).status,200);
});
test('layout supports all 32 contributors and stats distinguish idle, paused and disconnected',()=>{
 for(let count=1;count<=32;count++){
  const devices=Array.from({length:count},(_,i)=>({id:String(i)}));
  const {points,height}=networkLayout(devices);
  assert.equal(points.size,count);
  const seen=new Set();for(const p of points.values()){assert.ok(p.y>=56&&p.y<=height-56);const key=p.x+','+p.y;assert.ok(!seen.has(key));seen.add(key);}
 }
 assert.deepEqual(networkStats({devices:[{online:true,status:'Rendering'},{online:true,status:'Idle'},{online:true,status:'Paused'},{online:false,status:'Disconnected'}],completed:4,recovered:2}),{connected:3,active:1,idle:1,completed:4,recovered:2});
});
