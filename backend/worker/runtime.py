"""One execution slot per connection; network heartbeats run independently."""
import queue
import select
import threading
import time
from concurrent.futures import CancelledError, ThreadPoolExecutor

from backend.common.protocol import ProtocolError, create_message, receive_message, send_message
from backend.common.workload import validate_workload
from backend.worker.executor import TaskCancelled, execute_task

HEARTBEAT_INTERVAL = 5
RESOURCE_UPDATE_INTERVAL = 15
MESSAGE_TIMEOUT = 5


def run_worker_loop(connection, device_id, session_id, collect_resources):
    executor = ThreadPoolExecutor(max_workers=1)
    completed_tasks = queue.Queue()
    # Never hide unbounded queued work behind the single execution thread.
    active = {}
    next_heartbeat = time.monotonic() + HEARTBEAT_INTERVAL
    next_resource_update = time.monotonic() + RESOURCE_UPDATE_INTERVAL
    connection.settimeout(MESSAGE_TIMEOUT)

    def send(message_type, payload):
        send_message(connection, create_message(message_type, device_id, session_id, payload))

    def collect(task_id, token, future):
        outcome = {"task_id": task_id, "assignment_token": token}
        try:
            outcome.update(message_type="JOB_RESULT", result=future.result())
        except (TaskCancelled, CancelledError):
            outcome.update(message_type="JOB_CANCELLED", error="Task was cancelled")
        except Exception as error:
            outcome.update(message_type="JOB_FAILED", error=str(error)[:500])
        completed_tasks.put(outcome)

    try:
        while True:
            now = time.monotonic()
            if now >= next_heartbeat:
                send("HEARTBEAT", {})
                next_heartbeat = now + HEARTBEAT_INTERVAL
            if now >= next_resource_update:
                # Temporary probe failures must not kill healthy workers.
                try:
                    resources = collect_resources()
                except Exception:
                    resources = None
                if isinstance(resources, dict):
                    send("RESOURCE_UPDATE", {"resources": resources})
                next_resource_update = now + RESOURCE_UPDATE_INTERVAL
            while True:
                try:
                    completed = completed_tasks.get_nowait()
                except queue.Empty:
                    break
                task_id = completed["task_id"]
                record = active.get(task_id)
                if record is None or record[0] != completed["assignment_token"]:
                    continue
                active.pop(task_id)
                message_type = completed.pop("message_type")
                send(message_type, completed)
            timeout = max(0, min(next_heartbeat - time.monotonic(),
                                 next_resource_update - time.monotonic(), .25))
            readable, _, _ = select.select([connection], [], [], timeout)
            if not readable:
                continue
            # Incomplete messages time out instead of blocking all heartbeats.
            message = receive_message(connection)
            if message["device_id"] != "hq" or message["session_id"] != session_id:
                raise ProtocolError("Coordinator message belongs to another session")
            message_type, payload = message["message_type"], message["payload"]
            if message_type == "ERROR":
                continue
            if message_type not in {"JOB_SUBMIT", "JOB_CANCEL"}:
                raise ProtocolError("Unexpected coordinator message")
            task_id, token = payload.get("task_id"), payload.get("assignment_token")
            if any(not isinstance(value, str) or not value or len(value) > 128
                   for value in (task_id, token)):
                raise ProtocolError("Assignment needs a task ID and token")
            if message_type == "JOB_CANCEL":
                record = active.get(task_id)
                if record is not None and record[0] == token:
                    record[1].set()
                continue
            if task_id in active and active[task_id][0] == token:
                # Duplicate delivery must not fail or execute a running task twice.
                continue
            try:
                task_payload = validate_workload(payload.get("task_type"), payload.get("task_payload"))
                if active:
                    raise ValueError("Worker session is busy")
            except ValueError as error:
                send("JOB_FAILED", {"task_id": task_id, "assignment_token": token, "error": str(error)[:500]})
                continue
            cancel_event = threading.Event()
            active[task_id] = (token, cancel_event)
            future = executor.submit(execute_task, payload["task_type"], task_payload, cancel_event)
            future.add_done_callback(lambda result, ident=task_id, lease=token: collect(ident, lease, result))
            # Results are drained after this ACK, including immediate SUM_RANGE results.
            send("JOB_ACCEPTED", {"task_id": task_id, "assignment_token": token})
    finally:
        for _, cancel_event in active.values():
            cancel_event.set()
        executor.shutdown(wait=True, cancel_futures=True)
