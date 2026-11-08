# if somethine goes long it's possible it's the line that we just added try searching for 
# display_resource_pool(self.server.registry, self.server.resource_manager)
# Import socketserver to run a TCP server that can handle multiple workers concurrently.
import socketserver

# Import the existing protocol functions used to exchange messages with workers.
from backend.common.protocol import create_message, receive_message, send_message, ProtocolError

# Import the registry that stores physical devices and their resource information.
from backend.coordinator.registry import DeviceRegistry

from backend.coordinator.resource_manager import ResourceManager  # Imports the resource manager so HQ can calculate and reserve device capacity.

# import worker connection manager
from backend.coordinator.connection_manager import WorkerConnectionManager

# import task manager
from backend.coordinator.task_manager import TaskManager

# import scheduler
from backend.coordinator.scheduler import Scheduler

# import task orchestration service 
from backend.coordinator.task_service import TaskService

# import http ai startup function used by frontend and integration tests
from backend.coordinator.api import start_api


# Define how long HQ waits without receiving a message before treating a connection as inactive.
HEARTBEAT_TIMEOUT = 15


# Display a readable snapshot of the resources currently known to HQ.
def display_resource_pool(registry, resource_manager):  # Displays connected devices and their currently allocatable resources.
    devices = resource_manager.get_pool()  # Gets online devices and their calculated resource capacity.
    print("\n========== RESOURCE POOL ==========")  # Prints the resource pool heading.
    if not devices:  # Checks whether any devices are currently available.
        print("No online devices available.")  # Explains that the pool currently has no available devices.
    for device in devices:  # Iterates through each online physical device.
        print(f"\nDevice: {device['hostname']}")  # Displays the device's hostname.
        print(f"Device ID: {device['device_id']}")  # Displays its persistent device identifier.
        print(f"Capacity: {device['capacity']}")  # Displays total, reserved, and remaining allocatable resources.
    print("===================================\n")  # Prints the resource pool footer.

