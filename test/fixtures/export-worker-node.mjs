import {parentPort} from 'node:worker_threads';
if(parentPort){
 globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};
 await import('../../public/export-worker.js');
 parentPort.on('message',data=>self.onmessage({data}));
}
