# Borrowed Sky

A small, real browser rendering cloud for HackRPI’s **In the Clouds** theme. One Node coordinator distributes independent frames of a procedural pixel-art cloud animation to browser Web Workers. No dependencies and no build step.

## Run

Install Node.js 20+ on the **coordinator laptop only**, then:

```sh
node server.mjs
```

Open `http://127.0.0.1:3000` on that laptop. On other devices, open the **Same Wi-Fi** URL printed in the terminal (for example `http://192.168.1.12:3000`). Allow Node through the host’s firewall on the private network if prompted. Participants need only a modern browser. Override the port with the `PORT` environment variable.

Campus guest Wi-Fi may isolate clients. Use a shared hotspot or a reachable Node host if devices cannot connect. This server listens on all interfaces; only use it with trusted hackathon participants. Rooms and frames live in memory and are lost when the server restarts.

## Three-laptop demo

1. Host creates a room, notes its six-character code, and starts rendering.
2. Two other laptops open the same server address and join the room. Watch them claim different frames.
3. Close a contributor’s tab while its row has an assigned frame. For a hard-disconnect demo, turn off its Wi-Fi instead. Its work returns to the queue immediately on graceful leave, or after seven seconds without a heartbeat.
4. Watch the reassignment count and let the remaining laptops finish.
5. The host automatically collects all 120 frames, plays the six-second loop, and offers **Download GIF**.

Keep the host tab open for collection. Reloading a tab restores its session in the same browser tab. The **Pause my contribution** button finishes the current frame, then stops claiming new ones; it is not a disconnect simulation. Starting a new render resumes every connected device. Do not use duplicated tabs as evidence of multiple physical devices. Separate browsers can test coordination locally but share the same machine’s compute resources.

### Choose a sky

After creating a room, the host can choose **Sunny Sky** (the default),
**Sunset**, **Night Sky**, or **Stormy Sky** in the configuration panel.
The small previews are computed by the same procedural renderer in a Web Worker.
Start the render to lock the selection for all devices. Guests can see the choice
but cannot change it. After completion, choose another sky and render again.
Changing the next selection does not recolor the previous animation or its GIF.

Every job and collected result includes the server-owned theme alongside the
resolution, frame count and frame rate. The canvas and GIF use the same 256-color
theme palette. Missing themes default to Sunny Sky; unknown themes are rejected.

The original five-octave, 96-layer cloud noise field is retained. The animation's
closed drift path now uses basic arithmetic instead of engine-approximated
trigonometric functions. Stars use a fixed integer hash; storm lightning appears
only at frames 82 and 83 of the standard 120-frame loop. There is no time-based or
random input to frame generation. This preserves deterministic procedural
animation, but does not preserve the old renderer's exact pixel colors or path.

Theme tests compare repeated frames across independent worker threads and out-of-order
requests, check loop wrapping and lightning timing, verify GIF color tables, and
exercise shared configuration and host-only permissions. Physical multi-device
and different-browser-engine comparisons remain a separate venue check.


## Live distributed computing network

The room includes an interactive navy/cyan network map above the contributor dashboard. The center represents the Node.js coordinator; each laptop, including the host, has its own selectable node. Click or keyboard-select a node to inspect its current assignment and contribution. Disconnected devices remain visible in red. Paused devices are distinct from idle devices.

Blue signals represent real assignments, green signals represent accepted frame uploads, and amber return signals represent unfinished work requeued by the coordinator (not a successful upload). Frame numbers appear with transfers; completed frame cells briefly highlight. New joins and reconnects have a short appearance animation. The five totals show connected, rendering, idle, completed, and recovered assignments; repeated recoveries of one frame count separately, matching the existing recovery metric.

The existing room poll carries a bounded journal of the latest 128 server events with monotonic sequence IDs. This captures assignments and uploads that both occur between polls. Repeated claims, heartbeats, and rejected uploads never generate transfer events. The view deduplicates events, ignores stale snapshots and previous runs, and treats initial load as a baseline rather than replaying old work. A history gap is disclosed instead of reconstructing missing transfers. No credentials or lease tokens appear in the journal.

