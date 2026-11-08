import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderFrame} from '../public/renderer.js';
import {encodeGif} from '../public/gif.js';

const source=await readFile(new URL('./fixtures/renderer-themed-original.txt',import.meta.url),'utf8');
const original=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('optimized renderer preserves every pixel of pre-optimization themed sampled defaults and full small loops',()=>{
 for(const theme of ['sunny','sunset','night','storm'])
 for(const [width,height,indices] of [[192,128,[0,22,60,119]],[17,11,Array.from({length:120},(_,i)=>i)],[1,1,[0,30,60,90]],[31,19,[13,49,82,111]]]){
  for(const index of indices){const config={width,height,count:120,index,theme};assert.deepEqual(renderFrame(config),original.renderFrame(config),`${width}x${height} frame ${index}`);}
 }
});
test('GIF dimensions and frame delays follow configuration',()=>{
 const config={width:320,height:240,fps:25};
 const gif=encodeGif([new Uint8Array(config.width*config.height)],config);
 assert.equal(gif[6]+gif[7]*256,320);assert.equal(gif[8]+gif[9]*256,240);
 // Header, global palette, then NETSCAPE loop extension precede graphics control.
 const gce=13+768+19;
 assert.deepEqual([...gif.slice(gce,gce+4)],[0x21,0xf9,4,0]);
 assert.equal(gif[gce+4]+gif[gce+5]*256,4);
 assert.throws(()=>encodeGif([new Uint8Array(1)],config));
 assert.throws(()=>encodeGif([],{...config,width:0}));
});

