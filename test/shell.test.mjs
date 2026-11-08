import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function fixture(){
 const elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',dataset:{},hidden:false});return elements.get(id);};
 const source=readFileSync(new URL('../public/shell.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').replaceAll('export function','function');
 const context=vm.createContext({document:{getElementById:element},themes:[{id:'sunny',name:'Sunny Sky'},{id:'night',name:'Night Sky'}]});
 vm.runInContext(source,context);
 const config={width:192,height:128,count:120,fps:20,theme:'sunny'};
 const state={code:'ABC123',host:'host',started:null,finished:null,config,selectedConfig:{...config,count:60,theme:'night'},completed:0,devices:[{id:'host',online:true,status:'Idle'},{id:'guest',online:false,status:'Disconnected'}],dashboard:{fps:0}};
 return {element,state,context};
}

test('workspace uses selected settings before start and frozen run settings while rendering',()=>{
 const {element:e,state:s,context:c}=fixture();
 c.updateShell(s,{id:'host'});
 assert.equal(e('overview-remaining').textContent,'60');
 assert.match(e('active-config').textContent,/Night Sky/);
 assert.equal(e('overview-devices').textContent,'1');
 s.started=100;s.completed=12;s.devices[0].status='Rendering';s.dashboard.fps=2.4;
 c.updateShell(s,{id:'host'},{paused:true});
 assert.equal(e('overview-remaining').textContent,'108');
 assert.match(e('active-config').textContent,/Sunny Sky/);
 assert.match(e('session-summary').textContent,/your contribution is paused/);
 assert.equal(e('host-start').disabled,true);
 assert.equal(e('host-pause').textContent,'Resume my contribution');
});

test('contributors cannot see host controls, analytics, or host result links',()=>{
 const {element:e,state:s,context:c}=fixture();
 c.updateShell(s,{id:'guest'},{resultReady:true});
 for(const id of ['host-controls','host-start','host-pause','nav-analytics','nav-result','view-result'])assert.equal(e(id).hidden,true,id);
 assert.equal(e('header-role').textContent,'Contributor');
 s.started=100;s.devices[1].simulatedFailure=true;
 c.updateShell(s,{id:'guest'});
 assert.equal(e('host-controls').hidden,false);
 assert.equal(e('host-control-summary').hidden,true);
 assert.match(e('session-summary').textContent,/host can restore/);
});

test('host can reach export preparation and retry before the GIF is ready',()=>{
 const {element:e,state:s,context:c}=fixture();
 c.updateShell(s,{id:'host'});assert.equal(e('nav-result').hidden,true);
 s.started=100;s.finished=200;s.completed=120;
 c.updateShell(s,{id:'host'});
 assert.equal(e('nav-result').hidden,false);assert.equal(e('view-result').hidden,false);
 assert.equal(e('view-result').textContent,'Open export status →');
 assert.match(e('session-summary').textContent,/retry/);
 c.updateShell(s,{id:'host'},{resultReady:true,pending:true});
 assert.equal(e('view-result').textContent,'Open animation viewer →');
 assert.equal(e('nav-result').hidden,false);
 assert.equal(e('overview').dataset.phase,'complete');
 assert.equal(e('overview-remaining').textContent,'0');
 assert.equal(e('host-start').disabled,true);
 assert.equal(e('host-start').textContent,'Starting…');
 c.updateShell(s,{id:'guest'});assert.equal(e('nav-result').hidden,true);assert.equal(e('view-result').hidden,true);
});

test('connection recovery and room navigation have explicit states',()=>{
 const {element:e,context:c}=fixture();
 c.sessionShell(true);
 assert.equal(e('connection').dataset.connected,'pending');
 assert.equal(e('brand-home').href,'#overview');
 c.shellConnection(false,true);
 assert.equal(e('connection').textContent,'Room unavailable');
 assert.equal(e('session-recover').hidden,false);
 c.shellConnection(true);
 assert.equal(e('session-recover').hidden,true);
 c.sessionShell(false);
 assert.equal(e('session-header').hidden,true);
 assert.equal(e('skip-workspace').href,'#studio');
});
