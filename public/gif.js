import {palette} from './renderer.js';
// GIF89a with a global palette and deliberately simple, valid fixed-width LZW.
// Clear before the dictionary reaches 512 entries; favors portability over size.
export function encodeGif(frames,{width,height,fps}) {
 const bytes=[]; const put=(...a)=>bytes.push(...a),word=n=>put(n&255,n>>8),text=s=>{for(const c of s)put(c.charCodeAt(0));};
 text('GIF89a');word(width);word(height);put(247,0,0);for(const rgb of palette)put(...rgb);
 put(33,255,11);text('NETSCAPE2.0');put(3,1,0,0,0);
 for(const pixels of frames) {
  put(33,249,4,0);word(Math.round(100/fps));put(0,0,44);word(0);word(0);word(width);word(height);put(0,8);
  const data=[];let bits=0,buffer=0;const code=n=>{buffer|=n<<bits;bits+=9;while(bits>=8){data.push(buffer&255);buffer>>>=8;bits-=8;}};
  for(let offset=0;offset<pixels.length;offset+=200) {code(256);for(const p of pixels.subarray(offset,offset+200))code(p);}code(257);if(bits)data.push(buffer&255);
  for(let i=0;i<data.length;i+=255){const block=data.slice(i,i+255);put(block.length,...block);}put(0);
 }put(59);return new Uint8Array(bytes);
}
