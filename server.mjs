import {benchmarkConditions,recordBenchmark,benchmarkHistory,HISTORY_LIMIT} from './lib/benchmarks.mjs';
import {contributorSnapshot,RATE_WINDOW_MS} from './lib/dashboard.mjs';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes, randomUUID} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import {pathToFileURL} from 'node:url';
import {validateConfig, configureWorkload, CONFIG_KEYS, frameRequestLimit, HARD_MAX_REQUEST_BYTES, REQUEST_METADATA_BYTES} from './public/config.js';

const fail = (message, status=400) => Object.assign(new Error(message), {status});

// Count bytes, not UTF-16 characters. Drain rejected streams without buffering them.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
      req.resume(); reject(fail('Request too large', 413)); return;
    }
    let size = 0, chunks = [], rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true; chunks = []; reject(fail('Request too large', 413));
      } else chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
    req.on('aborted', () => reject(fail('Request aborted')));
  });
}

export function createCoordinator({disconnectMs=7000, leaseMs=30000, config={}, maxRequestBytes=HARD_MAX_REQUEST_BYTES, now=Date.now}={}) {
  const renderingConfig = validateConfig(config);
  const uploadLimit = Math.max(frameRequestLimit(renderingConfig),frameRequestLimit({width:576,height:384}));
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < uploadLimit || maxRequestBytes > HARD_MAX_REQUEST_BYTES) {
    throw new Error('Request limit must accommodate configured frames and stay within 8 MiB');
  }
  if (!(disconnectMs > 0) || !(leaseMs > 0)) throw new Error('Timeouts must be positive');
  const rooms = new Map();
  // Bounded, public activity records: never expose device secrets or lease tokens.
  function activity(room,type,device,details={}) {
    room.events.push({sequence:++room.eventSequence,run:room.run,at:now(),type,device,...details});
    if(room.events.length>128)room.events.splice(0,room.events.length-128);
  }
  const newDevice = (id, name) => ({id, secret:randomUUID(), name:String(name||'').trim().slice(0,40)||'Device '+id.slice(0,6),
    seen:now(), online:true, paused:false, completed:0, computeMs:0, uploadBytes:0});
  function sweep(room,time=now()) {
    room.recentCompletions=room.recentCompletions.filter(e=>e.at>time-RATE_WINDOW_MS);
    for (const d of room.devices.values()) {
      const online=time-d.seen<disconnectMs;
      if(d.online&&!online)activity(room,'disconnected',d.id);
      d.online=online;
    }
    for (const f of room.frames) if (f.state === 'working' && (!room.devices.get(f.device)?.online || time >= f.expires)) {
      activity(room,'recovered',f.device,{index:f.index,reason:room.devices.get(f.device)?.online?'lease expired':'device disconnected'});
      f.state = 'queued'; f.device = null; f.token = null; room.recovered++;
    }
  }
  function assignment(room, device, proof) {
    if (!proof || !Number.isInteger(proof.index) || proof.run !== room.run || typeof proof.token !== 'string') return null;
    const frame = room.frames[proof.index];
    return frame?.state === 'working' && frame.device === device.id && frame.token === proof.token && now() < frame.expires ? frame : null;
  }
  function snapshot(r) {
    const sampledAt=now();sweep(r,sampledAt);
    return {code:r.code, host:r.host, run:r.run, revision:++r.revision, started:r.started, finished:r.finished,
      recovered:r.recovered, config:r.config,
      network:{sequence:r.eventSequence,firstSequence:r.events[0]?.sequence??r.eventSequence+1,events:r.events},
      selectedTheme:r.selectedConfig.theme,selectedConfig:r.selectedConfig,...contributorSnapshot(r,sampledAt),
      frames:r.frames.map(({index,state,device}) => ({index,state,device})),
      completed:r.frames.filter(f => f.state === 'done').length,
      computeMs:r.frames.reduce((n,f) => n+(f.ms||0), 0),
      uploadBytes:r.frames.reduce((n,f) => n+(f.data?.length||0), 0)};
  }
  const server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'POST') throw fail('Use POST',405);
        const limit = url.pathname === '/api/result' ? Math.min(uploadLimit,maxRequestBytes) : REQUEST_METADATA_BYTES;
        const body=await readBody(req,limit);
        const b = JSON.parse(body || '{}');
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail('Expected a JSON object');
        let result;
        if (url.pathname === '/api/create') {
          if (rooms.size >= 100) throw fail('Server is full. Restart it to clear old rooms.',503);
          let code; do {code=randomBytes(3).toString('hex').toUpperCase();} while (rooms.has(code));
          const id = randomUUID();
          const r = {code,host:id,devices:new Map(),frames:[],events:[],eventSequence:0,recentCompletions:[],selectedConfig:renderingConfig,run:null,revision:0,started:null,finished:null,recovered:0,config:renderingConfig};
          r.benchmarks=[];r.benchmarkConditions=null;
          r.devices.set(id,newDevice(id,b.name || 'Host laptop')); rooms.set(code,r);
          activity(r,'joined',id);
          result = {id,secret:r.devices.get(id).secret,...snapshot(r)};
        } else {
          const r = rooms.get(String(b.code).toUpperCase());
          if (!r) throw fail('Room not found. Check the six-character code.',404);
          if (url.pathname === '/api/join') {
            if (r.devices.size >= 32) throw fail('Room is full');
            const id = randomUUID(); r.devices.set(id,newDevice(id,b.name));
            activity(r,'joined',id);
            result = {id,secret:r.devices.get(id).secret,...snapshot(r)};
          } else {
            const d = r.devices.get(b.id);
            if (!d || d.secret !== b.secret) throw fail('Join this room first.',403);
            // Sweep BEFORE refreshing presence or renewing: expired leases cannot be revived.
            sweep(r);if(!d.online)activity(r,'reconnected',d.id);d.seen=now(); d.online=true;
            switch (url.pathname) {
              case '/api/benchmarks':
                if(b.id!==r.host) throw fail('Only the host can view benchmark history.',403);
                if(b.baselineId!=null&&!r.benchmarks.some(run=>run.id===b.baselineId)) throw fail('Baseline is no longer available.');
                result={runs:benchmarkHistory(r.benchmarks,b.baselineId),limit:HISTORY_LIMIT};break;
              case '/api/state': {
                if (b.paused !== undefined && typeof b.paused !== 'boolean') throw fail('Invalid pause state');
                // A delayed heartbeat from an old run must not pause a new run.
                if (b.run === r.run && typeof b.paused === 'boolean') d.paused=b.paused;
                let leaseRenewed = false;
                if (b.assignment !== undefined) {
                  const frame = assignment(r,d,b.assignment);
                  if (frame) {frame.expires=now()+leaseMs; leaseRenewed=true;}
                }
                result = {...snapshot(r),leaseRenewed}; break;
              }
              case '/api/pause':
                if(typeof b.paused!=='boolean') throw fail('paused must be a boolean');
                if(b.run!==undefined&&b.run!==r.run) throw fail('Render run changed.',409);
                d.paused=b.paused;result=snapshot(r);break;
              case '/api/configure':
                if(b.id!==r.host) throw fail('Only the host can change rendering settings.',403);
                if(r.started!==null&&r.finished===null) throw fail('Wait for the active render to finish.',409);
                const patch=Object.fromEntries(CONFIG_KEYS.filter(key=>Object.hasOwn(b,key)).map(key=>[key,b[key]]));
                r.selectedConfig=configureWorkload(r.selectedConfig,patch);result=snapshot(r);break;
              case '/api/start':
                if (b.id !== r.host) throw fail('Only the host can start a render.',403);
                if (r.started !== null && r.finished === null) throw fail('A render is already running.');
                r.benchmarkConditions=benchmarkConditions(b.benchmark);
                r.config=Object.freeze({...r.selectedConfig});r.recentCompletions=[];
                r.run=randomUUID(); r.started=now(); r.finished=null; r.recovered=0;
                for (const device of r.devices.values()) {device.completed=0; device.computeMs=0; device.uploadBytes=0; device.paused=false;}
                r.frames=Array.from({length:r.config.count},(_,index) => ({index,state:'queued'}));
                result=snapshot(r); break;
              case '/api/claim': {
                if (b.run != null && b.run !== r.run) throw fail('Render run changed.',409);
                let f=r.frames.find(f => f.state === 'working' && f.device === b.id);
                if (!f && !d.paused) {
                  f=r.frames.find(f => f.state === 'queued');
                  if (f) {
                    Object.assign(f,{state:'working',device:b.id,token:randomUUID(),expires:now()+leaseMs,attempts:(f.attempts||0)+1});
                    activity(r,'assigned',d.id,{index:f.index,reassigned:f.attempts>1});
                  }
                }
                result={job:f ? {index:f.index,token:f.token,run:r.run,...r.config} : null}; break;
              }
              case '/api/result': {
                const f=assignment(r,d,b);
                if (!f) throw fail('Lease expired; frame was reassigned.',409);
                if(Buffer.byteLength(body)>frameRequestLimit(r.config))throw fail('Request too large',413);
                const pixelCount=r.config.width*r.config.height;
                if (typeof b.pixels !== 'string' || b.pixels.length !== 4*Math.ceil(pixelCount/3) ||
                    !/^[A-Za-z0-9+/]*={0,2}$/.test(b.pixels) || !Number.isFinite(b.ms) || b.ms < 0 || b.ms > Number.MAX_SAFE_INTEGER) throw fail('Invalid frame');
                const data=Buffer.from(b.pixels,'base64');
                if (data.length !== pixelCount || data.toString('base64') !== b.pixels) throw fail('Invalid frame size or encoding');
                Object.assign(f,{state:'done',data,ms:b.ms}); d.completed++; d.computeMs+=b.ms; d.uploadBytes+=data.length;
                activity(r,'completed',d.id,{index:f.index});
                r.recentCompletions.push({device:d.id,at:now()});
                if (r.frames.every(f => f.state === 'done')) {
                  r.finished=now();r.benchmarks.push(recordBenchmark(r));
                  if(r.benchmarks.length>HISTORY_LIMIT)r.benchmarks.shift();
                }
                result={ok:true}; break;
              }
              case '/api/frames':
                if (b.id !== r.host) throw fail('Only the host can collect frames.',403);
                if (r.finished === null) throw fail('Render is not complete.');
                result={config:r.config,run:r.run,frames:r.frames.map(f => f.data.toString('base64'))}; break;
              case '/api/leave':
                d.seen=-Infinity; sweep(r); result={ok:true}; break;
              default: throw fail('Not found',404);
            }
          }
        }
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));
      } else {
        const files={'/network.js':'network.js','/network-state.js':'network-state.js','/network.css':'network.css','/dashboard.js':'dashboard.js','/dashboard.css':'dashboard.css','/themes.css':'themes.css','/':'index.html','/app.js':'app.js','/config.js':'config.js','/style.css':'style.css','/type-motion.css':'type-motion.css','/motion.js':'motion.js','/sky.svg':'sky.svg','/renderer.js':'renderer.js','/worker.js':'worker.js','/gif.js':'gif.js'};
        files['/benchmarks.js']='benchmarks.js';files['/benchmarks.css']='benchmarks.css';
        const file=files[url.pathname]; if (!file) throw fail('Not found',404);
        const data=await readFile(new URL('./public/'+file,import.meta.url));
        res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html','Cache-Control':'no-cache'});res.end(data);
      }
    } catch (e) {
      res.writeHead(e.status||400,{'Content-Type':'application/json',...(e.status===413?{'Connection':'close'}:{})});
      res.end(JSON.stringify({error:e.message}));
    }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port=Number(process.env.PORT||3000);
  const config=JSON.parse(process.env.RENDER_CONFIG||'{}');
  createCoordinator({config}).listen(port,'0.0.0.0',() => {
    console.log(`Borrowed Sky: http://localhost:${port}`);
    for (const entries of Object.values(networkInterfaces())) for (const a of entries||[]) if (a.family==='IPv4'&&!a.internal) console.log(`Same Wi-Fi: http://${a.address}:${port}`);
  });
}

