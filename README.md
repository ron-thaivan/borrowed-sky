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

Keep the host tab open for collection. Reloading a tab restores its session in the same browser tab. The **Pause my contribution** button finishes the current frame, then stops claiming new ones; it is not a disconnect simulation. Do not use duplicated tabs as evidence of multiple physical devices. Separate browsers can test coordination locally but share the same machine’s compute resources.

## Architecture

- `server.mjs`: HTTP static server and in-memory room/job coordinator. Polling avoids WebSocket dependencies and works on ordinary LAN HTTP.
- `public/app.js`: room UI, ~900 ms heartbeat, single-frame claims, upload, progress, host collection.
- `public/worker.js` + `renderer.js`: actual deterministic CPU computation outside the UI thread. Each frame samples a layered 3D noise field; no server-side rendering or simulated progress.
- `public/gif.js`: browser GIF89a encoder with a shared 256-color palette and simple fixed-width LZW. All frames are assembled in frame-index order, regardless of completion order.

Each assignment has a unique lease token and render-run ID. Disconnected jobs and 30-second expired leases are requeued. Late or duplicate results receive HTTP 409. One outstanding frame per device limits recovery cost. The host also contributes. New devices can join mid-render. The host can render again after completion.

## Honest performance measurements

**Wall time** runs from server render start until the last accepted upload. **Worker CPU time** is the sum of accepted worker render durations measured with `performance.now()`; it includes OS scheduling, excludes rejected/repeated computation, and is not actual CPU utilization. **Frame payload** counts raw accepted indexed pixels, excluding the roughly 33% base64 expansion, HTTP/polling overhead, rejected uploads, and final frame download. Browser GIF assembly happens after render wall time and is not included.

Compare one-laptop and three-laptop wall times using the same scene, machines, power settings, and network; repeat several runs. Do not label summed worker time divided by wall time as speedup. Small jobs, slow devices, background-tab throttling, coordination, and uploads can make the shared run slower. This MVP uses one worker per laptop and a fixed 192×128, 120-frame scene. GIF encoding favors simplicity over compression (~3.2 MB output).

## Verify

```sh
node --test
```

Tests cover distinct assignments, host permissions, graceful and heartbeat-based recovery, stale lease rejection, completion, ordered collection, new runs, renderer determinism, and GIF framing.

The full-render test also computes all 120 frames using concurrent worker threads and writes `output/borrowed-sky.gif`. It uses the same renderer as the browser but is not a substitute for browser or physical-device testing.

Verified during implementation: the test suite passed; Windows decoded all 120 generated GIF frames; two browser clients joined the same render, the guest completed 27 frames before leaving, one unfinished frame was recovered, and the host reached 120/120 with a looping preview and a 3.2 MB download link. That browser run took 37.5 seconds, with 47.6 seconds of summed worker durations, on one physical machine. These are functional checks, not a speedup benchmark. Multi-laptop LAN reachability remains to be checked at the venue.

## 24-hour scope and limitations

This is a trusted-network prototype: no accounts, persistent storage, host transfer, malicious-worker validation, or internet production hardening. A room code grants contribution access. Host actions require a private session token. Up to 32 device sessions per room and 100 rooms per server are allowed; restart the server to clear old rooms. A disconnected host’s frames are recovered, but its tab must return to collect the animation. Very slow devices may repeatedly exceed the lease. Refresh after a server restart and leave the old room to create a new one.

Suggested next steps after the demo works on three physical devices: adjustable workload, per-device throughput, measured one-device baseline, compressed binary transport, and persistent results. Avoid adding these before verifying the LAN demo.
