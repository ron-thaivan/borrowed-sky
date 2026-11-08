# Import threading to protect the shared worker connection collection.
import threading

# Import the protocol helper used to send framed messages.
from backend.common.protocol import create_message, send_message


# Manage active TCP connections from workers to the coordinator.
class WorkerConnectionManager:

    # Initialize the connection manager.
    def __init__(self):
        # Store connections by physical device ID and worker session ID.
        self.connections = {}

        # Protect changes and lookups in the connection collection.
        self.lock = threading.RLock()

    # Register a worker's active socket connection.
    def register_connection(self, device_id, session_id, connection):
        # Acquire the lock before modifying shared connection data.
        with self.lock:
            # Create the device entry if this is its first active session.
            self.connections.setdefault(device_id, {})

            # Store the socket and a lock dedicated to sending on that socket.
            self.connections[device_id][session_id] = {
                "socket": connection,
                "send_lock": threading.Lock(),
            }

    # Remove one worker session without affecting other sessions for that device.
    def unregister_connection(self, device_id, session_id):
        # Acquire the lock before modifying shared connection data.
        with self.lock:
            # Check whether the physical device has a connection entry.
            if device_id not in self.connections:
                # Return when there is nothing to remove.
                return

            # Remove only the requested session.
            self.connections[device_id].pop(session_id, None)

            # Remove the device entry when no sessions remain.
            if not self.connections[device_id]:
                # Delete the now-empty device entry.
                del self.connections[device_id]

    # Send a protocol message to the most recently registered session for a device.
    def send_to_device(self, device_id, message_type, payload):
        # Acquire the manager lock only long enough to select a connection.
        with self.lock:
            # Retrieve all active sessions for the requested device.
            sessions = self.connections.get(device_id)

            # Return False when the device has no registered connection.
            if not sessions:
                # Report that dispatch was not possible.
                return False

            # Select the most recently inserted session.
            session_id = next(reversed(sessions))

            # Snapshot the selected session's socket and send lock.
            connection_info = sessions[session_id]

            # Keep local references so the manager lock can be released.
            connection = connection_info["socket"]

            # Keep the per-socket lock to prevent interleaved TCP messages.
            send_lock = connection_info["send_lock"]

        # Build the outgoing message after releasing the global manager lock.
        message = create_message(
            # Identify the coordinator as the sender.
            message_type,
            # Use the coordinator's device identifier.
            "hq",
            # Associate the message with the selected worker session.
            session_id,
            # Include the task or control payload.
            payload,
        )

        # Serialize writes to this socket without blocking other device lookups.
        try:
            # Acquire only this socket's send lock.
            with send_lock:
                # Send the complete framed protocol message.
                send_message(connection, message)

            # Report successful delivery to the local TCP socket.
            return True

        # Handle sockets that have disconnected or become unusable.
        except (OSError, ConnectionError, TimeoutError):
            # Remove the failed session if it is still registered.
            self.unregister_connection(device_id, session_id)

            # Report that the message could not be delivered.
            return False

    # Return the IDs of devices that currently have registered sessions.
    def get_connected_devices(self):
        # Acquire the lock while reading the shared collection.
        with self.lock:
            # Return a new list so callers cannot modify internal state.
            return list(self.connections.keys())