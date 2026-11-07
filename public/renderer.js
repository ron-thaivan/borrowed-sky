// Deterministic, CPU-computed cloud field. Every output frame is independent.
export const palette=Array.from({length:256},(_,i)=>{
 if(i<128) {const t=i/127;return [Math.round(19+68*t),Math.round(31+101*t),Math.round(67+112*t)];}
 const t=(i-128)/127; return [Math.round(104+151*t),Math.round(130+119*t),Math.round(164+77*t)];
});
function hash(x,y,z) {let n=Math.imul(x,374761393)^Math.imul(y,668265263)^Math.imul(z,2147483647);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295;}
const mix=(a,b,t)=>a+(b-a)*t;
function coordinate(value, origin) {
 const cell=Math.floor(value),fraction=value-cell;
 return {cell:cell-origin,blend:fraction*fraction*(3-2*fraction)};
}
function prepareOctave(width,height,octave,offsetX,offsetY) {
 const frequency=3*2**octave;
 const originX=Math.floor(offsetX),originY=Math.floor(offsetY),originZ=octave*7;
 const xs=Array.from({length:width},(_,x)=>coordinate(x/width*frequency+offsetX,originX));
 const ys=Array.from({length:height},(_,y)=>coordinate(y/height*frequency+offsetY,originY));
 const zs=Array.from({length:96},(_,layer)=>coordinate(layer*.19/8+octave*7,originZ));
 const row=xs.at(-1).cell+2,rows=ys.at(-1).cell+2,plane=row*rows,depth=zs.at(-1).cell+2;
 const values=new Float64Array(plane*depth);
 // Neighboring samples share lattice corners. Hash each corner once per frame,
 // rather than eight times for every pixel/depth/octave sample.
 for(let z=0;z<depth;z++)for(let y=0;y<rows;y++)for(let x=0;x<row;x++)values[z*plane+y*row+x]=hash(x+originX,y+originY,z+originZ);
 return {xs,ys,zs,row,plane,values,amplitude:.5*.5**octave};
}
function noise(field,x,y,layer) {
 const X=field.xs[x],Y=field.ys[y],Z=field.zs[layer],v=field.values;
 const a=Z.cell*field.plane+Y.cell*field.row+X.cell,b=a+field.row,c=a+field.plane,d=c+field.row;
 // Preserve the original interpolation order and Float64 precision exactly.
 return mix(mix(mix(v[a],v[a+1],X.blend),mix(v[b],v[b+1],X.blend),Y.blend),mix(mix(v[c],v[c+1],X.blend),mix(v[d],v[d+1],X.blend),Y.blend),Z.blend);
}
export function renderFrame({width,height,index,count}) {
 const out=new Uint8Array(width*height),angle=index/count*Math.PI*2;
 const offsetX=Math.cos(angle)*.65,offsetY=Math.sin(angle)*.65;
 const fields=Array.from({length:5},(_,octave)=>prepareOctave(width,height,octave,offsetX,offsetY));
 for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
  const u=x/width,v=y/height;let density=0,weight=0;
  // Layered volumetric sampling is the actual distributed workload.
  for(let layer=0;layer<96;layer++) {
   let sum=0;
   for(let octave=0;octave<5;octave++)sum+=fields[octave].amplitude*noise(fields[octave],x,y,layer);
   const d=Math.max(0,sum-.46)*2.7/8; density+=d*(1-weight);weight=Math.min(.95,weight+d*.22);
  }
  const horizon=Math.round(20+v*85),sun=(u-.77)**2+(v-.25)**2<.004;
  out[y*width+x]=density>.24?128+Math.min(127,Math.round(density*64+(1-v)*24)):sun?250:horizon;
 }
 return out;
}