Animations are delayed representations of observed activity, not live packet tracing. At most 48 recent transfer effects are shown at once during bursts; accurate totals still include all accepted work. There is no continuous particle loop: animation frames run only while signals are moving, and effects stop when hidden, offscreen, disconnected from the coordinator, or reduced motion is requested. Large fleets and narrow screens can scroll the map. This adds no dependencies, background worker, or extra polling requests.

Verification includes server-event tests, browser-controller tests for deduplication and bounded animation, and two real browser sessions on one physical machine: 120 frames completed, a departing guest retained 42 accepted frames, one unfinished frame was recovered, and the host displayed the finished GIF download. Physical multi-laptop behavior remains unverified for this feature.

## Live Contributor Dashboard

The room now includes a navy-and-cyan dashboard with live totals, a contributor
table, and a leaderboard. It reuses the existing authenticated state poll
(approximately every 900 ms, plus request time). There are no new dependencies,
WebSockets, or build steps.

- **Connected:** devices whose heartbeat is within the existing 7-second timeout.
- **Completed:** accepted frames in the current render; duplicate, expired, and
  rejected uploads do not count.
- **Assigned:** frames with an active lease after the normal recovery sweep.
- **Remaining:** configured frame count minus completed frames, including assigned
  frames. Queued frames are remaining minus assigned.
- **Average frame time:** accepted worker durations divided by accepted frames for
  that device. This excludes queue/transfer time and is not CPU utilization.
  Devices with no accepted frames show a dash.
- **Frames per second:** accepted uploads in a rolling 5-second window divided by
  the window duration. During startup it uses elapsed run time (at least 1 ms).
  Network FPS counts all accepted uploads in that same window; it is not the
  animation playback FPS or an estimate of summed CPU capacity. It decays to zero
  within five seconds of the last accepted frame.
- **Work share:** device completed frames divided by total completed frames.
  Totals and device counters reset on a new render.
- **Leaderboard:** descending accepted frame count, with shared ranks for ties.
  All tied leaders are highlighted; no leader is declared before any work finishes.

Pause/resume is an authenticated per-device action at POST /api/pause with a
boolean paused field. A paused device cannot claim new frames; its current lease
can still finish and upload. The displayed activity is Disconnected if offline,
otherwise Rendering while assigned, Paused once its work finishes, or Idle.
Pause preferences survive reloads. Starting a new render resumes devices, matching the latest upstream behavior.
Disconnected devices remain listed with their earned work, and the existing
7-second heartbeat / 30-second lease recovery continues to requeue unfinished work.

The dashboard uses one server timestamp per snapshot, not separate client-side
metric estimates. Views may differ briefly because they poll at different times.
A lost connection visibly labels the last snapshot as stale.

### Test with multiple physical laptops

1. On the coordinator laptop, run node server.mjs and open http://127.0.0.1:3000.
   Create a room and note the code.
2. Put the other laptops on the same trusted Wi-Fi or hotspot. Open the coordinator's
   **Same Wi-Fi** URL printed by the server (not localhost), give each a distinct
   name, and join using the room code. If needed, allow Node on the coordinator's
   private-network firewall. Campus guest Wi-Fi may block device-to-device traffic.
3. Confirm all laptops show the same fleet and host/contributor roles. The host
   selects a theme and starts rendering. Watch assigned, completed, FPS, work share,
   progress, and leaderboard update without refreshes.
4. Pause one contributor. Its in-flight frame finishes, then all views show Paused,
   with zero assigned frames. Resume it and verify new assignments arrive.
5. Disconnect that laptop's Wi-Fi while it is rendering. Within about 7 seconds
   plus the next successful poll, other laptops should show it as Disconnected,
   retain its completed work, and recover its unfinished frame. Reconnect and
   verify the same browser session rejoins.
