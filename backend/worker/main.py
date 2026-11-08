# worker file in order to get hardware information etc through psutil
# handles networking only for worker, no task execution here


# Import argparse so the worker can receive the HQ address and port from command-line arguments.
import argparse

# Import platform to identify the worker's operating system and processor architecture.
import platform

# Import socket to establish a TCP connection to the HQ.
import socket

# Import time to schedule periodic heartbeat messages.
import time

# Import uuid to generate unique device and session identifiers.
import uuid

# Import Path to store the device identity in the user's home directory.
from pathlib import Path

# Import psutil to inspect CPU and memory resources.
import psutil

# Import the protocol functions used to exchange framed messages with the HQ.
from backend.common.protocol import create_message, receive_message, send_message

from backend.worker.runtime import run_worker_loop


# Define how often the worker should send a heartbeat to the HQ.
HEARTBEAT_INTERVAL = 5
# Refresh worker's hardware usage information every fifteen seconds
RESOURCE_UPDATE_INTERVAL = 15

# Load the worker's persistent device ID or generate one if this is its first run.
def load_device_id():
    # Define a hidden application directory inside the current user's home directory.
    config_directory = Path.home() / ".dcp"

    # Create the directory if it does not already exist.
    config_directory.mkdir(parents=True, exist_ok=True)

    # Define the file where this computer's persistent device ID will be stored.
    identity_file = config_directory / "device_id"

    # Reuse the existing ID if the computer has already registered previously.
    if identity_file.exists():
        # Read the saved ID and remove any surrounding whitespace.
        return identity_file.read_text().strip()

    # Generate a UUID to uniquely identify this physical computer.
    device_id = str(uuid.uuid4())

    # Save the new ID so future connections identify the same computer.
    identity_file.write_text(device_id)

    # Return the persistent device ID to the caller.
    return device_id


# Collect a snapshot of the worker's hardware and operating-system information.
def collect_resources():
    # Read the number of logical CPU cores available to the operating system.
    logical_cores = psutil.cpu_count(logical=True)

    # Read the number of physical CPU cores when the system exposes that information.
    physical_cores = psutil.cpu_count(logical=False)

    # Read the system's total and currently available physical memory.
    memory = psutil.virtual_memory()

    # Return the hardware information as a JSON-compatible dictionary.
    return {
        # Report the operating-system name, such as Linux or Windows.
        "os_name": platform.system(),

        # Report the operating-system release for compatibility diagnostics.
        "os_version": platform.release(),

        # Report the processor architecture, such as x86_64 or ARM64.
        "architecture": platform.machine(),

        # Report the number of logical CPU cores.
        "logical_cores": logical_cores,

        # Report the number of physical CPU cores, if available.
        "physical_cores": physical_cores,

        # Report total physical memory in megabytes.
        "total_memory_mb": round(memory.total / (1024 * 1024)),

        # Report currently available physical memory in megabytes.
        "available_memory_mb": round(memory.available / (1024 * 1024)),

        # Report the current CPU utilization as a percentage.
        "cpu_percent": psutil.cpu_percent(interval=0.2),

        # Mark GPU support as unknown or unavailable until GPU detection is implemented.
        "gpu": {"available": False},
    }


