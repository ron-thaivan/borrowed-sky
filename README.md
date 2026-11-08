# Borrowed Sky

Borrowed Sky distributes procedural pixel-art cloud rendering across browsers on a shared network. A Node.js coordinator assigns independent frames, accepts authenticated results and recovers unfinished assignments. The host collects the ordered frames and exports a looping GIF.

There is no build step, database, external font service or runtime package dependency. This is a trusted-network demonstration, not a production compute service.

## Start

The application retains Node.js 20+ compatibility. For a supported runtime, install Node.js 22 or 24 LTS (see the [official release status](https://nodejs.org/en/about/previous-releases)), then run from the repository root:

```sh
npm start
```

Open `http://localhost:3000` on the coordinator laptop. No `npm install` is needed because `package.json` has no dependencies. Check installed versions with `node --version` and `npm --version`.

To use another port in PowerShell:

```powershell
$env:PORT = '3004'
npm start
```

In macOS/Linux shells, use `PORT=3004 npm start`. To stop the coordinator, press Ctrl+C. Restarting clears rooms, completed frames and benchmark history. Return to room setup and create a new room after a restart.

### Connect additional laptops

1. Connect every laptop to the same Wi-Fi network. Keep the coordinator awake and plugged in.
2. The coordinator prints a `Same Wi-Fi` address, for example `http://192.168.1.20:3000`. Use the address actually printed on your machine. Multiple adapters may produce multiple addresses; choose the active Wi-Fi adapter.
3. Open that LAN address on each contributor laptop. `localhost` and `127.0.0.1` refer to the laptop using them, so they cannot reach a different laptop's coordinator.
4. Create a room on the host, name each device and join using the six-character code. Copy room invite works directly from a LAN URL. From localhost it explains how to share the LAN address instead.
5. Keep contributor tabs open. Recent Chrome or Edge is the recommended rehearsal target; the app needs ES modules, module Web Workers, canvas, fetch and modern AbortSignal support.

If another laptop cannot connect, first verify the address and port, the same Wi-Fi network and that the server is running. Check the operating system's private-network firewall permission for Node.js and whether guest Wi-Fi/client isolation prevents peer connections. VPNs and multiple network adapters can select the wrong route. Do not disable the firewall wholesale. A phone hotspot or venue-approved local network can be a fallback, but must be tested beforehand.

## Features and workflow

- **Workspace:** persistent room/role/connection indicators, section navigation, progress, frame map and current settings. The layout adapts to narrow windows; metric tables scroll horizontally. Network effects honor reduced motion and stop offscreen.
- **Procedural environments:** Sunny Sky (default), Sunset, Night Sky and Stormy Sky. Clouds, stars and storm lightning depend on frame/configuration, not randomness or wall clocks. Fixed reference fixtures protect indexed pixels and palettes.
- **Shared settings:** resolutions 192 × 128, 384 × 256 and 576 × 384; 60, 120 or 240 frames; low/medium/high cloud density; 10/20/40 playback FPS; three backgrounds for each theme. Starting freezes the configuration for every assignment and export. Changing playback FPS changes animation timing, not the number of pixels computed.
- **Contributor dashboard:** device identity and role, connection/activity, accepted and assigned frames, average render duration, rolling throughput, share of completed work and a ranked leaderboard. Ties share rank. Disconnected devices retain their accepted-work credit.
- **Network view:** the coordinator and real device nodes, assignment/acceptance/recovery events, an inspector and a bounded recent event list. Signals reflect server events observed through polling, not instantaneous network traffic.
- **Performance lab:** actual completed-run history, one/two/three-device cards, charts, baseline selection and JSON export. It never fills empty configurations with example results.
- **Final animation:** ordered frame collection, background GIF encoding, play/pause/restart, loop toggle, 0.5×/1×/1.5×/2× preview speeds, frame navigation, frozen run statistics and GIF download. Preview controls do not change the exported GIF's timing or infinite loop. Export failures offer explicit retry. The host can open export status as soon as rendering finishes, see actual collected-frame progress and an indeterminate encoding state, and reach retry even before a GIF is ready.
- **Consecutive runs:** the host can choose new settings and start again in the same room. Starting resets progress, pause/simulation state and device run metrics; old previews and download URLs are discarded.

### Permissions and lifecycle

The host can configure/start renders, collect/export frames, view benchmark history, simulate failure and restore simulated workers. Contributors can join, claim/render/upload their assignments, pause/resume themselves and leave. The host also contributes CPU. **Pause my contribution affects only that browser** and finishes an already assigned frame; it does not pause the whole network.

The coordinator enforces host identity and a private session token on authenticated endpoints. Assignment proofs include the run, frame and lease token. The room code lets someone join; it does not confer host authority. Keep this on a trusted network: there are no user accounts, encryption, malicious-worker validation or rate limiting.

Credentials survive refresh in session storage for that tab. Keep the original host tab available: a new tab joining with the code is a contributor, not a replacement host. There is no host transfer. If the host browser disconnects while the Node process remains running, other devices can finish and the same host session can return to collect the result. If the coordinator process or its network disappears, rendering cannot complete until it is reachable; a process restart loses all room state.

### Recovery and failure demonstration

Browsers poll about every 900 ms. After seven seconds without authenticated activity, a device becomes disconnected and its unfinished work is requeued on the next coordinator request. Assignments also have 30-second leases; only a matching current assignment proof renews one. The coordinator sweeps before refreshing presence, so expired proofs cannot revive old assignments. Late/duplicate/stale uploads are rejected and never receive credit.

To demonstrate recovery, start a render with another contributor, open Host controls, choose a contributor with an active frame and select **Fail selected worker**. The host cannot be selected. This uses the same server requeue path as a real disconnect; it does not shut off Wi-Fi. A paused or idle contributor may have nothing to recover, and the UI says so. Reset simulation restores eligibility when the device is connected; revoked leases remain invalid. A new run clears simulations.

## Benchmark measurements

| Measurement | Definition |
| --- | --- |
| Rendering wall time | Coordinator start to last accepted upload; includes scheduling and transfer, excludes GIF collection/encoding. Live displays use the coordinator timestamp rather than the viewer's clock. |
| Summed worker rendering time | Sum of accepted per-frame `performance.now()` durations reported by workers. Includes OS scheduling; excludes rejected/duplicated work. Not CPU utilization. |
| Average frame time | Summed accepted worker duration divided by accepted frame count. |
| Run frames/s | Accepted frame count divided by wall seconds. |
| Live network/device frames/s | Accepted completions in a rolling five-second window, using elapsed run time during startup. Falls to zero when work stops. |
| Accepted frame payload | Raw indexed pixel bytes only; excludes base64, HTTP/polling, retries, collection and GIF bytes. |
| Participating devices | Browser identities that delivered at least one accepted frame. This does not prove separate physical laptops. |

Speedup is **single-device wall time / multi-device wall time**. Time reduction is **(1 − multi-device wall time / single-device wall time) × 100%**; it can be negative. Summed worker time divided by wall time is never used as speedup.

Expand **Set up a comparable benchmark** before a measured run. Enter a test series and attest consistent coordinator, network, power/browser settings, background load and warm-up policy. A comparison requires the same complete configuration and renderer workload version, the same confirmed series, positive wall durations, the baseline identity in the multi-device run and no recovered assignments. Conditions are host-attested, not automatically verified. Unconfirmed runs still record real measurements without a speedup claim. Device-count cards can contain different workloads; chart bars alone do not establish comparability.

Measure a baseline with only one connected contributing laptop, then add a second and third and repeat the identical workload. Starting resumes all joined devices, so leave unused ones out. Repeat trials and report variability. Two tabs on one machine are useful functional tests, not a distributed performance benchmark.

History retains the latest 50 completed runs per room in memory. Download measurements JSON before restarting. History contains frozen settings/metrics, not frame buffers or private tokens.

## Performance and memory limits

The largest UI preset (576 × 384 × 240) contains **53,084,160 indexed bytes (50.625 MiB)**. Base64 upload and collection each represent about **67.5 MiB** before HTTP and JSON overhead. The fixed-width GIF encoder produces approximately **57.47 MiB** for this workload regardless of image compressibility. This is an 18× pixel workload relative to the default, not a promise of 18× wall time.

Each rendering worker computes one frame at a time and transfers its indexed output. The renderer caches shared noise lattice values within a frame without changing Float64 interpolation order. Accepted frames remain in coordinator memory until the next render or server restart. Retained rooms multiply memory use; the 100-room cap is not a promise that 100 maximum-size renders fit in RAM.

The host collects frames in batches targeting 2 MiB of base64 data (a single operator-sized frame may exceed that), validates run/configuration/order and decodes into indexed arrays. GIF encoding runs in a separate worker; input and output buffers are transferred, not cloned. Leaving or starting a new run cancels export. Indexed frames are retained for playback, the decoded RGBA cache is capped at 24 MiB, and leaving clears it. The final Blob, encoder output, indexed data and browser overhead can still coexist: **peak process memory is larger than raw payload and is browser-dependent**. Rehearse the maximum preset on the actual host before using it live.

The encoder keeps its existing palette, ordered frames, fixed-width LZW and frame-delay rounding (including fractional centiseconds at 40 FPS). No compression algorithm or renderer visual output was changed by the reliability pass. Large exports still take time and the browser may use additional memory to download/open them.

Interactive edits stay within the existing 64 MiB indexed-pixel budget. Advanced `RENDER_CONFIG` JSON overrides are accepted at server startup within existing bounds (dimensions ≤2048, frames ≤600, FPS ≤100, total indexed pixels ≤128 MiB); they are not all UI presets or physical-device-validated workloads. The encoder rejects output over 160 MiB. Upload requests are byte-counted and capped for configured/preset dimensions plus 16 KiB metadata, with an 8 MiB absolute ceiling. Non-upload request bodies are capped at 16 KiB. Limits were not increased.

## Tests and CI

```sh
npm test
```

The complete suite uses Node's built-in test runner. It covers permissions, assignment ownership, pause and lease renewal, disconnect/reconnect and simulation recovery, stale runs/uploads/collection, accepted-only metrics and comparable benchmarks, configuration combinations, deterministic fixtures, decoded GIF pixels/order/timing, export-worker transfer/cancellation and browser-controller lifecycle. The full render test writes `output/borrowed-sky.gif`. Maximum-size GIF tests use synthetic indexed frames to verify capacity/order; they are not a full maximum-size cloud render or measured multi-device benchmark.

`.github/workflows/test.yml` runs `npm test` on pushes to main and pull requests with Node 20, 22 and 24. Node 20 is included for compatibility coverage; use a supported LTS version for the demonstration. There is no install step because there are no dependencies. A local passing run is not evidence that GitHub Actions has executed; check the Actions tab after pushing the workflow.

`node scripts/profile-renderer.mjs` compares the optimized renderer against a frozen themed fixture, checks sampled pixels and writes `output/renderer-profile.json`. These are local renderer microbenchmarks, not distributed speedup measurements.

Browser tests and controller harnesses do not establish LAN reachability, cross-engine equivalence or physical-laptop performance. Fixed hashes and independent worker tests verify deterministic reference output in the tested runtime; test the intended browsers on your actual machines.

## Physical multi-laptop rehearsal

Record the date, devices, OS/browser versions, network, workload, results and failures. Mark this checklist complete only after performing it on distinct physical laptops.

1. On laptop A, run `npm start`; confirm its printed LAN address is reachable from laptops B and C. Keep Node running, all laptops awake/plugged in, and contributor tabs foregrounded.
2. Create a room on A, join the same code on B/C and give each a recognizable name. Verify all three identities and correct host/contributor roles. Confirm B/C cannot edit settings, start a render, use host simulation controls or export the host GIF.
3. Select a default Sunny Sky run first. Confirm identical settings on all screens, start on A and verify each device's accepted count rises. Watch assignments, progress, rolling throughput and contribution shares agree after polling.
4. During a sufficiently long run, disable B's Wi-Fi while it holds an assignment. Keep A/C working. After the seven-second timeout plus polling, verify B is disconnected, an unfinished frame is requeued and other devices complete it. Completed work stays credited. Re-enable B's Wi-Fi and confirm it rejoins the same session without duplicate credit.
5. Separately exercise host **Simulate Worker Failure** on a rendering contributor; verify recovery, then reset it. Pause/resume a contributor and verify other devices continue.
6. Refresh the original host tab during a run while keeping Node alive. Confirm the same host session returns, progress is retained and the animation completes. Do not close the coordinator terminal.
7. Wait for all frames and GIF assembly. Check final count, resolution/theme, contributing-device count and real timings. Exercise play, pause, restart, all speeds, frame navigation and loop off/on. Download and open the GIF; check looping, order and timing.
8. Change theme/settings and start another run in the same room. Verify zeroed counters, cleared old download, resumed devices and a different final animation. Join/leave a contributor during this second run.
9. Test a narrow window, keyboard navigation, readable errors and reduced motion. Disconnect/reconnect one browser briefly and verify connection indicators recover.
10. Rehearse 576 × 384 / 240 frames on the intended host only if the demo will use it. Watch operating-system memory/CPU, responsiveness during collection/export and the download. If it is too slow or memory-heavy, choose the default or medium preset for the demo.
11. For speedup claims, run separate controlled one/two/three-laptop trials without failure injection and export history. Do not use recovery rehearsal timings as a speedup benchmark.

## Known limitations and demo preparation

- Physical LAN testing must be done by the team; same-machine browser sessions do not satisfy it. Venue Wi-Fi isolation, firewalls and background throttling remain practical risks.
- Rooms/frames/history are in memory; no persistence, host migration or room deletion. Up to 32 identities per room and 100 rooms per coordinator; leaving does not remove an identity or free its slot. Restart between rehearsals to clear unused rooms, after exporting needed results.
- The coordinator trusts authenticated frame content and reported durations. No untrusted/public deployment hardening, TLS, user accounts or CPU-utilization measurement is provided.
- Network interruptions can cause repeated computation, but only the valid accepted assignment counts. Recovery runs are excluded from speedup comparisons.
- Keep a downloaded GIF and exported benchmark JSON as an honestly labeled fallback. Prefer the default workload for a short live demonstration and use the failure simulator when a real network interruption would be disruptive.

## Source map

`server.mjs` owns rooms, authentication, assignments, recovery, collection and static routes. `lib/dashboard.mjs` and `lib/benchmarks.mjs` derive measured statistics. `public/config.js`, `renderer.js` and `worker.js` define the deterministic workload. `app.js` manages the browser session; `export.js`/`export-worker.js` run the unchanged `gif.js` encoder off-thread. Dashboard, network, benchmark, failure-demo, playback, result-viewer and shell modules own their respective views. `index.html` and the CSS files provide the no-build interface. Tests and fixtures live under `test/`.