6. Finish the render: totals should reach 120 completed, zero remaining/assigned,
   and 100%. Recent FPS should settle to zero; the leaderboard keeps the results.
   Start another render to verify counters reset.

Automated verification: run node --test. Dashboard tests use an injected server
clock to cover rolling rates, shared snapshots, ties, pauses, permission checks,
heartbeat and lease recovery, duplicate rejection, reconnects, and run resets.
Browser verification used two real browser sessions on one physical machine:
120 frames completed, pause/resume appeared in both views, and the departing
contributor retained its credit. Desktop and 600px layouts were inspected.
Physical-laptop LAN connectivity still needs the venue check above.

### Implementation files

- server.mjs: shared snapshot integration, accepted-frame timestamps, pause endpoint,
  unique default device names, and static dashboard asset routes.
- lib/dashboard.mjs: pure per-device metrics, rolling rates, totals, and ranking.
- public/dashboard.js and public/dashboard.css: live dashboard rendering and
  responsive navy/cyan styling; device names are inserted as text.
- public/app.js: polling integration and server-backed pause/resume.
- public/index.html: dashboard placement and stylesheet; replaces the old fleet table.
- test/dashboard.test.mjs: new server-side regression tests.


## Architecture

- `server.mjs`: HTTP static server and in-memory room/job coordinator. Polling avoids WebSocket dependencies and works on ordinary LAN HTTP.
- `public/app.js`: room UI, ~900 ms heartbeat, single-frame claims, upload, progress, host collection.
- `public/worker.js` + `renderer.js`: actual deterministic CPU computation outside the UI thread. Each frame samples a layered 3D noise field; no server-side rendering or simulated progress.
- `public/gif.js`: browser GIF89a encoder with a shared 256-color palette and simple fixed-width LZW. All frames are assembled in frame-index order, regardless of completion order.

Each assignment has a unique lease token and render-run ID. Authenticated heartbeats extend its 30-second lease only when the device, frame index, run, and token match a still-valid assignment. Presence alone does not renew work. Disconnected jobs and expired leases are requeued; expired leases cannot be revived. Late or duplicate results receive HTTP 409. One outstanding frame per device limits recovery cost. The host also contributes. New devices can join mid-render. The host can render again after completion. Device status distinguishes Rendering (including finishing a frame while pausing), Idle, Paused, and Disconnected using server-side assignments and authenticated pause updates.

## Rendering configuration

Defaults remain 192×128 pixels, 120 frames, and 20 fps. Set `RENDER_CONFIG` to a JSON object before starting the coordinator to override dimensions, frame count, or fps. For example, in PowerShell:

```powershell
$env:RENDER_CONFIG = '{"width":320,"height":240,"count":120,"fps":20}'
node server.mjs
```

The preview, progress display, worker jobs, upload validation, and GIF dimensions follow this configuration. Dimensions must be integers from 1 to 2048, count from 1 to 600, and fps from 1 to 100, with at most 128 MiB of raw indexed pixels per render. Upload limits allow the exact base64 frame size plus 16 KiB of metadata, under an 8 MiB hard ceiling; other API requests are limited to 16 KiB. These are validation ceilings, not guarantees that a browser can comfortably assemble the largest allowed render. GIF frame timing is rounded to centiseconds.

## Honest performance measurements

The landing page eases scroll effects with refresh-synchronized transforms and stops updating when settled, offscreen, hidden, or inside a rendering room. Completed animation previews cache decoded pixel images and use elapsed-time playback synchronized to the display. The source animation and downloaded GIF remain 20 fps; these UI optimizations do not change the distributed workload or imply a rendering speedup.

**Wall time** runs from server render start until the last accepted upload. **Total Worker Render Time** is the sum of accepted worker render durations measured with `performance.now()`; it includes OS scheduling, excludes rejected/repeated computation, and is not actual CPU utilization. Device rows show accepted frame count, share of completed work, summed render time, and average time per accepted frame. Durations are reported by workers, not independently measured by the server. **Frame payload** counts raw accepted indexed pixels, excluding the roughly 33% base64 expansion, HTTP/polling overhead, rejected uploads, and final frame download. Browser GIF assembly happens after render wall time and is not included.

