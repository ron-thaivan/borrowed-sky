import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCoordinator} from '../server.mjs';
import {compareBenchmarks,benchmarkConditions,recordBenchmark,HISTORY_LIMIT} from '../lib/benchmarks.mjs';

const baseline={id:'one',deviceCount:1,participants:[{id:'host'}],workload:'same',conditions:{series:'Lab A',confirmed:true},wallTimeMs:10000,workerTimeMs:999999,recovered:0};
const multi={...baseline,id:'two',deviceCount:2,participants:[{id:'host'},{id:'guest'}],wallTimeMs:4000,workerTimeMs:1};
test('workload identity covers every rendering setting and completed records require all accepted frames',()=>{
 const room={run:'run',started:1000,finished:2000,config:{width:2,height:2,count:1,fps:10,theme:'sunny'},
  frames:[{state:'done',ms:100,data:Buffer.alloc(4)}],devices:new Map([['host',{id:'host',name:'Host',completed:1}]]),recovered:0};
 const first=recordBenchmark(room);
 for(const changed of [{width:3},{height:3},{fps:20},{theme:'night'},{futureSetting:1}])assert.notEqual(recordBenchmark({...room,config:{...room.config,...changed}}).workload,first.workload);
 assert.notEqual(recordBenchmark({...room,config:{...room.config,count:2},frames:[...room.frames,...room.frames]}).workload,first.workload);
 assert.throws(()=>recordBenchmark({...room,finished:null}));
 assert.throws(()=>recordBenchmark({...room,frames:[]}));
 assert.throws(()=>recordBenchmark({...room,frames:[{state:'working'}]}));
});
test('speedup divides comparable wall times and supports slowdowns without using worker time',()=>{
 assert.deepEqual(compareBenchmarks(baseline,multi),{speedup:2.5,timeReductionPercent:60,reason:null,baselineId:'one'});
 const slower=compareBenchmarks(baseline,{...multi,wallTimeMs:20000});
 assert.equal(slower.speedup,.5);assert.equal(slower.timeReductionPercent,-100);
 for(const changed of [{workload:'other'},{conditions:null},{conditions:{series:'Other',confirmed:true}},
   {participants:[{id:'other'}]},{recovered:1},{wallTimeMs:0},{deviceCount:1}]){
  const result=compareBenchmarks(baseline,{...multi,...changed});assert.equal(result.speedup,null);assert.ok(result.reason);
 }
 assert.equal(compareBenchmarks(null,multi).speedup,null);
 assert.equal(compareBenchmarks({...baseline,deviceCount:2},multi).speedup,null);
 assert.equal(compareBenchmarks({...baseline,wallTimeMs:0},multi).speedup,null);
 assert.equal(benchmarkConditions(undefined),null);
 for(const input of [{},{series:'',confirmed:true},{series:'lab',confirmed:false},{series:'x'.repeat(161),confirmed:true}])assert.throws(()=>benchmarkConditions(input));
});

async function fixture(t){
 let time=100000;
 const server=createCoordinator({config:{width:2,height:2,count:2,fps:10},now:()=>time});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=async(action,body={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/${action}`,{method:'POST',body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
 const credentials=s=>({id:s.id,secret:s.secret,code:s.code});
 const host=credentials(await call('create'));
 const guest=credentials(await call('join',{code:host.code}));
 const conditions={series:'Lab A · AC power · Chrome',confirmed:true};
 const finishFrame=async(device,ms=100,advance=100)=>{const {job}=await call('claim',device);time+=advance;const body={...device,...job,ms,pixels:Buffer.alloc(4).toString('base64')};assert.equal((await call('result',body)).status,200);return body;};
 return {call,host,guest,conditions,finishFrame};
}
test('completion collects accepted measurements once, freezes config, authenticates history, and computes comparisons',async t=>{
 const {call,host,guest,conditions,finishFrame}=await fixture(t);
 assert.equal((await call('benchmarks',guest)).status,403);
 assert.equal((await call('benchmarks',{...host,secret:'wrong'})).status,403);
 assert.equal((await call('start',{...host,benchmark:{series:'invalid'}})).status,400);
 assert.deepEqual((await call('benchmarks',host)).runs,[]);
 await call('start',{...host,benchmark:conditions});
 await finishFrame(host,150,400);
 assert.deepEqual((await call('benchmarks',host)).runs,[]);
 const upload=await finishFrame(host,250,600);
 assert.equal((await call('result',upload)).status,409);
 const first=(await call('benchmarks',host)).runs[0];
 assert.equal(first.deviceCount,1);assert.equal(first.framesCompleted,2);
 assert.equal(first.wallTimeMs,1000);assert.equal(first.workerTimeMs,400);
 assert.equal(first.averageFrameMs,200);assert.equal(first.fps,2);assert.equal(first.payloadBytes,8);
 assert.equal(first.startedAt,'1970-01-01T00:01:40.000Z');
 const networkBefore=(await call('state',host)).network;
 assert.equal(networkBefore.events.filter(e=>e.type==='completed').length,first.framesCompleted);
 assert.equal(networkBefore.events.filter(e=>e.type==='assigned').length,first.framesCompleted);
 await call('benchmarks',host);
 assert.deepEqual((await call('state',host)).network,networkBefore);
 assert.equal((await call('state',guest)).benchmarks,undefined);
 assert.equal(first.completedAt,'1970-01-01T00:01:41.000Z');
 assert.deepEqual(first.config,{width:2,height:2,count:2,fps:10,theme:'sunny'});
 assert.ok(!JSON.stringify(first).includes(host.secret));
 await call('start',{...host,benchmark:conditions});
 await finishFrame(host,70,100);await finishFrame(guest,90,400);
 let history=(await call('benchmarks',host)).runs;
 assert.equal(history.length,2);assert.equal(history[1].deviceCount,2);
 const completedState=await call('state',host);
 assert.equal(completedState.network.events.filter(e=>e.type==='completed'&&e.run===history[1].id).length,history[1].framesCompleted);
 assert.equal(completedState.computeMs,history[1].workerTimeMs);
 assert.equal(completedState.uploadBytes,history[1].payloadBytes);
 assert.equal(history[1].comparison.speedup,2);assert.equal(history[1].comparison.timeReductionPercent,50);
 assert.deepEqual(history[0],first);
 await call('configure',{...host,theme:'night'});
 await call('start',{...host,benchmark:conditions});await finishFrame(host);await finishFrame(guest);
 history=(await call('benchmarks',host)).runs;
 assert.equal(history[2].config.theme,'night');assert.notEqual(history[2].workload,first.workload);
 assert.equal(history[2].comparison.speedup,null);assert.deepEqual(history[0],first);
 await call('start',host);await finishFrame(host);await finishFrame(guest);
 assert.equal((await call('benchmarks',host)).runs.at(-1).conditions,null);
 assert.equal((await call('benchmarks',{...host,baselineId:'missing'})).status,400);
});
test('history is bounded without retaining frame buffers, and zero wall duration has no FPS or speedup',async t=>{
 const {call,host,finishFrame}=await fixture(t);
 for(let i=0;i<HISTORY_LIMIT+1;i++){
  await call('start',host);await finishFrame(host,1,0);await finishFrame(host,1,0);
 }
 const result=await call('benchmarks',host);
 assert.equal(result.limit,HISTORY_LIMIT);assert.equal(result.runs.length,HISTORY_LIMIT);
 assert.ok(result.runs.every(r=>r.fps===null&&r.wallTimeMs===0&&r.averageFrameMs===1&&!('frames' in r)));
});
