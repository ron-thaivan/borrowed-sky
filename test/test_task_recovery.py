"""Assignment ownership, capacity and recovery regressions without live sockets."""
import json
import unittest
from concurrent.futures import ThreadPoolExecutor

from backend.coordinator.connection_manager import WorkerConnectionManager
from backend.coordinator.registry import DeviceRegistry
from backend.coordinator.resource_manager import ResourceManager
from backend.coordinator.scheduler import Scheduler
from backend.coordinator.task_manager import TaskManager
from backend.coordinator.task_service import TaskService


class RecordingSocket:
    def __init__(self, fail=False):
        self.fail = fail
        self.messages = []
        self.closed = False

    def sendall(self, data):
        if self.fail or self.closed:
            raise ConnectionError("Test connection closed")
        self.messages.append(json.loads(data[4:]))

    def shutdown(self, how):
        self.closed = True

    def close(self):
        self.closed = True


class TaskRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.clock = [1000.0]
        self.registry = DeviceRegistry()
        self.resources = ResourceManager(self.registry)
        self.tasks = TaskManager(now=lambda: self.clock[0])
        self.connections = WorkerConnectionManager()
        self.scheduler = Scheduler(self.tasks, self.resources)
        self.service = TaskService(self.tasks, self.scheduler, self.resources, self.connections)

    def worker(self, device="device-a", session="session-a", fail=False, report=True):
        connection = RecordingSocket(fail)
        self.connections.register_connection(device, session, connection)
        self.registry.register_device(device, session, device)
        if report:
            self.registry.update_resources(device, session, {
                "logical_cores": 8, "physical_cores": 4, "cpu_percent": 0,
                "total_memory_mb": 16384, "available_memory_mb": 8192,
            })
        return connection

    def submit(self):
        return self.service.submit_task("SUM_RANGE", {"start": 1, "end": 10})

    def message(self, task, kind, **extra):
        payload = {"task_id": task["task_id"], "assignment_token": task["assignment_token"], **extra}
        return self.service.handle_worker_message(task["assigned_device"], task["assigned_session"], kind, payload)

    def complete(self, task):
        self.message(task, "JOB_ACCEPTED")
        return self.message(task, "JOB_RESULT", result=55)

    def test_worker_outcomes_require_current_device_session_and_token(self):
        connection = self.worker()
        task = self.submit()
        sent = connection.messages[-1]
        self.assertEqual(sent["message_type"], "JOB_SUBMIT")
        self.assertEqual(sent["payload"]["assignment_token"], task["assignment_token"])
        payload = {"task_id": task["task_id"], "assignment_token": task["assignment_token"]}
        for device, session, token in [
            ("device-b", "session-a", task["assignment_token"]),
            ("device-a", "session-b", task["assignment_token"]),
            ("device-a", "session-a", "forged-token"),
            ("device-a", "session-a", None),
        ]:
            with self.subTest(device=device, session=session, token=token):
                for kind in ("JOB_ACCEPTED", "JOB_RESULT", "JOB_FAILED", "JOB_CANCELLED"):
                    with self.assertRaises(ValueError):
                        self.service.handle_worker_message(device, session, kind, {**payload, "assignment_token": token})
        with self.assertRaises(ValueError):
            self.message(task, "JOB_RESULT", result=55)
        self.message(task, "JOB_ACCEPTED")
        with self.assertRaises(ValueError):
            self.message(task, "JOB_ACCEPTED")
        for invalid in (False, "55", 54):
            with self.assertRaises(ValueError):
                self.message(task, "JOB_RESULT", result=invalid)
        completed = self.message(task, "JOB_RESULT", result=55)
        self.assertEqual(completed["status"], "COMPLETED")
        self.assertIsNone(completed["assignment_token"])
        self.assertEqual(self.resources.reservations, {})
        with self.assertRaises(ValueError):
            self.message(task, "JOB_RESULT", result=55)

    def test_disconnect_recovers_exact_session_while_sibling_stays_online(self):
        first_connection = self.worker()
        self.worker("device-a", "session-b")
        first, sibling = self.submit(), self.submit()
        self.assertEqual({first["assigned_session"], sibling["assigned_session"]}, {"session-a", "session-b"})
        self.assertEqual(self.service.handle_worker_disconnect("device-a", "session-a"), [first["task_id"]])
        self.assertTrue(first_connection.closed)
        self.assertEqual(self.registry.snapshot()[0]["status"], "online")
        self.assertEqual(self.registry.snapshot()[0]["active_sessions"], 1)
        self.assertEqual(self.tasks.get_task(first["task_id"])["status"], "PENDING")
        self.assertEqual(self.tasks.get_task(sibling["task_id"])["assignment_token"], sibling["assignment_token"])
        self.complete(sibling)
        retry = self.tasks.get_task(first["task_id"])
        self.assertEqual(retry["assigned_session"], "session-b")
        self.assertEqual(retry["attempts"], 2)
        self.assertEqual(retry["recoveries"], 1)
        self.assertNotEqual(retry["assignment_token"], first["assignment_token"])
        with self.assertRaises(ValueError):
            self.message(first, "JOB_ACCEPTED")
        self.assertEqual(self.complete(retry)["status"], "COMPLETED")
        self.assertEqual(self.resources.reservations, {})

    def test_disconnect_reassigns_to_other_device_and_rejects_late_result(self):
        self.worker()
        original = self.submit()
        self.message(original, "JOB_ACCEPTED")
        self.worker("device-b", "session-b")
        self.service.handle_worker_disconnect("device-a", "session-a")
        replacement = self.tasks.get_task(original["task_id"])
        self.assertEqual(replacement["assigned_device"], "device-b")
        self.assertNotEqual(replacement["assignment_token"], original["assignment_token"])
        with self.assertRaises(ValueError):
            self.message(original, "JOB_RESULT", result=55)
        self.assertEqual(self.tasks.get_task(original["task_id"])["assignment_token"], replacement["assignment_token"])
        self.assertEqual(self.complete(replacement)["result"], 55)

    def test_repeated_disconnect_stops_at_attempt_limit(self):
        self.worker()
        task = self.submit()
        for attempt in range(1, 4):
            current = self.tasks.get_task(task["task_id"])
            self.assertEqual(current["attempts"], attempt)
            self.service.handle_worker_disconnect(current["assigned_device"], current["assigned_session"])
            if attempt < 3:
                self.worker("device-a", f"retry-{attempt}")
                self.service.schedule_available()
        failed = self.tasks.get_task(task["task_id"])
        self.assertEqual(failed["status"], "FAILED")
        self.assertEqual(failed["recoveries"], 3)
        self.assertIn("Retry limit", failed["error"])
        self.assertIsNone(failed["assignment_token"])
        self.assertEqual(self.resources.reservations, {})

    def test_assignment_deadline_retires_stuck_worker_despite_heartbeats(self):
        stuck = self.worker()
        task = self.submit()
        self.message(task, "JOB_ACCEPTED")
        self.worker("device-b", "session-b")
        self.registry.record_heartbeat("device-a", "session-a")
        self.clock[0] = task["assignment_expires_at"]
        self.assertEqual(self.service.expire_assignments(), [task["task_id"]])
        self.assertTrue(stuck.closed)
        self.assertEqual(self.connections.get_sessions("device-a"), [])
        retry = self.tasks.get_task(task["task_id"])
        self.assertEqual(retry["assigned_device"], "device-b")
        self.assertEqual(retry["last_recovery"], "Assignment timed out")
        with self.assertRaises(ValueError):
            self.message(task, "JOB_RESULT", result=55)
        self.assertEqual(self.complete(retry)["status"], "COMPLETED")

    def test_failed_dispatch_retires_socket_and_registry_before_retry(self):
        broken = self.worker(fail=True)
        healthy = self.worker("device-b", "session-b")
        task = self.submit()
        self.assertTrue(broken.closed)
        self.assertEqual(self.connections.get_sessions("device-a"), [])
        device = next(d for d in self.registry.snapshot() if d["device_id"] == "device-a")
        self.assertEqual(device["status"], "offline")
        self.assertEqual(task["assigned_device"], "device-b")
        self.assertEqual(task["attempts"], 2)
        self.assertEqual(len(healthy.messages), 1)
        self.assertNotIn("device-a", self.resources.reservations)
        self.complete(task)

    def test_stale_outcome_that_detects_expiry_still_dispatches_recovered_work(self):
        self.worker()
        task = self.submit()
        self.message(task, "JOB_ACCEPTED")
        self.worker("device-b", "session-b")
        self.clock[0] = task["assignment_expires_at"]
        with self.assertRaises(ValueError):
            self.message(task, "JOB_RESULT", result=55)
        retry = self.tasks.get_task(task["task_id"])
        self.assertEqual(retry["status"], "SCHEDULED")
        self.assertEqual(retry["assigned_device"], "device-b")
        self.assertEqual(self.complete(retry)["status"], "COMPLETED")

    def test_simultaneous_submissions_use_one_slot_per_session(self):
        self.worker()
        self.worker("device-a", "session-b")
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda _: self.submit(), range(12)))
        self.assertEqual(len({t["task_id"] for t in results}), 12)
        active = [t for t in self.tasks.list_tasks() if t["status"] == "SCHEDULED"]
        self.assertEqual(len(active), 2)
        self.assertEqual(len({t["assignment_token"] for t in active}), 2)
        self.assertEqual(len(self.resources.reservations["device-a"]), 2)
        for _ in range(12):
            active = [t for t in self.tasks.list_tasks() if t["status"] == "SCHEDULED"]
            self.assertGreater(len(active), 0)
            self.complete(active[0])
        self.assertTrue(all(t["status"] == "COMPLETED" for t in self.tasks.list_tasks()))
        self.assertEqual(self.resources.reservations, {})

    def test_reconnect_needs_fresh_resources_and_old_cleanup_cannot_retire_it(self):
        original = self.worker()
        task = self.submit()
        self.service.handle_worker_disconnect("device-a", "session-a")
        replacement = self.worker(report=False)
        with self.service.lock:
            if self.connections.matches_connection("device-a", "session-a", original):
                self.service.handle_worker_disconnect("device-a", "session-a")
        self.assertTrue(self.connections.matches_connection("device-a", "session-a", replacement))
        self.service.schedule_available()
        self.assertEqual(self.tasks.get_task(task["task_id"])["status"], "PENDING")
        self.registry.update_resources("device-a", "session-a", {
            "logical_cores": 8, "cpu_percent": 0, "available_memory_mb": 8192,
        })
        self.service.schedule_available()
        self.assertEqual(self.tasks.get_task(task["task_id"])["status"], "SCHEDULED")
        self.assertFalse(replacement.closed)

    def test_failures_and_cancellations_release_capacity_and_schedule_next(self):
        self.worker()
        for outcome in ("JOB_FAILED", "JOB_CANCELLED"):
            first, next_task = self.submit(), self.submit()
            ended = self.message(first, outcome, error="Example execution failure")
            self.assertIn(ended["status"], {"FAILED", "CANCELLED"})
            self.assertIsNone(ended["assignment_token"])
            next_task = self.tasks.get_task(next_task["task_id"])
            self.assertEqual(next_task["status"], "SCHEDULED")
            self.complete(next_task)
        self.assertEqual(self.resources.reservations, {})

    def test_task_history_and_resource_requirements_are_bounded(self):
        limited = TaskManager(max_tasks=1)
        task = limited.create_task("SUM_RANGE", {"start": -10, "end": 10})
        task["payload"]["start"] = 999
        self.assertEqual(limited.get_task(task["task_id"])["payload"]["start"], -10)
        with self.assertRaises(ValueError):
            limited.create_task("SUM_RANGE", {"start": 1, "end": 2})
        for value in (True, 0, -1, float("nan"), float("inf"), 10 ** 1000, 1025):
            with self.subTest(value=str(value)[:20]):
                with self.assertRaises(ValueError):
                    self.tasks.create_task("SUM_RANGE", {"start": 1, "end": 2}, cpu_cores=value)


if __name__ == "__main__":
    unittest.main()
