import {parentPort} from 'node:worker_threads';
import {renderFrame} from '../public/renderer.js';
parentPort?.on('message',job=>{const start=performance.now();const pixels=renderFrame(job);parentPort.postMessage({pixels,ms:performance.now()-start},[pixels.buffer]);});