# Define the handler that processes one connected worker.
class WorkerHandler(socketserver.BaseRequestHandler):
    # Run this method whenever a worker establishes a TCP connection.
    def handle(self):
        # Store the socket associated with this particular worker connection.
        connection = self.request

        # Access the shared registry created by the HQ server.
        registry = self.server.registry

        # Set a timeout so an inactive worker cannot occupy a handler forever.
        connection.settimeout(HEARTBEAT_TIMEOUT)

        # Track whether this connection successfully registered with HQ.
        registered = False

        # Store the worker's persistent physical-device identity after registration.
        device_id = None

        # Store the unique identity of this particular worker connection.
        session_id = None

        # Process messages until the worker disconnects or an error occurs.
        try:
            # Receive the first message, which must be a registration request.
            registration = receive_message(connection)

            # Reject connections that do not begin with REGISTER.
            if registration["message_type"] != "REGISTER":
                raise ProtocolError("First message must be REGISTER")

            # Extract the worker's persistent device identity.
            device_id = registration["device_id"]

            # Extract the identity of this particular connection session.
            session_id = registration["session_id"]

            # Reject a registration that does not identify itself as a worker.
            if registration["payload"].get("role") != "worker":
                raise ProtocolError("Connecting device must register as a worker")

            # Read the hostname supplied by the worker, using a fallback if absent.
            hostname = registration["payload"].get("hostname", "Unknown device")

            # Add this connection to the physical-device registry.
            registry.register_device(device_id, session_id, hostname)

            # Mark this connection as successfully registered for cleanup later.
            registered = True

            # Report that the worker has joined the cluster.
            print(f"[CONNECTED] Worker {hostname} ({device_id}) joined the cluster")

            # Build a response acknowledging that the worker has joined.
            acknowledgement = create_message(
                "REGISTER_ACK",
                "hq",
                session_id,
                {"accepted": True, "heartbeat_interval": 5},
            )

            # Send the registration acknowledgement to the worker.
            send_message(connection, acknowledgement)



            # newest addition part 2, unsure if it is in the correct part/area
            self.server.connection_manager.register_connection(
                device_id, 
                session_id, 
                self.request,
            )


            # Display the inventory after the new worker connects.
            display_resource_pool(self.server.registry, self.server.resource_manager)


            # Continue receiving messages for the lifetime of this connection.
            while True:
                # Receive and validate the next complete protocol message.
                message = receive_message(connection)

                # Reject messages that claim to belong to another physical device.
                if message["device_id"] != device_id:
                    raise ProtocolError("Device ID changed during connection")

                # Reject messages that claim to belong to another connection session.
                if message["session_id"] != session_id:
                    raise ProtocolError("Session ID changed during connection")

                # Read the message type so the correct handler can be selected.
                message_type = message["message_type"]
                payload = message.get("payload", {})

                # Process the initial hardware report sent by the worker.
                if message_type == "RESOURCE_REPORT":
                    # Store the worker's hardware report in the physical-device registry.
                    registry.update_resources(device_id, session_id, message["payload"])

                    # Confirm that HQ received the initial resource report.
                    print(f"[RESOURCES] Received initial report from {hostname}")

                    # Display the updated resource inventory.
                    display_resource_pool(self.server.registry, self.server.resource_manager)

                # Process a heartbeat confirming that the worker is still alive.
                elif message_type == "HEARTBEAT":
                    # Update the device's last-seen timestamp in the registry.
                    registry.record_heartbeat(device_id, session_id)

                # Process an updated resource availability report from the worker.
                elif message_type == "RESOURCE_UPDATE":
                    # Extract the actual hardware information from the message wrapper.
                    resources = payload.get("resources")

                    # Reject updates that do not contain a valid resource dictionary.
                    if not isinstance(resources, dict):
                        raise ProtocolError("RESOURCE_UPDATE must contain a resources dictionary")

                    # Replace the stored resource report with the latest hardware information.
                    registry.update_resources(device_id, session_id, resources)

                    # Confirm that HQ received the resource update.
                    print(f"[RESOURCE UPDATE] Received update from {hostname}")

                    # Display the updated resource inventory.
                    display_resource_pool(self.server.registry, self.server.resource_manager)

                    # Retry pending tasks because the worker's available capacity may have changed
                    self.server.task_service.schedule_available()

                # Process a graceful worker disconnection.
                elif message_type == "DISCONNECT":
                    # Display the reason supplied by the worker, if one was provided.
                    print(f"[DISCONNECT REQUEST] {hostname}: {message['payload']}")

                    # Exit the message loop so the cleanup section can run.
                    break

                # newest addition part 3
                # handle confirmation that worker accepted a task
                elif message_type == "JOB_ACCEPTED": 
                    # extract task id from worker response 
                    task_id = payload.get("task_id")

                    # mark the scheduled task as running
                    self.server.task_manager.mark_running(task_id)

                    # print confirmation that execution has begun
                    print(f"[TASK RUNNING] {task_id} on {device_id}")

                # handle successful task result
                elif message_type == "JOB_RESULT": 
                    # extract task id from the worker's response
                    task_id = payload.get("task_id")

                    # extract calculated result
                    result = payload.get("result")

                    # mark task as completed and save its result
                    self.server.task_manager.complete_task(task_id, result)

                    # release resources reserved for this task
                    self.server.resource_manager.release(task_id)

                    # display result
                    print(f"[TASK COMPLETED] {task_id}: {result}")

                # Handle a task execution failure.
                elif message_type == "JOB_FAILED":
                    # Extract the task ID from the worker's response.
                    task_id = payload.get("task_id")

                    # Extract the reported error.
                    error = payload.get("error", "Unknown worker error")

                    # Mark the task as failed.
                    self.server.task_manager.fail_task(task_id, error)

                    # Release the task's reserved resources.
                    self.server.resource_manager.release(task_id)

                    # Display the failure.
                    print(f"[TASK FAILED] {task_id}: {error}")

                # Handle confirmation that a task was cancelled.
                elif message_type == "JOB_CANCELLED":
                    # Extract the task ID from the worker's response.
                    task_id = payload.get("task_id")

                    # Cancel the task in the coordinator's task manager.
                    self.server.task_manager.cancel_task(task_id)

                    # Release the task's reserved resources.
                    self.server.resource_manager.release(task_id)

                    # Display the cancellation.
                    print(f"[TASK CANCELLED] {task_id}")
                # changes end here for this block it looks like payload is showing up as not defined 
                # for every new added block from job accepted to job cancelled

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

        # Handle invalid registry operations or other unexpected errors.
        except Exception as error:
            # Print the unexpected error for debugging during development.
            print(f"[WORKER ERROR] {device_id or 'Unknown worker'}: {error}")

        # Always run cleanup after the connection handler finishes.
        finally:
            # Remove this connection from the registry if registration succeeded.
            if registered:
                # Remove only this worker session, preserving other sessions on the same device.
                registry.disconnect_session(device_id, session_id)

                # change # 4 
                self.server.connection_manager.unregister_connection(device_id, session_id)

                # retrieve the device's current registry record after removing session
                # device_snapshot = registry.snapshot().get(device_id)

                # Retrieve the current list of registered physical devices
                device_snapshot = registry.snapshot()

                # check whether this device still has an extra registry
                device_is_online = any(
                    device["device_id"] == device_id
                    and device["status"] == "online"
                    for device in device_snapshot
                )

                # handle unfinished tasks only when the physical device is fully offline
                if not device_is_online:
                    # fail unfinished tasks assigned to the disconnected device
                    failed_tasks = self.server.task_service_handle_worker_disonnect(device_id)

                    # report every task affected by disconnect
                    for task_id in failed_tasks: 
                        # print the task that was marked faile 
                        print(f"[TASK FAILED] (task_id): worker disconnected")

                # check whether this was the physical device's final active session 
                if not device_is_online : 
                    # Fail unfinished tasks because this worker is no longer available
                    failed_tasks = self.server.task_service.handle_worker_disconnect(device_id)

                    # Report the tasks affected by the worker disconnect
                    for task_id in failed_tasks:
                        # Print the task ID that was marked faile 
                        print(f"[TASK FAILED] {device_id} / {session_id}")

                # Report that this particular worker session has ended.
                print(f"[OFFLINE SESSION] {device_id} / {session_id}")

                # Display the inventory after the session has disconnected.
                display_resource_pool(self.server.registry, self.server.resource_manager)


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
        # Create one shared registry that all worker-handler threads will use.
        server.registry = DeviceRegistry()

        # connect reesource allocation to same registry used by HQ
        server.resource_manager = ResourceManager(server.registry)

        # most recent addition, from the below line all the way through
        # to the end of server.task_service=TaskService()
        
        # create manager that tracks task states
        server.task_manager = TaskManager()

        # create scheduler that assigns tasks to available workers
        server.scheduler = Scheduler(server.task_manager, server.resource_manager)

        # create manager that tracks active worker sockets
        server.connection_manager = WorkerConnectionManager()

        # create the service that connects task submission to scheduling and dispatch
        server.task_service = TaskService(
            server.task_manager, 
            server.scheduler, 
            server.resource_manager, 
            server.connection_manager,
        )

        # start the http api so clients can submit tasks and inspect the resource pool 
        api_server = start_api(server, host = "127.0.0.1", port = 8080)


        # Display the address and port on which HQ is listening.
        print(f"[HQ] Listening on {host}:{port}")

        # Continuously accept and handle incoming worker connections.
        try:
            # Start the server's request-processing loop.
            server.serve_forever()

        # Allow Ctrl+C to stop the server without displaying a traceback.
        except KeyboardInterrupt:
            # Inform the user that the HQ is shutting down.
            print("\n[HQ] Shutting down")

        finally: 
            # Stop the HTTP API when the HQ TCP server shuts down
            api_server.shutdown() 

            # Close the HTTP server's listening socket
            api_server.server_close()

# start hq when this module is executed directly
if __name__ == "__main__":
    # start the tcp coordinator and its http api 
    start_hq()

