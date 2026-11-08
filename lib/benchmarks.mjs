// Bump this when the rendering algorithm or timed worker workload changes.
export const WORKLOAD_VERSION = 'cloud-configurable-density-v2';
export const HISTORY_LIMIT = 50;

export function benchmarkConditions(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || typeof input.series !== 'string' ||
      !input.series.trim() || input.series.length > 160 || input.confirmed !== true) {
    throw new Error('Confirm comparable conditions and provide a test series (up to 160 characters).');
  }
  return {series:input.series.trim(),confirmed:true};
}

export function recordBenchmark(room) {
  if (room.finished === null || room.frames.length !== room.config.count ||
      room.frames.some(f=>f.state !== 'done')) throw new Error('Only complete runs can be recorded');
  const config = {...room.config};
  const workerTimeMs = room.frames.reduce((sum,f)=>sum+f.ms,0);
  const wallTimeMs = room.finished-room.started;
  const participants = [...room.devices.values()].filter(d=>d.completed>0)
    .map(d=>({id:d.id,name:d.name,frames:d.completed}));
  return {id:room.run,startedAt:new Date(room.started).toISOString(),completedAt:new Date(room.finished).toISOString(),
    config,workload:JSON.stringify([WORKLOAD_VERSION,Object.keys(config).sort().map(k=>[k,config[k]])]),
    conditions:room.benchmarkConditions ? {...room.benchmarkConditions} : null,
    participants,deviceCount:participants.length,framesCompleted:room.frames.length,
    wallTimeMs,workerTimeMs,fps:wallTimeMs>0?room.frames.length*1000/wallTimeMs:null,
    averageFrameMs:workerTimeMs/room.frames.length,
    payloadBytes:room.frames.reduce((sum,f)=>sum+f.data.length,0),recovered:room.recovered};
}

export function compareBenchmarks(baseline,run) {
  const unavailable = reason=>({speedup:null,timeReductionPercent:null,reason});
  if (!baseline) return unavailable('No comparable single-device baseline');
  if (baseline.deviceCount!==1 || run.deviceCount<2) return unavailable('Requires one-device baseline and multi-device run');
  if (baseline.workload!==run.workload) return unavailable('Different rendering workloads');
  if (!baseline.conditions?.confirmed || !run.conditions?.confirmed || baseline.conditions.series!==run.conditions.series)
    return unavailable('Comparable test conditions were not confirmed for the same series');
  if (!run.participants.some(d=>d.id===baseline.participants[0]?.id)) return unavailable('Baseline device must participate in both runs');
  if (baseline.recovered || run.recovered) return unavailable('Reassigned work makes these runs unsuitable for this comparison');
  if (!(baseline.wallTimeMs>0) || !(run.wallTimeMs>0)) return unavailable('Wall time must be positive');
  return {speedup:baseline.wallTimeMs/run.wallTimeMs,
    timeReductionPercent:(1-run.wallTimeMs/baseline.wallTimeMs)*100,reason:null,baselineId:baseline.id};
}

export function benchmarkHistory(history,baselineId) {
  return history.map(run=>{
    const baseline=baselineId?history.find(r=>r.id===baselineId):history.find(r=>compareBenchmarks(r,run).speedup!==null);
    return {...run,comparison:compareBenchmarks(baseline,run)};
  });
}