Compare one-laptop and three-laptop wall times using the same scene, machines, power settings, and network; repeat several runs. Do not label summed worker time divided by wall time as speedup. Small jobs, slow devices, background-tab throttling, coordination, and uploads can make the shared run slower. This MVP uses one worker per laptop and four procedural cloud environments. GIF encoding favors simplicity over compression (~3.2 MB at the default configuration).

Renderer profiling identified repeated noise/hash calculations as the main cost. The renderer now precomputes axis coordinates and shared lattice corner hashes per frame, retaining Float64 precision and the original interpolation order. Run `node scripts/profile-renderer.mjs` to compare the pre-optimization themed fixture and current implementation, verify sampled pixel hashes, and write timings to `output/renderer-profile.json`. Add `--cpu-prof --cpu-prof-dir=output` before the script path for a V8 CPU profile. The integration four-frame sample averaged about 355 ms before caching versus 115 ms optimized; this is a renderer microbenchmark, not a distributed speedup measurement.

## Verify

```sh
node --test
```

Tests cover distinct assignments, host permissions, authenticated lease renewal, expiry boundaries, graceful and heartbeat-based recovery, stale lease rejection, pause/resume and new-run resets, contribution statistics, malformed and oversized requests (including chunked uploads), larger configured frames, browser controller dimensions, completion, ordered collection, renderer equivalence, and GIF framing. Browser controller tests use a minimal DOM harness; they do not verify browser painting or physical devices.

The full-render test also computes all 120 frames using concurrent worker threads and writes `output/borrowed-sky.gif`. It uses the same renderer as the browser but is not a substitute for browser or physical-device testing.

Earlier implementation verification (before this reliability/performance pass): Windows decoded all 120 generated GIF frames; two browser clients joined the same render, the guest completed 27 frames before leaving, one unfinished frame was recovered, and the host reached 120/120 with a looping preview and a 3.2 MB download link. That browser run took 37.5 seconds, with 47.6 seconds of summed worker durations, on one physical machine. The upstream pass was verified with automated HTTP, controller-harness, renderer, and GIF tests. This integration also checked two real browser sessions at 320×240, 60 frames, and 12 fps with Sunset, pause/reload/resume, live metrics, and GIF assembly. It did not perform a physical multi-laptop test. These are functional checks, not a speedup benchmark. Multi-laptop LAN reachability remains to be checked at the venue.

## 24-hour scope and limitations

This is a trusted-network prototype: no accounts, persistent storage, host transfer, malicious-worker validation, or internet production hardening. A room code grants contribution access. Device actions require a private session token. Up to 32 device sessions per room and 100 rooms per server are allowed; restart the server to clear old rooms. A disconnected host’s frames are recovered, but its tab must return to collect the animation. Long frames can renew their leases, but background-tab throttling or network stalls exceeding the seven-second presence timeout still cause recovery. Refresh after a server restart and leave the old room to create a new one.

Suggested next steps after the demo works on three physical devices: adjustable workload, per-device throughput, measured one-device baseline, compressed binary transport, and persistent results. Avoid adding these before verifying the LAN demo.


## Compatibility with upstream 7ca2ee5

The themes and live dashboard are integrated on commit 7ca2ee522c43d884f66278d960b3c95380b430c3. Authenticated lease renewal, revision ordering, upload validation, configurable dimensions/count/fps, and new-run pause resets are preserved. The dashboard exposes workSharePercent for share of completed work while retaining upstream contributionPercent for share of the full animation. Explicit pause requests carry the run ID; ordinary heartbeats carry lease proofs and do not overwrite pause intent.

All 26 tests pass. The optimized themed renderer is checked pixel-for-pixel against a frozen pre-optimization themed fixture for all four environments, sampled full-size frames, and complete small loops. The original pre-theme fixture is retained for provenance. The theme feature intentionally changed the old palette and drift path; optimization must preserve the themed output, not revert it.

