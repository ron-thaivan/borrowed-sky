"""Authenticated TCP coordinator for the separate Python workload prototype."""
import socketserver

from backend.common.auth import load_token, matches_token
from backend.common.protocol import create_message, receive_message, send_message, ProtocolError
from backend.coordinator.registry import DeviceRegistry
from backend.coordinator.resource_manager import ResourceManager
from backend.coordinator.connection_manager import WorkerConnectionManager
from backend.coordinator.task_manager import TaskManager
from backend.coordinator.scheduler import Scheduler
from backend.coordinator.task_service import TaskService
from backend.coordinator.api import start_api

HEARTBEAT_TIMEOUT = 15


class WorkerHandler(socketserver.BaseRequestHandler):
    def handle(self):
        connection = self.request
        coordinator = self.server
        registry = coordinator.registry
        connection.settimeout(coordinator.heartbeat_timeout)
        registered = False
        connection_added = False
        device_id = session_id = None
        try:
            registration = receive_message(connection)
            if registration['message_type'] != 'REGISTER':
                raise ProtocolError('First message must be REGISTER')
            payload = registration['payload']
            if payload.get('role') != 'worker' or not matches_token(coordinator.cluster_token, payload.get('token')):
                raise ProtocolError('Worker authentication failed')
            device_id, session_id = registration['device_id'], registration['session_id']
            # Hold orchestration lock through ACK so no task can precede registration.
            with coordinator.task_service.lock:
                coordinator.connection_manager.register_connection(device_id, session_id, connection)
                connection_added = True
                registry.register_device(device_id, session_id, payload.get('hostname', 'Unknown device'))
                registered = True
                send_message(connection, create_message('REGISTER_ACK', 'hq', session_id,
                    {'accepted': True, 'heartbeat_interval': 5}))
            print(f'[CONNECTED] {device_id} / {session_id}')
            while True:
                message = receive_message(connection)
                if message['device_id'] != device_id or message['session_id'] != session_id:
                    raise ProtocolError('Device or session changed during connection')
                with coordinator.task_service.lock:
                    if not coordinator.connection_manager.matches_connection(device_id, session_id, connection):
                        raise ProtocolError('Connection has been retired')
                    kind, payload = message['message_type'], message['payload']
                    if kind in ('RESOURCE_REPORT', 'RESOURCE_UPDATE'):
                        resources = payload if kind == 'RESOURCE_REPORT' else payload.get('resources')
                        registry.update_resources(device_id, session_id, resources)
                        coordinator.task_service.schedule_available()
                    elif kind == 'HEARTBEAT':
                        registry.record_heartbeat(device_id, session_id)
                        coordinator.task_service.expire_assignments()
                    elif kind == 'DISCONNECT':
                        break
                    elif kind in ('JOB_ACCEPTED', 'JOB_RESULT', 'JOB_FAILED', 'JOB_CANCELLED'):
                        # A stale/wrong-owner outcome never mutates another assignment.
                        try:
                            coordinator.task_service.handle_worker_message(device_id, session_id, kind, payload)
                        except ValueError as error:
                            print(f'[REJECTED OUTCOME] {device_id}: {error}')
                    else:
                        raise ProtocolError(f'Unexpected worker message: {kind}')
        except (ConnectionError, TimeoutError, OSError, ProtocolError, ValueError) as error:
            print(f'[CONNECTION CLOSED] {device_id or "unregistered"}: {error}')
        finally:
            # Recover the exact failed connection, even if another session on this
            # physical device remains alive. Never touch a rejected duplicate session.
            with coordinator.task_service.lock:
                current = connection_added and coordinator.connection_manager.matches_connection(device_id, session_id, connection)
                if current:
                    coordinator.connection_manager.unregister_connection(device_id, session_id)
                if current and registered:
                    registry.disconnect_session(device_id, session_id)
                    recovered = coordinator.task_service.handle_worker_disconnect(device_id, session_id)
                    if recovered:
                        print(f'[RECOVERED] {device_id} / {session_id}: {recovered}')


class HQServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, handler=WorkerHandler, *, token=None, heartbeat_timeout=HEARTBEAT_TIMEOUT):
        self.cluster_token = load_token(token)
        if isinstance(heartbeat_timeout, bool) or not isinstance(heartbeat_timeout, (int, float)) or not 0 < heartbeat_timeout <= 300:
            raise ValueError('Heartbeat timeout must be between 0 and 300 seconds')
        self.heartbeat_timeout = heartbeat_timeout
        self.registry = DeviceRegistry()
        self.resource_manager = ResourceManager(self.registry)
        self.task_manager = TaskManager()
        self.scheduler = Scheduler(self.task_manager, self.resource_manager)
        self.connection_manager = WorkerConnectionManager()
        self.task_service = TaskService(self.task_manager, self.scheduler, self.resource_manager, self.connection_manager)
        super().__init__(address, handler)

    def service_actions(self):
        self.task_service.expire_assignments()


def start_hq(host='0.0.0.0', port=5050):
    with HQServer((host, port)) as server:
        api_server = start_api(server, host='127.0.0.1', port=8080)
        print(f'[HQ] Listening on {host}:{server.server_address[1]}')
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print('\n[HQ] Shutting down')
        finally:
            api_server.shutdown()
            api_server.server_close()


if __name__ == '__main__':
    try:
        start_hq()
    except ValueError as error:
        raise SystemExit(str(error))
