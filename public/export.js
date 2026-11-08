// Transfer ownership instead of cloning the full indexed animation twice.
export function encodeInWorker(frames,config,signal,makeWorker=()=>new Worker('/export-worker.js',{type:'module'})){
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(new Error('Export cancelled'));return;}
  let worker;
  const finish=(error,result)=>{signal.removeEventListener('abort',abort);worker?.terminate();error?reject(error):resolve(result);};
  const abort=()=>finish(new Error('Export cancelled'));
  try{
   worker=makeWorker();signal.addEventListener('abort',abort,{once:true});
   worker.onmessage=({data})=>finish(data.error?new Error(data.error):null,data);
   worker.onerror=event=>finish(new Error(event.message||'GIF worker failed'));
   worker.onmessageerror=()=>finish(new Error('Could not receive the GIF worker result'));
   worker.postMessage({frames,config},frames.map(frame=>frame.buffer));
  }catch(error){finish(error);}
 });
}
