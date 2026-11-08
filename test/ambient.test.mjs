import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createAmbientMotion} from '../public/ambient.js';
function setup(reduced=false,storage=null){
 const events={},root={dataset:{}},hero={},button={setAttribute(){}};
 const doc={documentElement:root,hidden:false,getElementById:()=>button,querySelector:()=>hero,addEventListener:(name,fn)=>events[name]=fn};
 const media={matches:reduced,addEventListener:(name,fn)=>events.preference=fn};
 class Observer{constructor(fn){events.intersection=fn;}observe(){}}
 const control=createAmbientMotion(doc,media,Observer,storage);
 return {events,root,hero,button,doc,media,control};
}
test('automatic motion pauses during rendering, while hidden and offscreen',()=>{
 const f=setup();assert.equal(f.root.dataset.decorativeMotion,'running');
 f.control.setRendering(true);assert.equal(f.root.dataset.decorativeMotion,'paused');
 f.control.setRendering(false);assert.equal(f.root.dataset.decorativeMotion,'running');
 f.doc.hidden=true;f.events.visibilitychange();assert.equal(f.root.dataset.decorativeMotion,'paused');
 f.doc.hidden=false;f.events.intersection([{target:f.hero,isIntersecting:false}]);assert.equal(f.root.dataset.decorativeMotion,'paused');
 f.events.intersection([{target:f.hero,isIntersecting:true}]);assert.equal(f.root.dataset.decorativeMotion,'running');
});
test('reduced motion and saved explicit choices survive reload',()=>{
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const f=setup(true,storage);assert.equal(f.root.dataset.decorativeMotion,'paused');
 f.button.onclick();assert.equal(setup(true,storage).root.dataset.decorativeMotion,'running');
 f.button.onclick();assert.equal(setup(false,storage).root.dataset.decorativeMotion,'paused');
});
test('preference changes and blocked storage remain safe',()=>{
 const f=setup(false,{getItem(){throw Error();},setItem(){throw Error();}});
 f.media.matches=true;f.events.preference();assert.equal(f.root.dataset.decorativeMotion,'paused');
 f.button.onclick();f.events.preference();assert.equal(f.root.dataset.decorativeMotion,'running');
 f.button.onclick();f.control.setRendering(true);f.control.setRendering(false);assert.equal(f.root.dataset.decorativeMotion,'paused');
});
test('cloud and panel animations are time-driven with no scroll transform',()=>{
 const css=fs.readFileSync(new URL('../public/platform.css',import.meta.url),'utf8');
 assert.match(css,/@keyframes sky-drift/);assert.match(css,/@keyframes panel-float/);assert.doesNotMatch(css,/--scroll-|--reveal-/);
});
