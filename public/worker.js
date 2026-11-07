import {renderFrame} from './renderer.js';
self.onmessage=({data:job})=>{try {const start=performance.now();const pixels=renderFrame(job);self.postMessage({pixels,ms:performance.now()-start},[pixels.buffer]);}catch(e){self.postMessage({error:e.message});}};
