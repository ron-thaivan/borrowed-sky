// Preview timing only. Export always uses the completed session's configuration.
export function createPlayback({count,fps,onFrame,onState=()=>{},now=()=>performance.now(),request=requestAnimationFrame,cancel=cancelAnimationFrame}){
 let position=0,speed=1,loop=true,playing=false,visible=true,disposed=false,handle=null,anchor=now(),last=-1;
 const state=()=>({frame:Math.floor(position),speed,loop,playing});
 function notify(){const frame=Math.floor(position);if(frame!==last){last=frame;onFrame(frame);}onState(state());}
 function advance(time){
  if(playing&&visible){position+=Math.max(0,time-anchor)*fps*speed/1000;
   if(position>=count){if(loop)position%=count;else{position=count-1;playing=false;}}
  }anchor=time;
 }
 function unschedule(){if(handle!==null)cancel(handle);handle=null;}
 function schedule(){if(!disposed&&playing&&visible&&handle===null)handle=request(t=>{handle=null;if(disposed)return;advance(t);notify();schedule();});}
 const api={
  play(){if(disposed)return;if(!loop&&position>=count-1)position=0;anchor=now();playing=true;notify();schedule();},
  pause(){if(disposed)return;advance(now());playing=false;unschedule();notify();},
  restart(){if(disposed)return;position=0;last=-1;api.play();},
  seek(frame){if(disposed||!Number.isFinite(frame))return;playing=false;unschedule();position=Math.max(0,Math.min(count-1,Math.floor(frame)));anchor=now();notify();},
  setSpeed(value){if(disposed||![.5,1,1.5,2].includes(value))return;advance(now());speed=value;notify();schedule();},
  setLoop(value){if(disposed)return;advance(now());loop=!!value;notify();schedule();},
  setVisible(value){if(disposed)return;advance(now());visible=!!value;unschedule();notify();schedule();},
  dispose(){disposed=true;playing=false;unschedule();},
  state
 };notify();return api;
}
