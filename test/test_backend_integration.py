"""Real loopback TCP/HTTP tests; these do not claim physical multi-laptop testing."""
import http.client
import json
import socket
import threading
import time
import unittest
import uuid
from unittest.mock import patch

from backend.common.auth import load_token, matches_token
from backend.common.protocol import ProtocolError, create_message, receive_message, send_message
from backend.coordinator.api import MAX_REQUEST_SIZE, start_api
from backend.coordinator.main import HQServer
from backend.worker.main import collect_resources
from backend.worker.runtime import run_worker_loop

TOKEN = 'integration-test-' + 'a' * 32
RESOURCES = {'logical_cores': 8, 'physical_cores': 4, 'cpu_percent': 0,
             'total_memory_mb': 16000, 'available_memory_mb': 8000}


class BackendIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.hq = HQServer(('127.0.0.1', 0), token=TOKEN)
        self.server_thread = threading.Thread(target=self.hq.serve_forever,
                                              kwargs={'poll_interval': .02}, daemon=True)
        self.server_thread.start()
        self.api = start_api(self.hq, port=0)
        self.sockets = []
        self.workers = []
        self.worker_errors = []

    @staticmethod
    def close(connection):
        try:
            connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        connection.close()

    def tearDown(self):
        for connection in self.sockets:
            self.close(connection)
        for thread in self.workers:
            thread.join(3)
            self.assertFalse(thread.is_alive(), 'Worker failed to stop')
        self.api.shutdown()
        self.api.server_close()
        self.hq.shutdown()
        self.hq.server_close()
        self.server_thread.join(3)
        self.assertEqual(self.worker_errors, [])

    def wait_for(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(.01)
        self.fail('Timed out waiting for coordinator state')

    def request(self, method, path, data=None, token=TOKEN, raw=None, headers=None):
        connection = http.client.HTTPConnection(*self.api.server_address, timeout=3)
        body = raw if raw is not None else (None if data is None else json.dumps(data))
        request_headers = {'Content-Type': 'application/json'}
        if token is not None:
            request_headers['Authorization'] = 'Bearer ' + token
        request_headers.update(headers or {})
        try:
            connection.request(method, path, body, request_headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read()), dict(response.getheaders())
        finally:
            connection.close()

    def connect(self, device=None, session=None, resources=RESOURCES):
        device, session = device or str(uuid.uuid4()), session or str(uuid.uuid4())
        connection = socket.create_connection(self.hq.server_address, timeout=3)
        self.sockets.append(connection)
        send_message(connection, create_message('REGISTER', device, session,
                     {'role': 'worker', 'hostname': 'Test contributor', 'token': TOKEN}))
        self.assertTrue(receive_message(connection)['payload']['accepted'])
        send_message(connection, create_message('RESOURCE_REPORT', device, session, resources))
        self.wait_for(lambda: any(d['device_id'] == device and d['resources'] == resources
                                  for d in self.hq.registry.snapshot()))
        return connection, device, session

    def execute_on(self, worker):
        connection, device, session = worker

        def run():
            try:
                run_worker_loop(connection, device, session, lambda: RESOURCES.copy())
            except (OSError, ConnectionError):
                pass  # Test shutdown closes the worker's connection.
            except Exception as error:
                self.worker_errors.append(error)

        thread = threading.Thread(target=run, daemon=True)
        self.workers.append(thread)
        thread.start()

    def submit(self, kind='SUM_RANGE', start=1, end=1000000):
        status, body, _ = self.request('POST', '/api/tasks',
            {'task_type': kind, 'payload': {'start': start, 'end': end}})
        self.assertEqual(status, 202, body)
        self.assertNotIn('assignment_token', body['task'])
        return body['task']['task_id']

    def completed(self, task_id):
        # Observe completion together with resource release, not midway through it.
        with self.hq.task_service.lock:
            task = self.hq.task_manager.get_task(task_id)
            return task if task['status'] == 'COMPLETED' else None

    def test_real_workers_execute_both_task_types_over_http_and_tcp(self):
        first, second = self.connect(), self.connect()
        # Queue both before starting the runtimes, guaranteeing two distinct slots.
        sum_id = self.submit()
        prime_id = self.submit('COUNT_PRIMES', end=40000)
        self.execute_on(first)
        self.execute_on(second)
        summed = self.wait_for(lambda: self.completed(sum_id))
        primes = self.wait_for(lambda: self.completed(prime_id))
        self.assertEqual(summed['result'], 500000500000)
        self.assertEqual(primes['result'], 4203)
        self.assertNotEqual(summed['assigned_device'], primes['assigned_device'])
        self.assertEqual(self.hq.resource_manager.reservations, {})
        status, body, _ = self.request('GET', '/api/tasks')
        self.assertEqual(status, 200)
        self.assertTrue(all('assignment_token' not in task for task in body['tasks']))

    def test_disconnect_requeues_and_new_worker_executes_with_fresh_token(self):
        worker = self.connect()
        connection, device, session = worker
        task_id = self.submit('COUNT_PRIMES', end=10000)
        old = receive_message(connection)['payload']
        send_message(connection, create_message('JOB_ACCEPTED', device, session,
                     {'task_id': task_id, 'assignment_token': old['assignment_token']}))
        self.wait_for(lambda: self.hq.task_manager.get_task(task_id)['status'] == 'RUNNING')
        self.close(connection)
        self.wait_for(lambda: self.hq.task_manager.get_task(task_id)['status'] == 'PENDING')
        replacement = self.connect()
        current = self.hq.task_manager.get_task(task_id)
        self.assertNotEqual(current['assignment_token'], old['assignment_token'])
        with self.assertRaisesRegex(ValueError, 'Stale'):
            self.hq.task_service.handle_worker_message(device, session, 'JOB_RESULT',
                {'task_id': task_id, 'assignment_token': old['assignment_token'], 'result': 1229})
        self.execute_on(replacement)
        recovered = self.wait_for(lambda: self.completed(task_id))
        self.assertEqual((recovered['result'], recovered['attempts'], recovered['recoveries']), (1229, 2, 1))
        self.assertEqual(self.hq.resource_manager.reservations, {})

    def test_wrong_worker_cannot_acknowledge_or_complete_an_assignment(self):
        # Scheduler ties sort by device ID; make ownership intentional here.
        owner, other = self.connect(device='device-a'), self.connect(device='device-b')
        task_id = self.submit()
        job = receive_message(owner[0])['payload']
        for kind in ('JOB_ACCEPTED', 'JOB_RESULT'):
            send_message(other[0], create_message(kind, other[1], other[2],
                {'task_id': task_id, 'assignment_token': job['assignment_token'], 'result': 500000500000}))
        # A subsequent resource report acts as a processing barrier on that socket.
        changed = dict(RESOURCES, cpu_percent=1)
        send_message(other[0], create_message('RESOURCE_UPDATE', other[1], other[2], {'resources': changed}))
        self.wait_for(lambda: any(d['device_id'] == other[1] and d['resources'] == changed
                                  for d in self.hq.registry.snapshot()))
        self.assertEqual(self.hq.task_manager.get_task(task_id)['status'], 'SCHEDULED')
        # Feed the consumed assignment back through the real worker runtime.
        self.hq.connection_manager.send_to_session(owner[1], owner[2], 'JOB_SUBMIT', job)
        self.execute_on(owner)
        self.wait_for(lambda: self.completed(task_id))

    def test_missing_heartbeat_recovers_without_explicit_disconnect(self):
        self.hq.heartbeat_timeout = .2
        worker = self.connect()
        task_id = self.submit()
        receive_message(worker[0])
        self.wait_for(lambda: self.hq.task_manager.get_task(task_id)['recoveries'] == 1)
        self.assertEqual(self.hq.task_manager.get_task(task_id)['status'], 'PENDING')
        self.assertEqual(self.hq.connection_manager.get_connected_devices(), [])
        self.assertEqual(self.hq.resource_manager.reservations, {})

    def test_periodic_assignment_deadline_recovers_a_heartbeating_stuck_worker(self):
        self.hq.task_manager.assignment_timeout = .4
        connection, device, session = self.connect()
        task_id = self.submit()
        old = receive_message(connection)['payload']
        send_message(connection, create_message('JOB_ACCEPTED', device, session,
                     {'task_id': task_id, 'assignment_token': old['assignment_token']}))
        stop = threading.Event()
        heartbeats = []

        def heartbeat():
            while not stop.wait(.03):
                try:
                    send_message(connection, create_message('HEARTBEAT', device, session, {}))
                    heartbeats.append(1)
                except OSError:
                    return

        thread = threading.Thread(target=heartbeat, daemon=True)
        thread.start()
        try:
            # No direct expire_assignments call: the running HQ must notice expiry.
            self.wait_for(lambda: self.hq.task_manager.get_task(task_id)['recoveries'] == 1)
        finally:
            stop.set()
            thread.join(3)
        self.assertGreater(len(heartbeats), 1)
        self.assertEqual(self.hq.task_manager.get_task(task_id)['status'], 'PENDING')
        self.assertEqual(self.hq.connection_manager.get_connected_devices(), [])
        self.hq.task_manager.assignment_timeout = 5
        replacement = self.connect()
        self.execute_on(replacement)
        result = self.wait_for(lambda: self.completed(task_id))
        self.assertEqual((result['result'], result['attempts'], result['recoveries']), (500000500000, 2, 1))

    def test_worker_registration_requires_authentication_and_duplicate_is_safe(self):
        original = self.connect()
        for token in ('wrong', None):
            connection = socket.create_connection(self.hq.server_address, timeout=2)
            self.sockets.append(connection)
            send_message(connection, create_message('REGISTER', 'attacker', str(uuid.uuid4()),
                {'role': 'worker', 'hostname': 'Unknown', 'token': token}))
            with self.assertRaises((ConnectionError, OSError, ProtocolError)):
                receive_message(connection)
        duplicate = socket.create_connection(self.hq.server_address, timeout=2)
        self.sockets.append(duplicate)
        send_message(duplicate, create_message('REGISTER', original[1], original[2],
            {'role': 'worker', 'hostname': 'Duplicate', 'token': TOKEN}))
        with self.assertRaises((ConnectionError, OSError, ProtocolError)):
            receive_message(duplicate)
        self.assertEqual(self.hq.connection_manager.get_connected_devices(), [original[1]])
        task_id = self.submit()
        self.execute_on(original)
        self.wait_for(lambda: self.completed(task_id))

    def test_api_authentication_and_malformed_input(self):
        for method, path in [('GET', '/api/status'), ('GET', '/api/tasks'), ('POST', '/api/tasks')]:
            self.assertEqual(self.request(method, path, token=None)[0], 401)
            self.assertEqual(self.request(method, path, token='wrong')[0], 401)
        self.assertEqual(self.request('OPTIONS', '/api/tasks')[0], 403)
        for raw in ('[]', '{', '{"cpu_cores":NaN}', '{"task_type":[],"payload":{}}',
                    '{"task_type":"SUM_RANGE","payload":{"start":true,"end":10}}'):
            self.assertEqual(self.request('POST', '/api/tasks', raw=raw)[0], 400)
        for length in ('bad', '-1', '9' * 5000):
            self.assertEqual(self.request('POST', '/api/tasks', raw='', headers={'Content-Length': length})[0], 400)
        self.assertEqual(self.request('POST', '/api/tasks', raw='',
                         headers={'Content-Length': str(MAX_REQUEST_SIZE + 1)})[0], 413)
        self.assertEqual(self.request('POST', '/api/tasks', raw='')[0], 413)
        self.assertEqual(self.hq.task_manager.list_tasks(), [])
        self.assertEqual(self.request('GET', '/api/status')[0], 200)

    def test_resource_report_from_actual_host_is_supported(self):
        from backend.coordinator.registry import validate_resources
        resources = collect_resources()
        self.assertEqual(validate_resources(resources), resources)


class AuthConfigurationTests(unittest.TestCase):
    def test_explicit_configuration_and_constant_time_comparison(self):
        with patch.dict('os.environ', {}, clear=True):
            with self.assertRaises(ValueError):
                load_token()
        for token in ('short', 'a' * 257, 'é' * 32, 'a' * 32 + '\n', 100):
            with self.assertRaises(ValueError):
                load_token(token)
        self.assertEqual(load_token(TOKEN), TOKEN)
        self.assertTrue(matches_token(TOKEN, TOKEN))
        self.assertFalse(matches_token(TOKEN, 'wrong'))
        self.assertFalse(matches_token(TOKEN, None))


if __name__ == '__main__':
    unittest.main()
