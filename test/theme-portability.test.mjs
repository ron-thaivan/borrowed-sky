import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {renderFrame,getPalette,themes} from '../public/renderer.js';
import {encodeGif} from '../public/gif.js';

// Fixed reference vectors, not expectations calculated by the implementation
// under test. Run this same suite on other devices/Node versions to detect drift.
const vectors=JSON.parse(await readFile(new URL('./fixtures/theme-vectors.json',import.meta.url),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('every theme matches fixed indexed and RGB reference hashes in isolated workers',async()=>{
 const worker=new Worker(new URL('./render-worker.mjs',import.meta.url));
 try{
  for(const {config,indexedSha256,rgbSha256} of [...vectors].reverse()){
   const pending=once(worker,'message');worker.postMessage(config);
   const {pixels}= (await pending)[0];
   assert.equal(hash(pixels),indexedSha256,JSON.stringify(config));
   const colors=getPalette(config.theme,config.background);
   assert.equal(hash(Uint8Array.from([...pixels].flatMap(i=>colors[i]))),rgbSha256);
   assert.equal(hash(renderFrame({...config,index:config.index-config.count})),indexedSha256,'negative wrapped frame');
  }
 }finally{await worker.terminate();}
});

// Decode the encoder's fixed-width literal LZW stream independently. This
// verifies actual procedural pixels survive export, not just the color table.
function decodeFrames(gif){
 let position=800;const frames=[];
 while(gif[position]!==59){
  assert.deepEqual([...gif.slice(position,position+4)],[33,249,4,0]);position+=8;
  assert.equal(gif[position],44);position+=10;
  assert.equal(gif[position++],8);
  const compressed=[];
  for(let size=gif[position++];size;size=gif[position++]){compressed.push(...gif.slice(position,position+size));position+=size;}
  const pixels=[];let bits=0,buffer=0,ended=false;
  for(const byte of compressed){buffer|=byte<<bits;bits+=8;while(bits>=9){const code=buffer&511;buffer>>>=9;bits-=9;if(code===257){ended=true;break;}if(code===256)continue;assert.ok(code<256);pixels.push(code);}if(ended)break;}
  assert.ok(ended);frames.push(Uint8Array.from(pixels));
 }
 assert.equal(position,gif.length-1);return frames;
}
test('themed GIFs retain every procedural pixel and background palette in frame order',()=>{
 for(const {id:theme} of themes)for(const background of ['original','soft','deep']){
  const config={width:31,height:19,count:120,fps:20,theme,background,density:'low'};
  const frames=[83,0,30].map(index=>renderFrame({...config,index}));
  const gif=encodeGif(frames,config),decoded=decodeFrames(gif);
  assert.deepEqual(decoded,frames,theme+' / '+background);
  assert.deepEqual(gif.slice(13,781),Uint8Array.from(getPalette(theme,background).flat()));
 }
});
