# Borrowed Sky: optional Python workload prototype

This directory contains a separate installed Python experiment. It runs arithmetic jobs on Python worker processes over TCP. It is **not the backend of the Borrowed Sky website**: the website still uses `server.mjs`, browser Web Workers, room codes, frame leases and GIF assembly. Starting this prototype does not connect Python workers to browser rooms or change the website.

The Python coordinator (HQ) tracks worker sessions and reported resources, assigns bounded jobs, collects results and recovers unfinished jobs when a worker disappears. Jobs are `SUM_RANGE` and `COUNT_PRIMES`; arbitrary code and animation rendering are not supported. Each submitted job runs on one worker. Submit multiple jobs to use several workers; a single range is not automatically divided between laptops.

## Setup

Run commands from the repository root. Install Python 3.12 on HQ and each worker. The runtime dependency is `psutil`; `pytest` is needed only to run tests. Participants in the main website still need only a browser.

Windows PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt pytest
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"
```

Linux/macOS:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt pytest
.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))'
```

Generate the token **once**, then set the same value on HQ and every worker. `BORROWED_SKY_CLUSTER_TOKEN` must contain 32–256 printable ASCII characters without whitespace. Missing or malformed tokens stop startup. Do not commit the token.

## Start HQ and workers

Windows, in the HQ terminal:

```powershell
$env:BORROWED_SKY_CLUSTER_TOKEN = 'paste-the-generated-token-here'
.\.venv\Scripts\python.exe -m backend.main --role hq
```

Windows, in a separate terminal on each worker:

```powershell
$env:BORROWED_SKY_CLUSTER_TOKEN = 'paste-the-same-generated-token-here'
.\.venv\Scripts\python.exe -m backend.main --role worker --hq 192.168.1.10
```

Linux/macOS, in the HQ terminal:

```sh
export BORROWED_SKY_CLUSTER_TOKEN='paste-the-generated-token-here'
.venv/bin/python -m backend.main --role hq
```

Linux/macOS, in a separate terminal on each worker:

```sh
export BORROWED_SKY_CLUSTER_TOKEN='paste-the-same-generated-token-here'
.venv/bin/python -m backend.main --role worker --hq 192.168.1.10
```

Replace `192.168.1.10` with HQ's LAN address; use `127.0.0.1` for a local worker. HQ listens on TCP port **5050** on all interfaces. `--port` changes that port and must match on both sides. Allow that port only on the intended private network if the host firewall requires it. The HTTP API listens separately on **127.0.0.1:8080**, on HQ only.

This prototype uses a shared cluster token, with no TLS and no browser CORS access. Use a trusted LAN or local machine; do not expose it directly to the internet. Anyone with the token can submit jobs and participate as a worker. The token is not a separate identity or permission level for each user, and reported hardware is not independently verified.

## Submit and inspect jobs

All HTTP requests require `Authorization: Bearer <cluster-token>`, including reads. In a third terminal **on HQ**, set the same environment variable and start the Python interpreter (`.\.venv\Scripts\python.exe` on Windows or `.venv/bin/python` on Linux/macOS). Paste this standard-library example:

```python
import json
import os
from urllib.request import Request, urlopen

def api(path, data=None):
    body = None if data is None else json.dumps(data).encode("utf-8")
    request = Request(
        "http://127.0.0.1:8080" + path,
        data=body,
        headers={
            "Authorization": "Bearer " + os.environ["BORROWED_SKY_CLUSTER_TOKEN"],
            "Content-Type": "application/json",
        },
    )
    with urlopen(request, timeout=5) as response:
        return json.load(response)

print(api("/api/status"))
print(api("/api/devices"))

sum_job = api("/api/tasks", {
    "task_type": "SUM_RANGE",
    "payload": {"start": 1, "end": 1000000},
    "cpu_cores": 1,
    "memory_mb": 128,
})["task"]
prime_job = api("/api/tasks", {
    "task_type": "COUNT_PRIMES",
    "payload": {"start": 1, "end": 100000},
})["task"]

print(api("/api/tasks/" + sum_job["task_id"]))
print(api("/api/tasks/" + prime_job["task_id"]))
print(api("/api/tasks"))
```

