// Each frame is independent. No random state, clock, or platform-dependent trig.
export const themes=Object.freeze([
 {id:'sunny',name:'Sunny Sky',description:'Blue skies, soft white clouds, and a little sunshine.'},
 {id:'sunset',name:'Sunset',description:'Peach light and rose clouds beneath a violet sky.'},
 {id:'night',name:'Night Sky',description:'Quiet stars and silver clouds in the moonlight.'},
 {id:'storm',name:'Stormy Sky',description:'Heavy clouds and a brief, distant lightning bolt.'}
]);
export const isTheme=theme=>themes.some(t=>t.id===theme);
const mix=(a,b,t)=>a+(b-a)*t;
const ramps={
 sunny:{sky:[[38,115,209],[94,177,237],[177,222,250]],cloud:[[110,156,194],[241,248,252]],accent:[255,244,190]},
 sunset:{sky:[[61,36,103],[192,88,146],[255,177,104]],cloud:[[108,64,112],[255,211,169]],accent:[255,228,160]},
 night:{sky:[[10,15,40],[26,30,65],[63,63,99]],cloud:[[45,53,86],[169,188,216]],accent:[224,233,248]},
 storm:{sky:[[26,33,48],[58,70,84],[111,125,135]],cloud:[[24,30,42],[119,135,147]],accent:[229,236,255]}
};
function makePalette({sky,cloud,accent}) {
 return Array.from({length:256},(_,i)=>{
  if(i>=248)return accent.map(c=>Math.round(c*(.65+.35*(i-248)/7)));
  const t=i<128?i/127:(i-128)/119;
  const a=i<128?sky[t<.5?0:1]:cloud[0],b=i<128?sky[t<.5?1:2]:cloud[1];
  return a.map((c,k)=>Math.round(mix(c,b[k],i<128?(t<.5?t*2:(t-.5)*2):t)));
 });
}
const palettes=Object.fromEntries(Object.entries(ramps).map(([key,ramp])=>[key,makePalette(ramp)]));
export function getPalette(theme='sunny') {
 if(!isTheme(theme))throw new Error('Unknown cloud theme');
 return palettes[theme];
}
// Compatibility for callers that omit a theme.
export const palette=getPalette();
function hash(x,y,z) {let n=Math.imul(x,374761393)^Math.imul(y,668265263)^Math.imul(z,2147483647);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295;}
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
// Smooth closed drift path using specified IEEE-754 arithmetic.
// Math.sin/cos are implementation-approximated and can vary between engines.
function wave(t) {t=((t%1)+1)%1;const x=t*4;return x<2?x*(2-x):-(x-2)*(4-x);}
export function renderFrame({width,height,index,count,theme='sunny'}) {
 if(!isTheme(theme))throw new Error('Unknown cloud theme');
 const out=new Uint8Array(width*height),phase=((index%count)+count)%count/count;
 const driftX=wave(phase+.25)*.65,driftY=wave(phase)*.65;
 const fields=Array.from({length:5},(_,octave)=>prepareOctave(width,height,octave,driftX,driftY));
 const storm=theme==='storm',night=theme==='night',sunset=theme==='sunset';
 // One short bolt per loop; frame/config alone control timing and shape.
 const lightning=storm&&phase>=.68&&phase<.70;
 for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
  const u=x/width,v=y/height;let density=0,weight=0;
  // Retain the original layered volumetric noise workload.
  for(let layer=0;layer<96;layer++) {
   let sum=0;
   for(let octave=0;octave<5;octave++)sum+=fields[octave].amplitude*noise(fields[octave],x,y,layer);
   const d=Math.max(0,sum-(storm?.43:.46))*2.7/8; density+=d*(1-weight);weight=Math.min(.95,weight+d*.22);
  }
  let color=Math.round(12+v*110);
  const orbY=sunset?.72:.23,orbX=.77;
  const orb=(u-orbX)**2+(v-orbY)**2<(night?.0025:.004);
  if(!storm&&orb)color=255;
  if(night&&!orb&&v<.78) {
   const sx=Math.floor(u*96),sy=Math.floor(v*64);
   // Fixed sparse stars: no flicker or device-specific randomness.
   if(hash(sx,sy,91)>.991&&hash(sx,sy,12)>.3)color=249+Math.floor(hash(sx,sy,7)*6);
  }
  if(density>.24) {
   const light=storm?density*48+(1-v)*32:density*72+(1-v)*30;
   color=128+Math.min(119,Math.max(0,Math.round(light)));
  }
  if(lightning&&v>.24&&v<.84) {
   const segment=Math.floor(v*24),bend=(hash(segment,11,5)-.5)*.07;
   if(Math.abs(u-(.62+bend-(v-.24)*.12))<.006)color=255;
  }
  out[y*width+x]=color;
 }
 return out;
}

