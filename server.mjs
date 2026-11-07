import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes, randomUUID} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import {pathToFileURL} from 'node:url';

export function createCoordinator({disconnectMs=7000, leaseMs=30000}={}) {
  const rooms=new Map();
  const fail=(message,status=400)=>Object.assign(new Error(message),{status});
  function sweep(room) {
    const now=Date.now();
    for(const d of room.devices.values()) d.online=now-d.seen<disconnectMs;
    for(const f of room.frames) if(f.state==='working' && (!room.devices.get(f.device)?.online || now>f.expires)) {
      f.state='queued'; f.device=null; f.token=null; room.recovered++;
    }
  }
  function snapshot(r) {
    sweep(r);
    return {code:r.code,host:r.host,run:r.run,started:r.started,finished:r.finished,recovered:r.recovered,
      config:r.config,devices:[...r.devices.values()].map(({id,name,online,computeMs,completed})=>({id,name,online,computeMs,completed})),
      frames:r.frames.map(({index,state,device})=>({index,state,device})),completed:r.frames.filter(f=>f.state==='done').length,
      computeMs:r.frames.reduce((n,f)=>n+(f.ms||0),0),uploadBytes:r.frames.reduce((n,f)=>n+(f.data?.length||0),0)};
  }
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      if(url.pathname.startsWith('/api/')) {
        if(req.method!=='POST') throw fail('Use POST',405);
        let body=''; for await(const chunk of req) { body+=chunk; if(body.length>100000) throw fail('Request too large',413); }
        const b=JSON.parse(body||'{}'); let result;
        if(url.pathname==='/api/create') {
          if(rooms.size>=100) throw fail('Server is full. Restart it to clear old rooms.',503);
          let code; do {code=randomBytes(3).toString('hex').toUpperCase();} while(rooms.has(code));
          const id=randomUUID(); const r={code,host:id,devices:new Map(),frames:[],run:null,started:null,finished:null,recovered:0,config:{width:192,height:128,count:120,fps:20}};
          r.devices.set(id,{id,secret:randomUUID(),name:String(b.name||'Host laptop').slice(0,40),seen:Date.now(),online:true,completed:0,computeMs:0}); rooms.set(code,r); result={id,secret:r.devices.get(id).secret,...snapshot(r)};
        } else {
          const r=rooms.get(String(b.code).toUpperCase()); if(!r) throw fail('Room not found. Check the six-character code.',404);
          if(url.pathname==='/api/join') {
            if(r.devices.size>=32) throw fail('Room is full');
            const id=randomUUID(); r.devices.set(id,{id,secret:randomUUID(),name:String(b.name||'Guest laptop').slice(0,40),seen:Date.now(),online:true,completed:0,computeMs:0}); result={id,secret:r.devices.get(id).secret,...snapshot(r)};
          } else {
            const d=r.devices.get(b.id); if(!d||d.secret!==b.secret) throw fail('Join this room first.',403);
            sweep(r); d.seen=Date.now(); d.online=true;
            switch(url.pathname) {
              case '/api/state': result=snapshot(r); break;
              case '/api/start':
                if(b.id!==r.host) throw fail('Only the host can start a render.',403);
                if(r.started&&!r.finished) throw fail('A render is already running.');
                r.run=randomUUID(); r.started=Date.now(); r.finished=null; r.recovered=0;
                for(const device of r.devices.values()) {device.completed=0; device.computeMs=0;}
                r.frames=Array.from({length:r.config.count},(_,index)=>({index,state:'queued'})); result=snapshot(r); break;
              case '/api/claim': {
                let f=r.frames.find(f=>f.state==='working'&&f.device===b.id);
                if(!f) { f=r.frames.find(f=>f.state==='queued'); if(f) Object.assign(f,{state:'working',device:b.id,token:randomUUID(),expires:Date.now()+leaseMs}); }
                result={job:f?{index:f.index,token:f.token,run:r.run,...r.config}:null}; break;
              }
              case '/api/result': {
                const f=r.frames[b.index];
                if(b.run!==r.run||!f||f.state!=='working'||f.device!==b.id||f.token!==b.token) throw fail('Lease expired; frame was reassigned.',409);
                if(typeof b.pixels!=='string'||!Number.isFinite(b.ms)||b.ms<0||b.ms>leaseMs) throw fail('Invalid frame');
                const data=Buffer.from(b.pixels,'base64'); if(data.length!==r.config.width*r.config.height) throw fail('Invalid frame size');
                Object.assign(f,{state:'done',data,ms:b.ms}); d.completed++; d.computeMs+=b.ms;
                if(r.frames.every(f=>f.state==='done')) r.finished=Date.now(); result={ok:true}; break;
              }
              case '/api/frames':
                if(b.id!==r.host) throw fail('Only the host can collect frames.',403);
                if(!r.finished) throw fail('Render is not complete.');
                result={config:r.config,run:r.run,frames:r.frames.map(f=>f.data.toString('base64'))}; break;
              case '/api/leave':
                d.seen=0; sweep(r); result={ok:true}; break;
              default: throw fail('Not found',404);
            }
          }
        }
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(result));
      } else {
        const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/renderer.js':'renderer.js','/worker.js':'worker.js','/gif.js':'gif.js'};
        const file=files[url.pathname]; if(!file) throw fail('Not found',404);
        const data=await readFile(new URL('./public/'+file,import.meta.url));
        res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-cache'});res.end(data);
      }
    } catch(e) {res.writeHead(e.status||400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
  });
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 const port=Number(process.env.PORT||3000); createCoordinator().listen(port,'0.0.0.0',()=>{
 console.log(`Borrowed Sky: http://localhost:${port}`);
 for(const entries of Object.values(networkInterfaces())) for(const a of entries||[]) if(a.family==='IPv4'&&!a.internal) console.log(`Same Wi-Fi: http://${a.address}:${port}`);
 });
}