Submission returns HTTP 202 for accepted work. Poll the individual task endpoint until its status is `COMPLETED`, `FAILED` or `CANCELLED`; accepted work may still be `PENDING` when no free worker has enough reported capacity. The expected results above are `500000500000` and `9592`. `cpu_cores` and `memory_mb` default to 1 and 128. They are scheduling reservations, not enforced OS resource limits or a promise to use multiple cores. Memory values are in MiB despite the historical `_mb` field names.

The API accepts bodies up to 64 KiB and validates task fields, integer endpoints and finite positive resource requests. It rejects unknown task types and unreasonable workloads:

| Task | Inclusive range limits |
| --- | --- |
| `SUM_RANGE` | At most 10,000,000 integers; each endpoint within ±1,000,000,000,000. |
| `COUNT_PRIMES` | At most 500,000 integers; each endpoint within ±1,000,000,000; additionally `(end - start + 1) * isqrt(max(0, end)) <= 500,000,000`. |

Both endpoints must be integers, with `start <= end`. The prime computation budget is a conservative work bound, not a wall-time estimate. These checks run at both coordinator and worker.

## Identity, resources and recovery

- The worker stores a random UUID in `~/.dcp/device_id` and makes a fresh session UUID per process. Reconnect by restarting the worker; it does not automatically reconnect. Multiple processes under the same home directory share a device record while retaining independent sessions. This is a saved label, not proof of a unique physical laptop.
- Resource reports include logical/physical core counts, OS/architecture, total/available RAM and a sampled CPU percentage when available. The GPU field is currently a placeholder, not GPU detection. Missing or invalid capacity is unavailable for scheduling. A fully disconnected device must report fresh capacity when it returns.
- Each worker process has **one active job**. The registry avoids counting multiple sessions' shared device resources more than once, and reserves capacity before dispatch. Reports remain estimates; reservations do not sandbox execution or measure speedup.
- Workers send heartbeats every 5 seconds and resource updates every 15 seconds. A closed connection recovers unfinished work immediately; 15 seconds with no received activity closes an unresponsive connection. Every assignment also expires after 300 seconds even if heartbeats continue, so a stuck computation cannot hold work forever.
- Dispatch, acknowledgement and result acceptance bind a job to its device ID, session ID and unique assignment token. Late results from an expired, replaced or disconnected session cannot complete the recovered assignment.
- Disconnect/timeout recovery releases reservations, returns work to `PENDING` and schedules it on an available worker. Each job has at most **3 assignment attempts total**, then becomes `FAILED`. An explicit worker execution error becomes `FAILED` rather than retrying indefinitely.

To demonstrate recovery, start two workers, submit several `COUNT_PRIMES` jobs, inspect their assigned sessions, then stop an assigned worker with Ctrl+C before it finishes. Watch `recoveries`, `attempts`, assignment and status through `/api/tasks`. Small jobs may finish before the interruption. Work waits if no other eligible worker is available. Restart the stopped worker to reuse it; a new session cannot upload results from its previous assignment.

HQ keeps at most **128 device records**, **32 concurrent sessions per device**, and **1,000 task records**. Completed tasks and offline devices remain in memory until HQ restarts. Save needed results before restarting to clear history; all coordinator state is lost on restart. Workers must then be restarted to reconnect. Persistent device IDs are the only state saved by this prototype.

## Tests and limitations

Windows:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
node --test
```

Linux/macOS:

```sh
.venv/bin/python -m pytest -q
node --test
```

Python CI runs on Ubuntu and Windows with Python 3.12; existing Node CI is retained. Tests cover registration and validation, socket framing/authentication, task ownership, bounded workloads, worker execution, reconnection and real local TCP/HTTP recovery. Local automated tests are not evidence of physical multi-laptop operation. Before presenting, test firewall/Wi-Fi access, worker termination and recovery on the actual laptops.

There is no durable job storage, automatic worker reconnect, GPU execution, general-purpose code execution, browser integration or verified performance gain. The original Python branch can remain a separate experiment; these repairs do not require merging its frontend or replacing Borrowed Sky's Node coordinator.
