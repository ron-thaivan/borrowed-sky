# Final reliability review — 2026-11-08

## A. Issues found

- A renderer error depended on a successful server pause to prevent retries. A failed pause request could allow the same broken assignment to be rendered repeatedly. Worker startup and message-deserialization failures also lacked a reliable local stop.
- Malformed saved session objects were accepted, and blocked session storage could interrupt joining or leaving a room.
- Completed-animation playback auto-started even when reduced motion was requested.
- Per-room limits did not limit combined frame storage across rooms. Many retained completed runs could consume substantial coordinator memory.
- The newly added shell test assumed Unix line endings and failed on a Windows checkout. The one-line correction from the preceding sync is retained.
- Worker-duration labels were inconsistent across the overview, analytics and documentation.

## B. Changes made

| Files | Change |
| --- | --- |
| `public/app.js` | Latch renderer faults locally; stop the worker and stop renewing its assignment. Explicit successful resume or a new run clears the fault. Handle startup, execution and message-delivery failures. Validate restored credentials and tolerate unavailable storage with an explicit refresh warning. |
| `server.mjs` | Reserve each run's full indexed-frame storage before starting. Default shared budget: 256 MiB across active and completed rooms. Reject over-budget starts without modifying existing runs; allow a room to replace its own completed allocation. |
| `public/result-viewer.js` | Respect reduced motion for autoplay and pause when that preference is enabled. Keep explicit playback available. |
| `public/index.html`, `public/benchmarks.js` | Use the same Total Worker Render Time label, preserving its accepted-duration definition. |
| `test/browser-state.test.mjs` | Regressions for failed coordinator pauses after renderer errors, startup/message failures, explicit resume/new-run reset, malformed credentials and blocked storage. |
| `test/reliability.test.mjs` | Regressions for aggregate reservations, non-destructive budget rejection, same-room replacement, and original-host return after contributors finish. |
| `test/result-viewer.test.mjs`, `test/shell.test.mjs` | Reduced-motion assertions and Windows-compatible test-source loading. |
| `README.md` | Document safeguards and limits; retain the consolidated feature, permissions, networking, benchmark and physical-rehearsal instructions. |

Architecture, dependencies, frame dimensions, rendering algorithm, palettes, deterministic fixtures and GIF encoder are unchanged. The existing GitHub Actions workflow already runs `npm test` on pushes to main and pull requests, using Node 22 and 24 with read-only repository permissions. No install step is needed. No replacement workflow was added.

## C. Tests and measurements

- `node --test`: **75 passed, 0 failed**, including the actual concurrent-worker full render, lease and recovery cases, all 972 preset validations, deterministic reference hashes and GIF decoding at every supported resolution/frame-count combination.
- Targeted browser-controller regressions: **16 passed, 0 failed** after the fixes.
- `node scripts/profile-renderer.mjs`: sampled frame hashes matched exactly. Local mean durations were approximately 422.3 ms for the frozen original renderer and 125.6 ms for the already optimized renderer. This small local sample is not a new optimization or a distributed speedup benchmark.
- Desktop browser integration: two tabs on one physical machine completed a 192 × 128 / 60-frame Sunny Sky run (32 host frames, 28 contributor frames), assembled a 1.60 MiB GIF and exercised pause/scrubbing. A consecutive 384 × 256 / 60-frame Night Sky run also completed. Original host identity survived refresh. Contributor settings and analytics restrictions were checked.
- Maximum-preset browser rehearsal: a real 576 × 384 / 240-frame Night Sky render completed in **291.36 seconds**, with **126 host frames and 114 contributor frames**. Simulation recovered frame 4; host refresh recovered another assignment. Original host identity survived the mid-run refresh. Contributor pause finished its current frame, and resume restarted contribution. This run includes deliberate interruptions and is not a clean benchmark.
- The maximum browser export downloaded successfully to `C:\Users\ronal\Downloads\borrowed-sky-night.gif`: **60,259,761 bytes (57.47 MiB)**. An independent local check decoded all 240 frame streams, validated dimensions/pixel counts and 12 seconds of GIF timing, and matched complete pixel arrays for frame indices 0, 119 and 239 against the Node renderer. Both test tabs had **no captured console warnings or errors**.
- `git diff --check`: no whitespace errors. Git printed normal Windows line-ending conversion notices.

