# main.py in coordinator
"""
Accept connections.
Receive registration.
Acknowledge registration.
Receive hardware reports.
Receive heartbeats.
Detect inactive connections.
Handle graceful disconnection.
"""

# use socketserver.ThreadingTCPServer, separate handler thread for each connection

# socket server creates tcp server to handle multiple connections simultaneously
import socketserver

# Import sys so the server can exit cleanly when interrupted.
import sys

# Import the protocol functions used to receive, validate, and send messages.
from backend.common.protocol import create_message, receive_message, send_message, ProtocolError


# Set the interval at which workers are expected to send heartbeat messages.
HEARTBEAT_TIMEOUT = 15


# Define the handler that processes one connected worker.
class WorkerHandler(socketserver.BaseRequestHandler):
    # Run this method whenever a worker establishes a TCP connection.
    def handle(self):
        # Store the socket associated with this particular worker connection.
        connection = self.request

        # Set a timeout so an inactive worker cannot occupy a handler forever.
        connection.settimeout(HEARTBEAT_TIMEOUT)

        # Keep track of whether this connection completed registration.
        registered = False

        # Keep the worker's identity available after its registration message arrives.
        device_id = None

        # Keep the connection's session identity for outgoing responses.
        session_id = None

        # Process messages until the worker disconnects or an error occurs.
        try:
            # Receive the first message, which must be a registration request.
            registration = receive_message(connection)

            # Reject connections that do not begin with REGISTER.
            if registration["message_type"] != "REGISTER":
                raise ProtocolError("First message must be REGISTER")

            # Extract the worker's persistent device identity from its registration.
            device_id = registration["device_id"]

            # Extract the worker's current connection session identity.
            session_id = registration["session_id"]

            # Reject a registration that does not identify itself as a worker.
            if registration["payload"].get("role") != "worker":
                raise ProtocolError("Connecting device must register as a worker")

            # Mark this connection as successfully registered.
            registered = True

            # Display the newly connected worker in the HQ terminal.
            print(f"[CONNECTED] Worker {device_id} joined the cluster")

            # Build a response acknowledging that the worker has joined.
            acknowledgement = create_message(
                "REGISTER_ACK",
                "hq",
                session_id,
                {"accepted": True, "heartbeat_interval": 5},
            )

            # Send the registration acknowledgement to the worker.
            send_message(connection, acknowledgement)

            # Continue receiving messages for the lifetime of this connection.
            while True:
                # Receive and validate the next complete protocol message.
                message = receive_message(connection)

                # Reject messages that claim to belong to another device.
                if message["device_id"] != device_id:
                    raise ProtocolError("Device ID changed during connection")

                # Reject messages that claim to belong to another session.
                if message["session_id"] != session_id:
                    raise ProtocolError("Session ID changed during connection")

                # Read the message type so the correct handler can be selected.
                message_type = message["message_type"]

                # Process a hardware report from the connected worker.
                if message_type == "RESOURCE_REPORT":
                    # Display the reported hardware information for initial testing.
                    print(f"[RESOURCES] {device_id}: {message['payload']}")

                # Process a heartbeat confirming that the worker is still alive.
                elif message_type == "HEARTBEAT":
                    # Record that the worker successfully sent a heartbeat.
                    print(f"[HEARTBEAT] Worker {device_id} is alive")

                # Process a resource availability update from the worker.
                elif message_type == "RESOURCE_UPDATE":
                    # Display the updated resource availability for initial testing.
                    print(f"[RESOURCE UPDATE] {device_id}: {message['payload']}")

                # Process a graceful worker disconnection.
                elif message_type == "DISCONNECT":
                    # Display the reason supplied by the worker, if one was provided.
                    print(f"[DISCONNECTED] {device_id}: {message['payload']}")

                    # Exit the message loop because this worker is leaving the cluster.
                    break

                # Reject message types that are not expected from a worker at this stage.
                else:
                    # Explain which message type was unexpected.
                    raise ProtocolError(f"Unexpected worker message: {message_type}")

        # Handle a worker that stops responding or closes its TCP connection.
        except (ConnectionError, TimeoutError, OSError) as error:
            # Report the connection problem without terminating the entire HQ server.
            print(f"[CONNECTION LOST] {device_id or 'Unknown worker'}: {error}")

        # Handle malformed messages and protocol violations.
        except ProtocolError as error:
            # Report the protocol violation without crashing other worker connections.
            print(f"[PROTOCOL ERROR] {device_id or 'Unknown worker'}: {error}")

        # Handle unexpected errors so one worker cannot crash the whole server.
        except Exception as error:
            # Print the unexpected error for debugging during development.
            print(f"[WORKER ERROR] {device_id or 'Unknown worker'}: {error}")

        # Always run cleanup after the connection handler finishes.
        finally:
            # Report that a previously registered worker is no longer connected.
            if registered:
                # Identify the worker whose connection has ended.
                print(f"[OFFLINE] Worker {device_id} connection closed")


# Define a TCP server that allows multiple worker connections at the same time.
class HQServer(socketserver.ThreadingTCPServer):
    # Allow the server to reuse its address after a restart.
    allow_reuse_address = True

    # Run each connection handler in a daemon thread.
    daemon_threads = True


# Start the HQ server and keep it running until the user interrupts it.
def start_hq(host="0.0.0.0", port=5050):
    # Create the TCP server and associate incoming connections with WorkerHandler.
    with HQServer((host, port), WorkerHandler) as server:
        # Display the address and port on which the HQ is listening.
        print(f"[HQ] Listening on {host}:{port}")

        # Continuously accept and handle incoming worker connections.
        try:
            # Start the server's request-processing loop.
            server.serve_forever()

        # Allow Ctrl+C to stop the server without displaying a traceback.
        except KeyboardInterrupt:
            # Inform the user that the HQ is shutting down.
            print("\n[HQ] Shutting down")


