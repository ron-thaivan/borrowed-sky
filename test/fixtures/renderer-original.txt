// Deterministic, CPU-computed cloud field. Every output frame is independent.
export const palette=Array.from({length:256},(_,i)=>{
 if(i<128) {const t=i/127;return [Math.round(19+68*t),Math.round(31+101*t),Math.round(67+112*t)];}
 const t=(i-128)/127; return [Math.round(104+151*t),Math.round(130+119*t),Math.round(164+77*t)];
});
function hash(x,y,z) {let n=Math.imul(x,374761393)^Math.imul(y,668265263)^Math.imul(z,2147483647);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295;}
const mix=(a,b,t)=>a+(b-a)*t;
function noise(x,y,z) {
 const X=Math.floor(x),Y=Math.floor(y),Z=Math.floor(z);x-=X;y-=Y;z-=Z;x=x*x*(3-2*x);y=y*y*(3-2*y);z=z*z*(3-2*z);
 return mix(mix(mix(hash(X,Y,Z),hash(X+1,Y,Z),x),mix(hash(X,Y+1,Z),hash(X+1,Y+1,Z),x),y),mix(mix(hash(X,Y,Z+1),hash(X+1,Y,Z+1),x),mix(hash(X,Y+1,Z+1),hash(X+1,Y+1,Z+1),x),y),z);
}
export function renderFrame({width,height,index,count}) {
 const out=new Uint8Array(width*height),angle=index/count*Math.PI*2;
 for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
  const u=x/width,v=y/height;let density=0,weight=0;
  // Layered volumetric sampling is the actual distributed workload.
  for(let layer=0;layer<96;layer++) {
   let sum=0,amp=.5,freq=3;
   for(let octave=0;octave<5;octave++) {sum+=amp*noise(u*freq+Math.cos(angle)*.65,v*freq+Math.sin(angle)*.65,layer*.19/8+octave*7);freq*=2;amp*=.5;}
   const d=Math.max(0,sum-.46)*2.7/8; density+=d*(1-weight);weight=Math.min(.95,weight+d*.22);
  }
  const horizon=Math.round(20+v*85),sun=(u-.77)**2+(v-.25)**2<.004;
  out[y*width+x]=density>.24?128+Math.min(127,Math.round(density*64+(1-v)*24)):sun?250:horizon;
 }
 return out;
}