Local execution used Node 24.22.1. CI execution and other Node/browser versions were not verified here. Tests using synthetic indexed frames establish encoder capacity and correctness, not physical-network speedup.

## D. Remaining limitations

- No physical multi-laptop LAN test has been performed in this review. Venue reachability, firewall rules, Wi-Fi client isolation, browser throttling and cross-engine behavior need rehearsal.
- Follow-up responsive verification used the actual application inside a same-origin 390-pixel iframe. Landing and workspace had no page-wide horizontal overflow (375-pixel content area, matching scroll width). Section navigation, configuration, a real 60-frame render, completed playback/pause and frame scrubbing worked with no captured console warnings or errors. This checks the responsive layout in the desktop browser, not a physical mobile browser.
- Frame reservations are not a process-memory ceiling: base64, JSON, metadata, browser allocations and export buffers add overhead. Maximum UI raw data is 50.625 MiB, each base64 transfer direction is approximately 67.5 MiB, and the GIF is approximately 57.47 MiB. Host raw frames, GIF output, Blob and the 24 MiB image cache can coexist temporarily.
- Rooms persist only in coordinator memory. There is no host migration or room deletion; departed identities retain their slots. Save downloads/history before a restart. A lost original host session cannot be recovered just from the room code.
- Authenticated workers are trusted to return genuine pixels and durations. The app remains intended for a trusted demo network, not an untrusted public compute service.
- A locally stopped faulty worker can still appear assigned until its unrenewed lease expires. Other devices then recover its work through the ordinary coordinator path.
- Follow-up: the idle port-3000 coordinator was restarted with the safeguards and a fresh host room was left ready in the user's browser. Temporary review servers/tabs were stopped. Source changes have not been committed or pushed.

## E. Physical testing checklist

1. On laptop A, start Node with `npm start` (or `node server.mjs`). Keep it powered and awake; record its printed LAN URL.
2. Connect B and C to that URL over the same Wi-Fi. Confirm reachability before presenting; localhost on B/C will not reach A.
3. Create one room on A. Give each device a recognizable name and join the same code from B/C. Confirm roles and identical configuration.
4. Start the default render. Verify all three accepted-frame counters increase and contributor controls remain restricted.
5. On a sufficiently long run, disconnect B's Wi-Fi while it holds a frame. After seven seconds plus polling, verify disconnected status, recovered assignment count and another laptop completing the requeued frame.
6. Reconnect B. Separately test the simulated-failure button/reset and per-device pause/resume. Confirm no duplicate accepted credit.
7. Refresh the original host tab while leaving Node running. Verify host identity and progress survive, then let the animation finish.
8. Verify the final frame count, dimensions, theme and contributor counts. Test playback, scrubbing and loop control; download and open the GIF.
9. Start a new theme/run. Confirm cleared counters/downloads and automatically resumed devices. Join/leave a contributor mid-run.
10. Check a genuinely narrow browser window, keyboard navigation and reduced motion. Rehearse the maximum preset only if intended for the demo; observe memory and responsiveness on the actual host.
11. For performance claims, run separate repeated one/two/three-physical-device trials under the documented comparable conditions, without failure injection. Export measurement JSON.

Record date, machines, OS/browser versions, network, settings and observed failures. Do not mark this checklist completed based on automated tests or same-machine browser tabs.

## F. Hackathon readiness

The core workflow has strong automated coverage and successful same-machine browser integration checks. It is ready for a physical team rehearsal, not yet a verified venue-ready demonstration. Use a modest preset for a short presentation; use a larger workload only when needed to give judges time to observe recovery. Keep a previously downloaded GIF as a clearly labeled fallback.
