import {isTheme,isDensity,isBackground} from './renderer.js';
export const DEFAULT_CONFIG = Object.freeze({width:192, height:128, count:120, fps:20, theme:'sunny',density:'medium',background:'original'});
export const RESOLUTIONS=Object.freeze([[192,128],[384,256],[576,384]]);
export const FRAME_COUNTS=Object.freeze([60,120,240]);
export const SPEEDS=Object.freeze([{fps:10,name:'Slow'},{fps:20,name:'Normal'},{fps:40,name:'Fast'}]);
export const CONFIG_KEYS=Object.keys(DEFAULT_CONFIG);
export const HARD_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const REQUEST_METADATA_BYTES = 16 * 1024;

export function validateConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid rendering configuration');
  const config = Object.fromEntries(CONFIG_KEYS.map(key=>[key,input[key]===undefined?DEFAULT_CONFIG[key]:input[key]]));
  for (const key of ['width','height','count','fps']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`Invalid ${key}`);
  }
  if (config.width > 2048 || config.height > 2048 || config.count > 600 || config.fps > 100 ||
      config.width * config.height * config.count > 128 * 1024 * 1024) {
    throw new Error('Rendering configuration exceeds supported limits');
  }
  if(!isTheme(config.theme))throw new Error('Unknown cloud theme');
  if(!isDensity(config.density))throw new Error('Unknown cloud density');
  if(!isBackground(config.background))throw new Error('Unknown background');
  return Object.freeze(config);
}

// Interactive edits use curated options; unchanged operator-supplied settings survive.
export function configureWorkload(current,patch){
  const next=validateConfig({...current,...patch});
  if((next.width!==current.width||next.height!==current.height)&&!RESOLUTIONS.some(([w,h])=>w===next.width&&h===next.height))throw new Error('Choose a supported resolution');
  if(next.count!==current.count&&!FRAME_COUNTS.includes(next.count))throw new Error('Choose 60, 120, or 240 frames');
  if(next.fps!==current.fps&&!SPEEDS.some(s=>s.fps===next.fps))throw new Error('Choose a supported playback speed');
  if(next.width*next.height*next.count>64*1024*1024)throw new Error('Workload exceeds the interactive 64 MiB pixel budget');
  return next;
}
export function workloadSummary(config){
 const pixels=config.width*config.height*config.count;
 return `${config.width} × ${config.height} · ${config.count} frames · ${config.fps} FPS · ${(config.count/config.fps).toFixed(1)}s loop · ${(pixels/(192*128*120)).toFixed(1)}× default pixel workload · ${(pixels/1024/1024).toFixed(1)} MiB indexed pixels`;
}

export function frameRequestLimit(config) {
  return 4 * Math.ceil(config.width * config.height / 3) + REQUEST_METADATA_BYTES;
}

