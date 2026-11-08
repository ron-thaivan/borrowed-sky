"""Regression tests for bounded installed-worker execution and wire behavior."""
import contextlib
import socket
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from backend.common.protocol import ProtocolError, create_message, receive_message, send_message
from backend.common.workload import validate_workload
from backend.worker import runtime
from backend.worker.executor import TaskCancelled, execute_task, is_prime


class WorkerSafetyTests(unittest.TestCase):
    def test_correct_results_and_shared_limits(self):
        event = threading.Event()
        self.assertEqual(execute_task("COUNT_PRIMES", {"start": 1, "end": 300000}, event), 25997)
        self.assertEqual(execute_task("SUM_RANGE", {"start": 1, "end": 1000000}, event), 500000500000)
        self.assertEqual(execute_task("SUM_RANGE", {"start": -8, "end": 5}, event), sum(range(-8, 6)))
        invalid = [
            ("COUNT_PRIMES", {"start": 10**100, "end": 10**100}),
            ("COUNT_PRIMES", {"start": 999500001, "end": 1000000000}),
            ("COUNT_PRIMES", {"start": 1, "end": 500001}),
            ("SUM_RANGE", {"start": -10**13, "end": -10**13}),
            ("SUM_RANGE", {"start": 0, "end": 10000000}),
            ("SUM_RANGE", {"start": True, "end": 5}),
            ("SUM_RANGE", {"start": 0.5, "end": 5}),
            ("SUM_RANGE", {"start": 10, "end": 5}),
            ("SUM_RANGE", {"start": 0, "end": 5, "extra": 1}),
            ("UNKNOWN", {"start": 0, "end": 5}),
            ([], {"start": 0, "end": 5}),
        ]
        for kind, payload in invalid:
            with self.subTest(kind=kind, payload=payload):
                with self.assertRaises(ValueError):
                    validate_workload(kind, payload)
                with self.assertRaises(ValueError):
                    execute_task(kind, payload, event)

    def test_cancellation_inside_a_number_and_before_small_ranges(self):
        event = threading.Event()
        event.set()
        for kind in ("SUM_RANGE", "COUNT_PRIMES"):
            with self.assertRaises(TaskCancelled):
                execute_task(kind, {"start": 3, "end": 31}, event)

        class CancelDuringDivision:
            calls = 0

            def is_set(self):
                self.calls += 1
                return self.calls >= 3

        during = CancelDuringDivision()
        with self.assertRaises(TaskCancelled):
            is_prime(999999937, during)
        self.assertEqual(during.calls, 3)

    def test_saved_identity_is_reused_and_corruption_is_explicit(self):
        from backend.worker.main import load_device_id
        with tempfile.TemporaryDirectory() as folder:
            first = load_device_id(folder)
            self.assertEqual(load_device_id(folder), first)
            Path(folder, 'device_id').write_text('broken')
            with self.assertRaisesRegex(ValueError, 'invalid'):
                load_device_id(folder)

    def test_concurrent_first_starts_share_one_complete_identity(self):
        from backend.worker import main as worker_main
        barrier = threading.Barrier(8)
        original_link = worker_main.os.link

        def publish_together(source, target):
            barrier.wait(timeout=5)
            original_link(source, target)

        with tempfile.TemporaryDirectory() as folder:
            with patch.object(worker_main.os, 'link', side_effect=publish_together):
                with ThreadPoolExecutor(max_workers=8) as executor:
                    identities = list(executor.map(lambda _: worker_main.load_device_id(folder), range(8)))
            self.assertEqual(len(set(identities)), 1)
            self.assertEqual(worker_main.load_device_id(folder), identities[0])
            self.assertEqual([item.name for item in Path(folder).iterdir()], ['device_id'])

    @contextlib.contextmanager
    def running_worker(self, probe=lambda: {}, executor=None):
        # Windows emulates socketpair with a listener that has no timeout.
        # An explicit local pair fails promptly when loopback is unavailable.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.settimeout(3)
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            hq = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            hq.settimeout(3)
            try:
                hq.connect(listener.getsockname())
                worker, _ = listener.accept()
            except BaseException:
                hq.close()
                raise
        errors = []
        patches = {"HEARTBEAT_INTERVAL": .03, "RESOURCE_UPDATE_INTERVAL": .03, "MESSAGE_TIMEOUT": .15}
        if executor:
            patches['execute_task'] = executor

        def run():
            try:
                runtime.run_worker_loop(worker, 'device', 'session', probe)
            except (ConnectionError, OSError, ProtocolError) as error:
                errors.append(error)
            finally:
                worker.close()

        with patch.multiple(runtime, **patches):
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            try:
                yield hq, thread, errors
            finally:
                try:
                    hq.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                hq.close()
                thread.join(3)
                self.assertFalse(thread.is_alive(), 'Worker must cancel active computation on disconnect')

    def send(self, hq, kind='JOB_SUBMIT', ident='task', token='lease', payload=None, session='session'):
        body = {'task_id': ident, 'assignment_token': token}
        if kind == 'JOB_SUBMIT':
            body.update(task_type='SUM_RANGE', task_payload=payload or {'start': 1, 'end': 10})
        send_message(hq, create_message(kind, 'hq', session, body))

    def until(self, hq, kind):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            message = receive_message(hq)
            if message['message_type'] == kind:
                return message['payload']
        self.fail('No ' + kind + ' received')

    def test_results_echo_assignment_and_invalid_job_does_not_stop_heartbeats(self):
        with self.running_worker() as (hq, _, _):
            self.send(hq)
            self.assertEqual(self.until(hq, 'JOB_ACCEPTED'), {'task_id': 'task', 'assignment_token': 'lease'})
            self.assertEqual(self.until(hq, 'JOB_RESULT')['result'], 55)
            self.send(hq, ident='invalid', payload={'start': True, 'end': 2})
            failed = self.until(hq, 'JOB_FAILED')
            self.assertEqual(failed['task_id'], 'invalid')
            self.assertEqual(failed['assignment_token'], 'lease')
            self.until(hq, 'HEARTBEAT')
            self.send(hq, ident='next', token='new-lease')
            self.until(hq, 'JOB_ACCEPTED')
            self.assertEqual(self.until(hq, 'JOB_RESULT')['assignment_token'], 'new-lease')

    def test_resource_probe_failure_keeps_worker_alive(self):
        probes = []

        def broken_probe():
            probes.append(1)
            raise RuntimeError('Hardware API unavailable')

        with self.running_worker(probe=broken_probe) as (hq, _, _):
            self.until(hq, 'HEARTBEAT')
            self.until(hq, 'HEARTBEAT')
            self.assertTrue(probes)
            self.send(hq)
            self.assertEqual(self.until(hq, 'JOB_RESULT')['result'], 55)

    def test_busy_duplicate_and_stale_cancellation_cannot_affect_current_task(self):
        starts = []

        def held_task(kind, payload, event):
            starts.append(1)
            event.wait(2)
            if event.is_set():
                raise TaskCancelled()
            raise RuntimeError('Test cancellation did not arrive')

        with self.running_worker(executor=held_task) as (hq, _, _):
            self.send(hq)
            self.until(hq, 'JOB_ACCEPTED')
            self.send(hq)  # Duplicate must not execute or fail this task.
            self.send(hq, ident='second', token='other')
            self.assertEqual(self.until(hq, 'JOB_FAILED')['task_id'], 'second')
            self.send(hq, kind='JOB_CANCEL', token='stale')
            self.until(hq, 'HEARTBEAT')
            self.assertEqual(starts, [1])
            self.send(hq, kind='JOB_CANCEL')
            cancelled = self.until(hq, 'JOB_CANCELLED')
            self.assertEqual(cancelled, {'task_id': 'task', 'assignment_token': 'lease', 'error': 'Task was cancelled'})

    def test_wrong_session_messages_and_partial_frames_close_connection(self):
        with self.running_worker() as (hq, thread, errors):
            self.send(hq, session='other-session')
            thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertIsInstance(errors[0], ProtocolError)
        with self.running_worker() as (hq, thread, errors):
            hq.sendall(b'\x00')
            thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertIsInstance(errors[0], TimeoutError)


if __name__ == '__main__':
    unittest.main()