# Connect this worker to the HQ and maintain the connection.
def connect_worker(hq_host, hq_port):
    # Load this computer's persistent identity.
    device_id = load_device_id()

    # Generate a new session ID for this particular connection.
    session_id = str(uuid.uuid4())

    # Create a TCP socket using IPv4 and the TCP transport protocol.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        # Set a timeout so connection attempts cannot wait forever.
        connection.settimeout(10)

        # Establish the TCP connection to the HQ's IP address and port.
        connection.connect((hq_host, hq_port))

        # Display the HQ address after the connection succeeds.
        print(f"[WORKER] Connected to HQ at {hq_host}:{hq_port}")

        # Build the registration message identifying this device as a worker.
        registration = create_message(
            "REGISTER",
            device_id,
            session_id,
            {"role": "worker", "hostname": platform.node()},
        )

        # Send the registration request to the HQ.
        send_message(connection, registration)
        # Record when the initial resource report was sent so future updates follow the correct interval
        last_resource_update = time.monotonic()

        # Wait for the HQ to respond with a registration acknowledgement.
        acknowledgement = receive_message(connection)

        # Verify that the HQ accepted this worker into the cluster.
        if acknowledgement["message_type"] != "REGISTER_ACK" or not acknowledgement["payload"].get("accepted"):
            # Stop connecting if the HQ did not accept the registration.
            raise ConnectionError("HQ rejected worker registration")

        # Display confirmation that registration was successful.
        print(f"[WORKER] Registered with device ID {device_id}")

        # Collect the computer's current hardware information.
        resources = collect_resources()

        # Build a message containing the initial hardware report.
        resource_message = create_message(
            "RESOURCE_REPORT",
            device_id,
            session_id,
            resources,
        )

        # Send the initial hardware report to the HQ.
        send_message(connection, resource_message)

        # Change the socket timeout to allow regular heartbeat transmissions.
        connection.settimeout(None)

        # Keep sending heartbeats until the user interrupts the worker.
        try:
            # Begin the worker's continuous heartbeat loop.
            # while True:
            #     # Build a heartbeat message for the current connection session.
            #     heartbeat = create_message(
            #         "HEARTBEAT",            # identify message as a heartbeat
            #         device_id,              # identify physical computer sending the heartbeat
            #         session_id,             # identify current worker connection
            #         {"status": "alive"},    # report that the worker is operational 
            #     )

            #     # Send the heartbeat to the HQ.
            #     send_message(connection, heartbeat)

            #     # check whether the resource update interval has elapsed
            #     if time.monotonic() - last_resource_update >= RESOURCE_UPDATE_INTERVAL:
            #         # collect fresh cpu, memory, and hardware information 
            #         updated_resources = collect_resources()

            #         # build a message containing the latest resource information
            #         resource_update = create_message(
            #             "RESOURCE_UPDATE",      # Identify the message as a resource update
            #             device_id,              # identify physical computer reporting resources
            #             session_id,             # identify current worker connection
            #             updated_resources,      # contains newly collected hardware information        
            #         )

            #         # send the updated resource info to hq
            #         send_message(connection, resource_update)

            #         # record the time of the latest update
            #         last_resource_update = time.monotonic()

            #         # confirm that the update was sent
            #         print("[WORKER] Sent updated resource information")

            #     # Wait until the next heartbeat interval.
            #     time.sleep(HEARTBEAT_INTERVAL)
            run_worker_loop(connection, device_id, session_id, collect_resources); 

        # Handle Ctrl+C as a request to leave the cluster gracefully.
        except KeyboardInterrupt:
            # Build a message explaining that the user stopped the worker.
            disconnect = create_message(
                "DISCONNECT",
                device_id,
                session_id,
                {"reason": "User stopped worker"},
            )

            # Send the graceful disconnection message to the HQ.
            send_message(connection, disconnect)

            # Display confirmation that the worker is disconnecting.
            print("\n[WORKER] Disconnecting from HQ")


# Run the worker startup procedure when this module is executed directly.
if __name__ == "__main__":

    # Create a command-line argument parser for worker configuration.
    parser = argparse.ArgumentParser(description="Start a distributed computing worker")

    # Allow the user to specify the HQ coordinator's hostname or IP address.
    parser.add_argument("--host", default="127.0.0.1", help="HQ coordinator address")

    # Allow the user to specify the TCP port used by the HQ coordinator.
    parser.add_argument("--port", type=int, default=5050, help="HQ coordinator TCP port")

    # Read the arguments supplied when launching the worker.
    args = parser.parse_args()

    # Connect this worker to the specified HQ coordinator.
    connect_worker(args.host, args.port)


