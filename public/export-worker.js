import {encodeGif} from './gif.js';
self.onmessage=({data:{frames,config}})=>{
 try{
  const gif=encodeGif(frames,config);
  self.postMessage({frames,gif},[gif.buffer,...frames.map(f=>f.buffer)]);
 }catch(error){self.postMessage({error:error.message});}
};
