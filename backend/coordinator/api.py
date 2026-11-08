"""Local HTTP API for the optional Python coordinator; no browser CORS access."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from backend.common.auth import matches_token

MAX_REQUEST_SIZE = 64 * 1024


def public_task(task):
    # Assignment proofs are sent only to the assigned worker over TCP.
    return {key: value for key, value in task.items() if key != 'assignment_token'}


class CoordinatorAPIHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def send_json(self, status_code, data):
        response_body = json.dumps(data, allow_nan=False).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(response_body)))
        if status_code == 401:
            self.send_header('WWW-Authenticate', 'Bearer')
        self.end_headers()
        self.wfile.write(response_body)

    def authenticated(self):
        header = self.headers.get('Authorization', '')
        if not header.startswith('Bearer ') or not matches_token(self.server.coordinator.cluster_token, header[7:]):
            self.close_connection = True
            self.send_json(401, {'error': 'Valid cluster Bearer token required.'})
            return False
        return True

    def do_OPTIONS(self):
        # The Node website does not use this optional API. No wildcard CORS.
        self.send_json(403, {'error': 'Cross-origin browser requests are not enabled.'})

    def do_GET(self):
        if not self.authenticated():
            return
        coordinator = self.server.coordinator
        path = self.path.split('?', 1)[0]
        if path == '/api/status':
            devices = coordinator.registry.snapshot()
            self.send_json(200, {'status': 'online',
                'connected_workers': coordinator.connection_manager.get_connected_devices(),
                'device_count': sum(d['status'] == 'online' for d in devices),
                'task_count': len(coordinator.task_manager.list_tasks())})
        elif path == '/api/devices':
            self.send_json(200, {'devices': coordinator.registry.snapshot(),
                'resource_pool': coordinator.resource_manager.get_pool()})
        elif path == '/api/tasks':
            self.send_json(200, {'tasks': [public_task(t) for t in coordinator.task_manager.list_tasks()]})
        elif path.startswith('/api/tasks/'):
            task = coordinator.task_manager.get_task(path.rsplit('/', 1)[-1])
            self.send_json(404, {'error': 'Task not found.'}) if task is None else self.send_json(200, {'task': public_task(task)})
        else:
            self.send_json(404, {'error': 'Endpoint not found.'})

    def do_POST(self):
        if not self.authenticated():
            return
        if self.path.split('?', 1)[0] != '/api/tasks':
            self.send_json(404, {'error': 'Endpoint not found.'})
            return
        lengths = self.headers.get_all('Content-Length', [])
        if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or len(lengths[0]) > 10 or not lengths[0].isascii() or not lengths[0].isdigit():
            self.send_json(400, {'error': 'One valid Content-Length is required.'})
            return
        length = int(lengths[0])
        if not 0 < length <= MAX_REQUEST_SIZE:
            self.send_json(413, {'error': 'Invalid or oversized request body.'})
            return
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('Incomplete request body')
            def reject_constant(value):
                raise ValueError('Nonfinite numbers are not allowed')
            data = json.loads(raw.decode('utf-8'), parse_constant=reject_constant)
            if not isinstance(data, dict) or set(data) - {'task_type', 'payload', 'cpu_cores', 'memory_mb'}:
                raise ValueError('Expected a task object with supported fields')
            task = self.server.coordinator.task_service.submit_task(data.get('task_type'), data.get('payload'),
                data.get('cpu_cores', 1.0), data.get('memory_mb', 128.0))
        except (ValueError, TypeError, UnicodeDecodeError, RecursionError) as error:
            self.send_json(400, {'error': str(error)})
            return
        except (TimeoutError, OSError):
            self.close_connection = True
            return
        self.send_json(503 if task['status'] == 'FAILED' else 202, {'task': public_task(task)})

    def log_message(self, format_string, *args):
        # Avoid logging authorization, query strings or submitted payloads.
        pass


def start_api(coordinator, host='127.0.0.1', port=8080):
    api_server = ThreadingHTTPServer((host, port), CoordinatorAPIHandler)
    api_server.coordinator = coordinator
    thread = threading.Thread(target=api_server.serve_forever, daemon=True)
    thread.start()
    print(f'[API] Listening on http://{host}:{api_server.server_address[1]}')
    return api_server
