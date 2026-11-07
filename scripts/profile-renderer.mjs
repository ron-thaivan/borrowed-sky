import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const original = await readFile(new URL('../test/fixtures/renderer-original.txt', import.meta.url), 'utf8');
const baseline = await import('data:text/javascript;base64,' + Buffer.from(original).toString('base64'));
const current = await import('../public/renderer.js');
const config = {width:192, height:128, count:120};
const indices = [0, 22, 60, 119];
const results = {};
for (const [name, renderer] of [['baseline', baseline], ['current', current]]) {
  renderer.renderFrame({...config, index:0}); // Warm up the same workload.
  const times = [], hashes = [];
  for (const index of indices) {
    const start = performance.now();
    const pixels = renderer.renderFrame({...config, index});
    times.push(performance.now() - start);
    hashes.push(createHash('sha256').update(pixels).digest('hex'));
  }
  results[name] = {meanMs:times.reduce((a,b)=>a+b,0)/times.length, times, hashes};
}
if (JSON.stringify(results.baseline.hashes) !== JSON.stringify(results.current.hashes)) throw Error('Renderer output changed');
await mkdir(new URL('../output/', import.meta.url), {recursive:true});
await writeFile(new URL('../output/renderer-profile.json', import.meta.url), JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
