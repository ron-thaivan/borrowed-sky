// Consume observed server events once. A first view is a baseline, not a replay.
export function createNetworkTracker(){
 let code=null,revision=-1,cursor=0,run=null;
 return {
  reset(){code=null;revision=-1;cursor=0;run=null;},
  consume(s){
   if(code===s.code&&s.revision<=revision)return {stale:true,events:[]};
   const first=code!==s.code,changed=first||run!==s.run;
   const journal=s.network??{sequence:0,firstSequence:1,events:[]};
   const gap=!first&&cursor<journal.firstSequence-1;
   const events=first?[]:journal.events.filter(e=>e.sequence>cursor&&e.run===s.run);
   code=s.code;revision=s.revision;run=s.run;cursor=journal.sequence;
   return {events,changed,gap,first,stale:false};
  }
 };
}
export function networkStats(s){
 return {connected:s.devices.filter(d=>d.online).length,
  active:s.devices.filter(d=>d.online&&d.status==='Rendering').length,
  idle:s.devices.filter(d=>d.online&&d.status==='Idle').length,
  completed:s.completed,recovered:s.recovered};
}
// Stable two-column layout keeps labels readable even at the 32-device limit.
export function networkLayout(devices){
 const rows=Math.ceil(devices.length/2),height=Math.max(440,rows*112+112);
 const points=new Map(devices.map((d,i)=>[d.id,{x:i%2?810:190,y:height/2+(Math.floor(i/2)-(Math.ceil((devices.length-(i%2))/2)-1)/2)*112}]));
 return {height,center:{x:500,y:height/2},points};
}
