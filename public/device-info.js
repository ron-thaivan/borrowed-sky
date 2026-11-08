// Optional, low-entropy environment reports. Never use these for authentication,
// device deduplication, worker counts, or scheduling.
const ID_KEY='borrowed-sky-browser-id';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const systems=['Windows','macOS','Linux','Android','iOS','ChromeOS','Unknown'];
const browsers=['Chrome','Edge','Firefox','Safari','Opera','Chromium','Unknown'];
const fields=['browserId','logicalProcessors','memoryGiB','os','browser'];
const validCores=n=>Number.isInteger(n)&&n>=1&&n<=1024;
const validMemory=n=>Number.isFinite(n)&&n>=.25&&n<=1024&&Number.isInteger(Math.log2(n));
const safe=read=>{try{return read();}catch{return undefined;}};

export function validateDeviceInfo(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k)))throw new Error('Invalid device information');
 const result={browserId:input.browserId??null,logicalProcessors:input.logicalProcessors??null,memoryGiB:input.memoryGiB??null,os:input.os??'Unknown',browser:input.browser??'Unknown'};
 if(result.browserId!==null&&(typeof result.browserId!=='string'||!uuid.test(result.browserId)))throw new Error('Invalid browser identity');
 if(result.logicalProcessors!==null&&!validCores(result.logicalProcessors))throw new Error('Invalid logical processor count');
 if(result.memoryGiB!==null&&!validMemory(result.memoryGiB))throw new Error('Invalid approximate memory');
 if(!systems.includes(result.os)||!browsers.includes(result.browser))throw new Error('Invalid browser environment');
 if(result.browserId)result.browserId=result.browserId.toLowerCase();
 return Object.freeze(result);
}

function randomId(crypto){
 return safe(()=>{
  // getRandomValues works on ordinary LAN HTTP, unlike randomUUID in some browsers.
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const h=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
 })??null;
}

export function createDeviceReporter(env=globalThis){
 const storage=safe(()=>env.localStorage);
 let browserId=null;
 return ()=>{
  // Read again so tabs opened together converge on the stored random identity.
  const stored=safe(()=>storage?.getItem(ID_KEY));
  if(typeof stored==='string'&&uuid.test(stored))browserId=stored.toLowerCase();
  else if(!browserId){browserId=randomId(safe(()=>env.crypto));if(browserId)safe(()=>storage?.setItem(ID_KEY,browserId));}
  const nav=safe(()=>env.navigator),hints=safe(()=>nav?.userAgentData);
  const cores=safe(()=>nav?.hardwareConcurrency),memory=safe(()=>nav?.deviceMemory);
  // Only coarse labels leave this browser. No versions, hostnames or raw UA strings.
  const ua=String(safe(()=>nav?.userAgent)||'');
  const platform=String(safe(()=>hints?.platform)||safe(()=>nav?.platform)||'');
  let os='Unknown';
  if(/Android/i.test(platform+' '+ua))os='Android';
  else if(/iPhone|iPad|iPod|\biOS\b/i.test(platform+' '+ua))os='iOS';
  else if(/CrOS|Chrome OS/i.test(platform+' '+ua))os='ChromeOS';
  else if(/Win/i.test(platform))os='Windows';
  else if(/Mac/i.test(platform))os='macOS';
  else if(/Linux/i.test(platform))os='Linux';
  const brands=safe(()=>hints?.brands);
  const names=Array.isArray(brands)?brands.map(b=>typeof b?.brand==='string'?b.brand:'').join(' '):'';
  const browser=/Microsoft Edge|Edg(?:e|A|iOS)?\//.test(names+' '+ua)?'Edge':/Opera|OPR\//.test(names+' '+ua)?'Opera':/Firefox|FxiOS\//.test(ua)?'Firefox':/Google Chrome|Chrome\/|CriOS\//.test(names+' '+ua)?'Chrome':/Chromium/.test(names+' '+ua)?'Chromium':/Safari\//.test(ua)?'Safari':'Unknown';
  return {browserId,logicalProcessors:validCores(cores)?cores:null,memoryGiB:validMemory(memory)?memory:null,os,browser};
 };
}

export function deviceInfoLabels(info){
 if(!info)return {environment:'Not reported',hardware:'Not reported'};
 const environment=[info.browser||'Unknown',info.os||'Unknown'].join(' / ')+(info.browserLabel?' · '+info.browserLabel:'');
 const hardware=[info.logicalProcessors===null||info.logicalProcessors===undefined?'Processors unavailable':`${info.logicalProcessors} logical processors`,info.memoryGiB===null||info.memoryGiB===undefined?'RAM unavailable':`~${info.memoryGiB} GiB RAM`].join(' · ');
 return {environment,hardware};
}
