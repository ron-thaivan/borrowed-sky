import {getPalette} from './renderer.js';
// GIF89a with a global palette and deliberately simple, valid fixed-width LZW.
// Clear before the dictionary reaches 512 entries; favors portability over size.
export function encodeGif(frames,{width,height,fps,theme='sunny',background='original'}) {
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>65535||height>65535||!Number.isFinite(fps)||fps<1||fps>100)throw new Error('Invalid GIF configuration');
 if(!frames.length||frames.some(frame=>!(frame instanceof Uint8Array)||frame.length!==width*height))throw new Error('Invalid GIF frame dimensions');
 const palette=getPalette(theme,background);
 // Fixed-width LZW makes the exact output size predictable. Avoid a giant JS
 // number array (hundreds of MiB for the largest supported workload).
 const pixelsPerFrame=width*height;
 const dataSize=Math.ceil((pixelsPerFrame+Math.ceil(pixelsPerFrame/200)+1)*9/8);
 const total=801+frames.length*(20+dataSize+Math.ceil(dataSize/255));
 if(total>160*1024*1024)throw new Error('GIF exceeds the export memory budget');
 const bytes=new Uint8Array(total);let position=0;
 const put=(...a)=>{bytes.set(a,position);position+=a.length;},word=n=>put(n&255,n>>8),text=s=>{for(const c of s)put(c.charCodeAt(0));};
 text('GIF89a');word(width);word(height);put(247,0,0);for(const rgb of palette)put(...rgb);
 put(33,255,11);text('NETSCAPE2.0');put(3,1,0,0,0);
 for(const [index,pixels] of frames.entries()) {
  // Distribute fractional centiseconds so e.g. Fast (40 FPS) retains its timing.
  const delay=Math.round((index+1)*100/fps)-Math.round(index*100/fps);
  put(33,249,4,0);word(delay);put(0,0,44);word(0);word(0);word(width);word(height);put(0,8);
  const data=new Uint8Array(dataSize);let dataPosition=0,bits=0,buffer=0;const code=n=>{buffer|=n<<bits;bits+=9;while(bits>=8){data[dataPosition++]=buffer&255;buffer>>>=8;bits-=8;}};
  for(let offset=0;offset<pixels.length;offset+=200) {code(256);for(const p of pixels.subarray(offset,offset+200))code(p);}code(257);if(bits)data[dataPosition++]=buffer&255;
  for(let i=0;i<data.length;i+=255){const block=data.subarray(i,i+255);put(block.length);bytes.set(block,position);position+=block.length;}put(0);
 }put(59);return bytes;
}

