# Borrowed Sky — Python Distributed Backend

A small, working distributed-computing platform written in Python. One computer runs **HQ** (the coordinator), any number of other computers run **workers**, and work submitted to HQ over HTTP is scheduled onto whichever worker has spare CPU and RAM. One machine may not have all the hardware resources needed in order to run very heavy programs or multiple agents at once. Now we can work as a team and connect hardware in order to support these demanding projects. 

> **Status:** prototype. It runs end to end on its own, but it is **not yet connected** to the Borrowed Sky browser frontend. The frontend currently uses its own Node.js coordinator (`server.mjs`, port 3000). This document explains what the backend does, how to demo it, and where it can go next.

**Contents**

1. [Run the demo](#1-run-the-demo)
2. [Before you demo: one known bug](#2-before-you-demo-one-known-bug-and-its-fix)
3. [What each folder does](#3-what-each-folder-does)
4. [How a job flows through the system](#4-how-a-job-flows-through-the-system)
5. [HTTP API reference](#5-http-api-reference)
6. [Current limitations](#6-current-limitations)
7. [Possibilities after integration](#7-possibilities-after-integration)
8. [Pooling hardware for multi-agent groups](#8-pooling-hardware-for-multi-agent-groups)
9. [Distributing other programs' workloads](#9-distributing-other-programs-workloads)

---

## 1. Run the demo

All commands run from the **repository root** (the folder containing `backend/`), not from inside `backend/`. Every command below was run against this repo to confirm it works. Use `python3` instead of `python` on macOS/Linux if needed.

### 1.0 One-time setup

```bash
# macOS / Linux / Git Bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt pytest
```

```powershell
# Windows PowerShell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt pytest
```

`./dev.sh setup` does the same thing on macOS/Linux/Git Bash. Open each new terminal in the repo root and activate the virtual environment again.

Optional sanity check (compiles every file and runs the tests; takes under a second):

```bash
python -m compileall -q backend && python -m pytest -q && python test.py
```

### 1.1 Terminal 1 — start HQ

```bash
python -m backend.coordinator.main
```

You should see:

```
[API] Listening on http://127.0.0.1:8080
[HQ] Listening on 0.0.0.0:5050
```

HQ listens for workers on TCP `5050` and serves the HTTP API on `8080`. Equivalent: `python -m backend.main --role hq` or `./dev.sh backend`.

### 1.2 Terminal 2 — start worker 1

```bash
python -m backend.worker.main --host 127.0.0.1
```

You should see `[WORKER] Connected to HQ...` and `[WORKER] Registered with device ID ...`. HQ prints `[CONNECTED] Worker ...` and a resource pool. Equivalent: `python -m backend.main --role worker --hq 127.0.0.1` or `./dev.sh worker --host 127.0.0.1`.

### 1.3 Terminal 3 — start worker 2

**Option A (real demo): a second laptop on the same Wi-Fi.** Use HQ's LAN IP instead of `127.0.0.1`:

```bash
python -m backend.worker.main --host 192.168.1.20   # replace with HQ's actual IP
```

Allow Python through the firewall on HQ's machine for TCP port 5050.

**Option B (single-machine rehearsal): fake a second computer.** A worker's identity is stored in `~/.dcp/device_id`, so two workers on one computer would be treated as *two sessions of the same device*. Give the second worker its own home directory so it registers as a separate device:

```bash
# macOS / Linux / Git Bash
mkdir -p /tmp/dcp-worker2
HOME=/tmp/dcp-worker2 python -m backend.worker.main --host 127.0.0.1
```

```powershell
# Windows PowerShell (affects only this terminal)
$env:USERPROFILE = "$env:TEMP\dcp-worker2"
python -m backend.worker.main --host 127.0.0.1
```

### 1.4 Terminal 4 — inspect the cluster and send jobs

The HTTP API is bound to `127.0.0.1`, so run these **on the HQ machine**.

```bash
# Who is connected, and how much capacity does each device have?
curl localhost:8080/api/status
curl localhost:8080/api/devices
```

Send a prime-counting job (counts primes between `start` and `end`, inclusive):

```bash
curl -X POST localhost:8080/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"task_type":"COUNT_PRIMES","payload":{"start":1,"end":300000},"cpu_cores":0.5,"memory_mb":256}'
```

Send a sum job:

```bash
curl -X POST localhost:8080/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"task_type":"SUM_RANGE","payload":{"start":1,"end":1000000},"cpu_cores":0.1,"memory_mb":64}'
```

Check results (the first call lists every task; the second looks up one by ID):

```bash
curl localhost:8080/api/tasks
curl localhost:8080/api/tasks/<task_id>
```

In PowerShell, `curl` is an alias for `Invoke-WebRequest`. Use this instead:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/tasks -ContentType "application/json" `
  -Body '{"task_type":"COUNT_PRIMES","payload":{"start":1,"end":300000},"cpu_cores":0.5,"memory_mb":256}'
Invoke-RestMethod http://localhost:8080/api/tasks
```

Expected results from a verified run: `COUNT_PRIMES 1..300000 → 25997`, `COUNT_PRIMES 300001..450000 → 11709`, `SUM_RANGE 1..1000000 → 500000500000`. HQ prints `[TASK RUNNING]` then `[TASK COMPLETED]` for each.

### 1.5 Demo scenarios worth showing

| Scenario | What to do | What it shows |
| --- | --- | --- |
| **Basic dispatch** | Submit one job (above). | HQ picks a device, reserves CPU/RAM, worker computes, result returns. |
| **Capacity awareness** | Read `available_cpu_cores` for each device from `/api/devices`. Submit a job requesting roughly 60% of one device's value, then a second of the same size. | The second job cannot fit on the first device, so HQ places it on the other one. |
| **Queueing** | Submit a job requesting more CPU than any device has (the default `cpu_cores` is `1.0`, which a small machine may not satisfy). | The task stays `PENDING`. HQ retries it when a worker's next resource update arrives (about every 15 seconds). |
| **Live resource view** | Watch Terminal 1 while jobs run. | HQ re-prints the resource pool on every worker event. |
| **Worker failure** | Submit a long job (e.g. `COUNT_PRIMES` from `1000000000000` to `1000000400000`), then close the worker's terminal mid-run. | The task should become `FAILED`. **Apply the fix in section 2 first**, or it will stay `RUNNING` forever. |

> **Scheduling note:** the scheduler uses *best-fit packing*. It picks the device that would have the **least** spare capacity left after the job, so small jobs often pile onto one device until it fills up, rather than spreading evenly. That is why the capacity-awareness scenario above uses larger requests.

### 1.6 Stopping everything

Press `Ctrl+C` in each worker terminal (a graceful `DISCONNECT` is sent), then in the HQ terminal.

---

## 2. Before you demo: one known bug and its fix

**Symptom:** if a worker dies while holding a task, the task stays `RUNNING` forever and its CPU/RAM reservation is never released. HQ's log shows `AttributeError: 'HQServer' object has no attribute 'task_service_handle_worker_disonnect'`.

**Cause:** in `backend/coordinator/main.py`, the cleanup block in the `finally:` section calls a misspelled method (`task_service_handle_worker_disonnect`, missing a `.` and a letter). It sits directly above a second, correctly written copy of the same logic.

**Fix:** delete the first block, from the comment `# handle unfinished tasks only when the physical device is fully offline` through its `for task_id in failed_tasks:` loop. Keep the second block that begins `# check whether this was the physical device's final active session`. It calls `self.server.task_service.handle_worker_disconnect(device_id)` correctly.

This was tested on a scratch copy: after removing the first block, killing a worker mid-task produced `FAILED | Worker disconnected before task completion was confirmed.` and the reservation was released. A small side effect remains: the log line `[TASK FAILED] {device_id} / {session_id}` prints the device and session instead of the task ID. That is cosmetic.

---

## 3. What each folder does

```
backend/
├── main.py                  Single entry point: --role hq | worker
├── requirements.txt         One dependency: psutil
├── common/                  Code shared by HQ and workers
│   └── protocol.py          The wire protocol
├── coordinator/             Everything that runs on the HQ machine
│   ├── main.py              TCP server + per-worker connection handler
│   ├── api.py               HTTP API for frontends and test scripts
│   ├── registry.py          Inventory of physical devices
│   ├── resource_manager.py  Capacity math and reservations
│   ├── scheduler.py         Chooses which device runs a task
│   ├── task_manager.py      Task records and lifecycle rules
│   ├── task_service.py      Orchestrates submit → schedule → dispatch
│   └── connection_manager.py  Live sockets to each worker
└── worker/                  Everything that runs on a contributing machine
    ├── main.py              Connect, register, report hardware
    ├── runtime.py           Main loop: heartbeats, receive tasks, return results
    └── executor.py          The actual computation

Related files at the repo root:
  dev.sh                     setup / check / demo / backend / worker helper
  test.py                    Manual resource-manager walkthrough script
  test/test_distributed_task.py   pytest checks (2 tests)
```

About 2,600 lines of Python in total.

### `backend/` (top level)

| File | Role |
| --- | --- |
| `main.py` | Parses `--role hq` or `--role worker` (plus `--hq` address and `--port`) and starts the right mode. HQ binds `0.0.0.0` so other computers can reach it. Note: `--port` changes only the TCP worker port; the HTTP API port is hard-coded to 8080. |
| `requirements.txt` | Only `psutil`, used by workers to read CPU and RAM. |

### `backend/common/` — the shared language

| File | Role |
| --- | --- |
| `protocol.py` | Defines how HQ and workers talk. Messages are JSON, sent over TCP with a **4-byte length prefix** so message boundaries are unambiguous. Every message carries `protocol_version`, `message_type`, `message_id`, `device_id`, `session_id`, `timestamp` and a `payload`. It validates incoming messages, rejects unknown types and bad fields, and caps message size at 8 MB. It knows nothing about hardware or scheduling, only formatting and framing. |

Defined message types: `REGISTER`, `REGISTER_ACK`, `RESOURCE_REPORT`, `RESOURCE_UPDATE`, `HEARTBEAT`, `JOB_SUBMIT`, `JOB_ACCEPTED`, `JOB_RESULT`, `JOB_FAILED`, `JOB_CANCEL`, `JOB_CANCELLED`, `DISCONNECT`, `ERROR`. `JOB_CANCEL` is understood by workers but nothing in HQ sends it yet, and `ERROR` is defined but unused.

**Two IDs matter:** `device_id` identifies the *physical computer* (saved in `~/.dcp/device_id` and reused across restarts). `session_id` identifies *one connection*. This lets the registry keep a device "online" while any of its sessions is alive.

### `backend/coordinator/` — the HQ

| File | Role |
| --- | --- |
| `main.py` | Starts a threaded TCP server (one thread per worker). The handler requires `REGISTER` first, checks the worker role, acknowledges, then loops over incoming messages: resource reports, heartbeats, and job outcomes (`JOB_ACCEPTED/RESULT/FAILED/CANCELLED`). On disconnect it cleans up and fails that device's unfinished tasks. It also builds and wires together every manager below and starts the HTTP API. Connections time out after 15 seconds of silence; workers heartbeat every 5. |
| `api.py` | A small HTTP server (Python standard library, port 8080, localhost only) so something other than a worker can talk to HQ. Provides status, devices, task list, task detail, and task submission. CORS is open (`*`), which suggests it was built for a browser frontend to call. See [section 5](#5-http-api-reference). |
| `registry.py` | The device inventory. One record per physical device: hostname, online/offline status, latest hardware report, active session count, first-connected and last-seen times. Thread-safe, and returns copies so callers cannot corrupt it. |
| `resource_manager.py` | Turns hardware reports into **allocatable capacity** and tracks reservations. Usable CPU = `logical_cores × (80% − current_cpu_percent)`, and usable RAM = `80% × available_memory`. So a device already at 80% CPU offers nothing, and tasks never use the last 20% of RAM. It subtracts what running tasks have reserved, and refuses reservations that do not fit. |
| `scheduler.py` | Picks a device for each `PENDING` task. It filters out devices without enough free CPU/RAM, scores the rest by how much normalized capacity would remain (CPU and RAM weighted equally), and tries the tightest fit first. If a reservation fails because capacity just changed, it tries the next device. |
| `task_manager.py` | Owns the task records and enforces a state machine: `PENDING → SCHEDULED → RUNNING → COMPLETED`, with `FAILED` and `CANCELLED` as other endings. Invalid jumps raise errors. It validates inputs (integers only, `start ≤ end`, size caps of 500,000 for primes and 10,000,000 for sums) and allows only two task types: `SUM_RANGE` and `COUNT_PRIMES`. |
| `task_service.py` | The glue. `submit_task` creates the task, runs a scheduling pass, and sends `JOB_SUBMIT` to the chosen worker. If sending fails it marks the task `FAILED` and releases the reservation. `handle_worker_disconnect` fails unfinished tasks for a lost device. |
| `connection_manager.py` | Remembers the live socket for each worker session and sends messages to a device, using a per-socket lock so two messages never interleave. Drops sockets that fail. |

### `backend/worker/` — a contributing machine

| File | Role |
| --- | --- |
| `main.py` | Networking and identity only. Loads or creates the persistent device ID, connects to HQ, sends `REGISTER`, waits for the acknowledgement, and sends the first hardware report (OS, architecture, logical and physical cores, total and available RAM, CPU %, and a GPU placeholder that is always "unavailable"). On Ctrl+C it sends a graceful `DISCONNECT`. Contains a block of commented-out older heartbeat code that has been superseded by `runtime.py`. |
| `runtime.py` | The worker's heartbeat. In one loop it sends a heartbeat every 5 s, a fresh hardware report every 15 s, returns finished results, and checks for new tasks from HQ using `select` so it never blocks. Tasks run on a background thread so the network stays responsive. It acknowledges with `JOB_ACCEPTED`, supports cancellation through a per-task event, and rejects duplicate or malformed submissions. **It runs one task at a time.** |
| `executor.py` | The computation itself. `SUM_RANGE` uses the closed-form arithmetic-series formula. `COUNT_PRIMES` uses trial division and checks for cancellation every 1,024 numbers. Any other task type is rejected. This allowlist is deliberate: workers never run arbitrary code from the network. |

### Tests and tooling

| File | Role |
| --- | --- |
| `dev.sh` | Helper script: `setup`, `check` (compile + pytest), `demo` (check, then start HQ), `backend` (start HQ), `worker --host HOST`. |
| `test.py` | Standalone walkthrough: registers a fake laptop, reserves CPU/RAM, shows a rejected over-reservation, then a release. Prints `SUCCESS` when done. |
| `test/test_distributed_task.py` | Two pytest tests: the services wire together, and a new registry is empty. These are smoke tests; scheduling, dispatch and failure handling are not yet covered. |

> The GitHub Actions workflow runs only `npm test` (the Node side). The Python tests are not run in CI yet.

---

## 4. How a job flows through the system

```
                        HTTP POST /api/tasks
   client / frontend ───────────────────────────►  ┌────────────────────────────┐
                                                   │ HQ                         │
                                                   │  api.py                    │
                                                   │   └► task_service.submit   │
                                                   │       ├► task_manager      │ create task (PENDING)
                                                   │       ├► scheduler         │ choose best-fit device
                                                   │       │   └► resource_mgr  │ reserve CPU + RAM
                                                   │       └► connection_mgr    │ send JOB_SUBMIT
                                                   └───────────────┬────────────┘
                                          TCP :5050 (JSON frames)  │
              ┌────────────────────────────────────────────────────┴─────────┐
              ▼                                                              ▼
      ┌───────────────┐                                              ┌───────────────┐
      │ Worker A      │   REGISTER / RESOURCE_REPORT / HEARTBEAT     │ Worker B      │
      │ runtime.py    │   JOB_ACCEPTED → JOB_RESULT or JOB_FAILED    │ runtime.py    │
      │ executor.py   │ ───────────────────────────────────────────► │ executor.py   │
      └───────────────┘      (HQ marks task, releases reservation)    └───────────────┘
```

**Task lifecycle**

```
PENDING ──scheduler picks a device──► SCHEDULED ──worker accepts──► RUNNING ──► COMPLETED
   │                                      │                            │
   └────────────► CANCELLED ◄─────────────┴──────────► FAILED ◄────────┘
```

If no device fits, the task stays `PENDING`. HQ retries pending tasks when a new task is submitted and whenever a worker sends a resource update (about every 15 seconds).

---

## 5. HTTP API reference

Base URL `http://127.0.0.1:8080`. All responses are JSON.

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/status` | `status`, `connected_workers` (device IDs), `device_count`, `task_count` |
| `GET` | `/api/devices` | `devices` (hardware reports, status, sessions, timestamps) and `resource_pool` (allocatable capacity per online device) |
| `GET` | `/api/tasks` | Every task |
| `GET` | `/api/tasks/<id>` | One task, or `404` |
| `POST` | `/api/tasks` | Submit work. Body: `task_type` (string), `payload` (object), optional `cpu_cores` (default `1.0`), optional `memory_mb` (default `128`). Returns `202` with the task, `400` for invalid input, or `503` if dispatch failed. |

Supported `task_type` values: `SUM_RANGE` and `COUNT_PRIMES`, both with `payload` of exactly `{"start": int, "end": int}`.

---

## 6. Current limitations

These are worth stating plainly in any demo or presentation. None are surprising for a prototype, and most are listed again in the roadmap as upgrades.

- **Not connected to the frontend.** The browser app talks to the Node coordinator; the Python HQ is a separate system with different ports and a different protocol.
- **Two toy task types.** The allowlist is a good safety foundation, but real work needs more types.
- **No automatic retry.** A task on a failed worker becomes `FAILED`; it is not re-queued elsewhere. (The Node coordinator does recover work, so there is a design to borrow.)
- **No worker reconnect.** If the connection drops, the worker process exits instead of retrying.
- **One task at a time per worker**, even if HQ reserved resources for several. Extra tasks wait in that worker's queue, so reserved capacity can sit idle.
- **Pending tasks are retried only on submit or resource update**, not the moment a task finishes, so a waiting job can lag up to about 15 seconds.
- **Everything is in memory.** Restarting HQ erases tasks and history.
- **No authentication or encryption.** Any machine that can reach port 5050 can join as a worker. Use a trusted network only.
- **The HTTP API is localhost-only** (hard-coded) and has no cancel endpoint, even though workers can already cancel.
- **Two workers on one computer share a device identity** unless given separate home directories (see section 1.3).
- **GPU is a placeholder.** The report always says unavailable.
- **The worker-disconnect bug** in section 2.

---

## 7. Possibilities after integration

### 7.1 What the Python side adds that browsers cannot

The Node integration notes (`docs/PYTHON-INTEGRATION.md`) explain why some measurements were deliberately **not** ported to the browser: ordinary browser APIs cannot see CPU utilization, free RAM, physical core count, hostname, OS release, architecture or GPU. A native Python worker can read all of them through `psutil`. That is the core value of integrating the two:

| Capability | Browser worker | Python worker |
| --- | --- | --- |
| Logical processors | Reported, may be capped | Exact |
| Physical cores | Not available | Yes |
| Free RAM | Coarse estimate at best | Exact, refreshed every 15 s |
| Live CPU utilization | Not available | Yes |
| Hostname / OS release / architecture | Coarse labels only | Yes |
| Capacity-aware scheduling | Not possible | Already implemented |
| Native-speed compute (NumPy, compiled libraries) | JavaScript only | Yes |

Real capacity data also means HQ can avoid overloading a laptop its owner is actively using, which is what the 80% CPU/RAM ceiling in `resource_manager.py` already does.

### 7.2 More specific data metrics

Much of the raw material already exists. Tasks carry `created_at`/`updated_at`, and workers already stream CPU and RAM every 15 seconds. Natural additions:

**Per task:** queue wait time, run time, dispatch-to-result latency (add `started_at` and `completed_at`), result size, retry count, and which device ran it.

**Per device:** tasks completed, failures, average run time, throughput (tasks or units of work per second), utilization over time as a chart (CPU and RAM history), reserved versus actually used resources, uptime and reconnect counts, and a reliability score.

**Per cluster:** queue depth, total and idle capacity, utilization percentage, and job completion rate.

**Richer hardware data from `psutil`:** battery level and plugged-in state, disk free space, network throughput, CPU frequency, temperatures where the OS exposes them, and real GPU detection.

**Benchmarking that matches the frontend's rules.** Borrowed Sky already defines speedup carefully (single-device wall time ÷ multi-device wall time, comparable runs only, host-attested conditions). The backend could produce the same measurements for any job type and reuse those rules so claims stay honest.

**Delivery:** a `/metrics` endpoint (Prometheus-style) for dashboards, and server-sent events or WebSockets so the UI updates immediately instead of polling every 900 ms.

### 7.3 Sending jobs to be distributed among the computers

Today one HTTP call creates one task for one worker. The larger step is **jobs made of many tasks**:

- **Split / run / merge (scatter-gather).** Submit one big job, such as counting primes up to 50 million. HQ splits it into chunks, spreads them across workers, and combines the results. The existing `start`/`end` payload already makes ranges easy to split.
- **Dynamic chunk sizing and speed weighting.** Benchmark each device when it joins and give faster machines larger chunks or more of them.
- **Automatic retry and re-queue** when a worker disappears, plus per-task timeouts. The Node coordinator already recovers work this way.
- **Straggler handling.** If one chunk is slow, run a duplicate on an idle worker and keep whichever finishes first.
- **Multiple tasks per worker**, using one slot per reserved core, and a process pool instead of a single thread so CPU-heavy Python code is not limited by the GIL.
- **Priorities, fair sharing between users, and a cancel endpoint.** The worker side of cancellation (`JOB_CANCEL`) already exists.
- **Capability tags** (`gpu`, `os`, `arch`, `ram>=16GB`) so a task can require a kind of machine.
- **Preemption and owner-friendliness:** pause or drain a worker when its owner starts using the laptop or the battery gets low.

### 7.4 Ways to connect it to the existing frontend

| Option | How it works | Trade-off |
| --- | --- | --- |
| **A. Dashboard reads the Python API** | Add a "Python cluster" view that polls `/api/devices` and `/api/tasks`. CORS is already open. | Smallest step. Two systems still run side by side. |
| **B. Node as gateway** | `server.mjs` proxies to the Python HQ, keeping the frontend's single origin, room codes and host authentication. | One URL for users, and the Node security model protects the Python API. More plumbing. |
| **C. Python worker joins a Node room** | A headless Python process speaks the Node app's HTTP protocol (claim frame, render, upload) like a browser tab. Native workers then help render clouds alongside browsers. | Needs a Python port of the cloud renderer that matches the deterministic output exactly. The frontend's reference hashes would verify it. |
| **D. Python HQ replaces the Node coordinator** | One coordinator for everything. | Largest rewrite; would need the room, auth, lease and benchmark logic reimplemented. Probably not worth it. |

A or B first, then C if native speed matters, is the lowest-risk path.

### 7.5 Optimization

- **Scheduling policy as a setting.** Today it is best-fit packing (fills one machine before using the next). Add *spread* (balance load) and *fastest-first*, and let the job choose.
- **Data locality:** run a task where its input already is.
- **Work stealing:** idle workers take queued chunks from busy ones.
- **Cost-aware placement:** prefer plugged-in machines, avoid ones near thermal or battery limits.
- **Honest limits:** only coarse-grained, parallelizable work speeds up. Network and coordination overhead can make small jobs *slower* when distributed, so the system should measure and report that rather than assume a win. This matches the project's existing standard of not claiming speedup without comparable measurements.

---

## 8. Pooling hardware for multi-agent groups

**The idea.** A group wants to run several AI agents, but no single member has enough CPU, RAM or GPU. Each member runs a worker. The cluster behaves like one shared machine whose resources are everyone's resources combined.

**Why this backend is a reasonable foundation.** An agent is, to the scheduler, a workload with resource requirements: "this agent needs 2 cores and 4 GB RAM", or "this one needs a GPU". HQ already knows how to find a machine that fits, reserve the resources, track the agent's state, and notice when its machine disappears.

**What would need to be added:**

1. **Long-running tasks.** Add an `AGENT` task type that runs until stopped, with its own health checks, instead of finishing in seconds.
2. **GPU and VRAM in capacity accounting**, plus capability tags so a model-hungry agent lands on the one machine with a GPU.
3. **A message bus through HQ.** The protocol envelope (sender, session, message ID, payload) is already a messaging format. Adding an `AGENT_MESSAGE` type with routing lets agents on different laptops talk to each other.
4. **Shared state.** A simple store on HQ (notes, task board, files, memory) that every agent can read and write.
5. **Model hosting strategy.** Two practical designs:
   - **Shared inference server (recommended starting point).** The machine with the strongest GPU hosts the model. Other machines run lightweight agents that call it over the network. Hardware is pooled by *placing* components, not by splitting one model.
   - **Per-machine models.** Each agent runs a small local model on its own machine.
   Splitting a single large model across laptops over Wi-Fi exists in research and some open-source tools, but it is latency-sensitive and usually slow, so it is not a good first goal.
6. **Role-based placement.** For example a planner agent, a coding agent, a test-runner agent and a reviewer agent, each placed where it fits and replaced automatically on another worker if its machine drops out.
7. **Safety.** Agents that run code, or tools that touch files, would execute on teammates' laptops. That needs sandboxing (containers or restricted subprocesses with CPU, memory and filesystem limits), authentication and TLS, and an explicit allowlist of tools. The current design of "workers only run approved task types" is the right instinct to extend, not abandon.

**What it gives a group:** shared access to scarce hardware, graceful loss of a member's laptop, visible utilization so nobody's machine is silently overloaded, and a single place to start, stop and watch every agent.

---

## 9. Distributing other programs' workloads

The platform's real product is "find spare compute, reserve it, run something, return the result". Nothing about that is specific to primes or clouds. With a plugin-style task system, many existing programs fit:

| Workload | How it distributes |
| --- | --- |
| **Video and image processing** | Split a video into segments, transcode in parallel (for example with ffmpeg), then stitch. Batch-resize or filter folders of images. |
| **3D / animation rendering** | One frame or tile per task, the same pattern Borrowed Sky already uses for clouds. |
| **Test suites and builds** | Shard a large test suite across machines, or compile independent modules in parallel. |
| **Data processing** | Map-reduce style: process file chunks on separate workers, then merge. |
| **Parameter sweeps and simulation** | Monte Carlo runs, hyperparameter searches, scientific parameter grids; every run is independent. |
| **Batch AI inference** | Score a large dataset by splitting it across machines with capable hardware. |

**Design requirements for a general runner**

- **Task types as plugins**, each declaring its input schema, resource needs and how to split and merge. This keeps the allowlist safety model: a worker only runs plugins it has installed.
- **A side channel for large data.** Messages are capped at 8 MB, so inputs and outputs (frames, video segments, datasets) should move by file server, upload endpoint or shared storage, with only references in the protocol. The Node app currently sends frames as base64 over HTTP; that works for small payloads but does not scale to large files.
- **Idempotent, deterministic tasks** where possible. If a task can safely run twice, retries and duplicate "straggler" execution become easy. Deterministic output also enables **result verification** by running a sample on two machines and comparing hashes, which the frontend's fixed reference hashes already demonstrate.
- **Isolation.** Run tasks in subprocesses or containers with resource limits, and clean up temporary files.
- **Accounting.** Record who ran what, for how long, so the cluster can report utilization and fair-share usage.


