"""Live worker sockets, with exact-session dispatch and serialized writes."""
import socket
import threading

from backend.common.protocol import create_message, send_message


class WorkerConnectionManager:
    def __init__(self):
        self.connections = {}
        self.lock = threading.RLock()

    def register_connection(self, device_id, session_id, connection):
        with self.lock:
            sessions = self.connections.setdefault(device_id, {})
            if session_id in sessions:
                raise ValueError("Worker session is already connected")
            sessions[session_id] = {"socket": connection, "send_lock": threading.Lock()}

    def unregister_connection(self, device_id, session_id):
        with self.lock:
            sessions = self.connections.get(device_id)
            if not sessions:
                return None
            info = sessions.pop(session_id, None)
            if not sessions:
                del self.connections[device_id]
            return info

    def matches_connection(self, device_id, session_id, connection):
        """Guard delayed handler cleanup after a retired session ID is reused.

        Callers hold TaskService.lock across this check and registry cleanup.
        """
        with self.lock:
            info = self.connections.get(device_id, {}).get(session_id)
            return info is not None and info["socket"] is connection

    def disconnect_session(self, device_id, session_id):
        info = self.unregister_connection(device_id, session_id)
        if info:
            try:
                info["socket"].shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                info["socket"].close()
            except OSError:
                pass

    def get_sessions(self, device_id):
        with self.lock:
            return list(self.connections.get(device_id, {}))

    def send_to_session(self, device_id, session_id, message_type, payload):
        with self.lock:
            info = self.connections.get(device_id, {}).get(session_id)
        if info is None:
            return False
        message = create_message(message_type, "hq", session_id, payload)
        try:
            with info["send_lock"]:
                send_message(info["socket"], message)
            return True
        except (OSError, ConnectionError, TimeoutError):
            # TaskService retires the socket AND registry session before requeueing.
            return False

    def send_to_device(self, device_id, message_type, payload):
        sessions = self.get_sessions(device_id)
        return bool(sessions) and self.send_to_session(device_id, sessions[-1], message_type, payload)

    def get_connected_devices(self):
        with self.lock:
            return list(self.connections)