Browser integration check: two sessions completed a 320×240 Sunset render (60/60 frames), maintained accurate dashboard shares, restored a paused contributor after reload, resumed it, and generated borrowed-sky-sunset.gif with no captured browser console errors. These sessions share one physical machine.
# Performance benchmarking and analytics

The host's **Performance lab** records every completed render automatically. It shows the latest one-, two-, and three-device measurements, bar charts for the last eight runs, a full history table, baseline selection, and a JSON download. Empty configurations show no measured result. History is bounded to the most recent 50 runs **per room**, held in coordinator memory; it survives browser refreshes with the same host session, but not a coordinator restart. Export JSON before restarting. No database or new dependency is required.

Each record freezes the run ID, start/completion timestamps, complete rendering configuration (resolution, animation frame count, playback FPS, theme), renderer workload version, accepted frame count, participating browser identities, wall time, accepted worker time, raw payload bytes, average frame processing time, full-run throughput, and any confirmed test series. Only identities that supplied at least one accepted frame count as participating; this is not proof of distinct physical laptops. Rejected uploads and duplicate results never add credit or history. No frame buffers or authentication secrets are stored in history.

The existing definitions remain unchanged:

- **Wall time:** coordinator start to last accepted upload, including scheduling, coordination and transfer; excludes subsequent GIF assembly.
- **Worker time:** sum of accepted worker-measured render durations, including OS scheduling; excludes rejected/repeated work and is not CPU utilization.
- **Accepted frame payload:** raw indexed pixel bytes, excluding base64, HTTP, rejected uploads and the GIF.
- **Run frames/s:** accepted frame count divided by wall seconds; distinct from the live contributor dashboard's rolling five-second rate. Zero-duration runs show an unavailable rate.
- **Average frame time:** summed accepted worker duration divided by accepted frame count.

## Comparing multiple laptops

1. Start the coordinator with `npm start`. Create a room on the baseline laptop. Open the coordinator's printed Wi-Fi URL on additional laptops when needed; each uses its own browser session and joins the same room code.
2. Keep the same theme, dimensions, animation count, playback FPS, coordinator, network, power settings, browser settings and background load. Use the same warm-up policy. Enter a descriptive test series in Performance lab and confirm the conditions **before each measured run**.
3. Render with only the baseline laptop contributing. Then join a second laptop, confirm the same series/conditions, and render again; repeat with three. Starting a render resumes every joined device, so leave unused devices out. Keep the baseline session open so its identity remains the same. Repeat configurations to assess variability.
4. Select a single-device baseline, or retain the first eligible baseline per run. Speedup is **single-device wall time / multi-device wall time**. Time saved is **(1 - multi-device wall time / single-device wall time) × 100%**, which can be negative for a slowdown.
5. A speedup is shown only for identical full configurations and workload versions, positive wall durations, the same host-confirmed test series, inclusion of the baseline identity, and no recovered assignments in either run. Conditions are attested by the host, not independently verified. Ordinary runs still retain all measured metrics without a speedup claim. Comparing two tabs on one laptop is a functional test, not a physical multi-device benchmark.

History uses authenticated host-only `POST /api/benchmarks`, with optional `baselineId`; a start request can include `benchmark: {series, confirmed: true}`. This metadata is frozen at start and never changes frame assignment, heartbeat or recovery logic. Collection happens once on final accepted upload. Workload version lives in `lib/benchmarks.mjs` and must be bumped when the rendering algorithm or timed worker workload changes.

Run `node --test` to verify accepted-only metric collection, permissions, immutable history, bounded retention, workload/conditions comparison, correct speedup/slowdown calculations, and existing rendering/recovery behavior. UI implementation is in `public/benchmarks.js` and `public/benchmarks.css`, wired through `public/app.js` and `public/index.html`; server integration is in `server.mjs` and tests in `test/benchmarks.test.mjs`.

