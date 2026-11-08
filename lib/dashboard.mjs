export const RATE_WINDOW_MS=5000;

// Called only after the coordinator's normal recovery sweep.
// All viewers receive one server-timestamped view of accepted work.
export function contributorSnapshot(room,now) {
 const completed=room.frames.filter(f=>f.state==='done').length;
 const assigned=room.frames.filter(f=>f.state==='working').length;
 const recent=room.recentCompletions.filter(e=>e.at>now-RATE_WINDOW_MS);
 // During startup use elapsed run time (minimum 1 ms), then a rolling 5 s.
 const windowMs=room.started===null?RATE_WINDOW_MS:Math.max(1,Math.min(RATE_WINDOW_MS,now-room.started));
 const devices=[...room.devices.values()].map(d=>{
  const active=room.frames.filter(f=>f.state==='working'&&f.device===d.id);
  return {
   id:d.id,name:d.name,role:d.id===room.host?'Host':'Contributor',
   online:d.online,paused:d.paused,lastSeen:d.seen,simulatedFailure:!!d.simulatedFailure,
   status:!d.online?'Disconnected':active.length?'Rendering':d.paused?'Paused':'Idle',
   assigned:active.length,assignedFrames:active.map(f=>f.index),
   completed:d.completed,computeMs:d.computeMs,
   averageFrameMs:d.completed?d.computeMs/d.completed:null,
   fps:recent.filter(e=>e.device===d.id).length*1000/windowMs,
   renderTimeMs:d.computeMs,uploadBytes:d.uploadBytes,assignedFrame:active[0]?.index??null,
   contributionPercent:d.completed/room.config.count*100,
   workSharePercent:completed?d.completed/completed*100:0
  };
 });
 const sorted=[...devices].sort((a,b)=>b.completed-a.completed||(a.id<b.id?-1:a.id>b.id?1:0));
 let rank=0,previous=-1;
 const leaderboard=sorted.map((d,i)=>{
  if(d.completed!==previous){rank=i+1;previous=d.completed;}
  return {id:d.id,rank,isLeader:d.completed>0&&d.completed===sorted[0].completed};
 });
 return {devices,dashboard:{
  updatedAt:now,rateWindowMs:RATE_WINDOW_MS,sampleDurationMs:windowMs,
  connected:devices.filter(d=>d.online).length,
  completed,remaining:room.config.count-completed,assigned,
  queued:room.config.count-completed-assigned,
  progressPercent:completed/room.config.count*100,
  fps:recent.length*1000/windowMs,leaderboard
 }};
}
