import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlayback} from '../public/playback.js';

function fixture(count=10,fps=10){
 let time=0,id=0;const callbacks=new Map(),frames=[];
 const player=createPlayback({count,fps,now:()=>time,request:fn=>{callbacks.set(++id,fn);return id;},cancel:id=>callbacks.delete(id),onFrame:frame=>frames.push(frame)});
 return {player,frames,callbacks,at(value){time=value;const pending=[...callbacks.values()];callbacks.clear();pending.forEach(fn=>fn(time));}};
}
test('play, pause, resume and restart use elapsed time without duplicate animation loops',()=>{
 const f=fixture();f.player.play();f.player.play();assert.equal(f.callbacks.size,1);
 f.at(250);assert.equal(f.player.state().frame,2);
 f.player.pause();assert.equal(f.callbacks.size,0);f.at(1250);assert.equal(f.player.state().frame,2);
 f.player.play();f.at(1400);assert.equal(f.player.state().frame,4);
 f.player.restart();assert.equal(f.player.state().frame,0);assert.equal(f.callbacks.size,1);
});
test('all playback speeds preserve progress and looping can stop on the final frame',()=>{
 for(const speed of [.5,1,1.5,2]){const f=fixture(100);f.player.setSpeed(speed);f.player.play();f.at(1000);assert.equal(f.player.state().frame,10*speed);}
 const f=fixture();f.player.play();f.at(200);f.player.setSpeed(2);f.at(400);assert.equal(f.player.state().frame,6);
 f.at(650);assert.equal(f.player.state().frame,1);
 f.player.setLoop(false);f.at(1150);assert.equal(f.player.state().frame,9);assert.equal(f.player.state().playing,false);assert.equal(f.callbacks.size,0);
 f.player.play();assert.equal(f.player.state().frame,0);
});
test('scrubbing pauses and clamps, hidden tabs suspend, disposal prevents stale callbacks',()=>{
 const f=fixture();f.player.play();f.at(200);f.player.seek(7);assert.equal(f.player.state().frame,7);assert.equal(f.callbacks.size,0);
 f.player.seek(-5);assert.equal(f.player.state().frame,0);f.player.seek(999);assert.equal(f.player.state().frame,9);
 f.player.seek(0);f.player.play();f.at(300);f.player.setVisible(false);f.at(10000);assert.equal(f.player.state().frame,1);
 f.player.setVisible(true);f.at(10100);assert.equal(f.player.state().frame,2);
 const stale=[...f.callbacks.values()][0];f.player.dispose();stale(11000);assert.equal(f.callbacks.size,0);assert.equal(f.player.state().frame,2);
 f.player.play();f.player.seek(4);assert.equal(f.callbacks.size,0);assert.equal(f.player.state().frame,2);
});
