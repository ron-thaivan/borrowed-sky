# backend main file, handles application launch accounting for different roles

# Import argparse so the user can choose the computer's operating mode.
import argparse
from backend.common.protocol import ProtocolError

# Import the HQ server startup function.
from backend.coordinator.main import start_hq

# Import the worker connection function.
from backend.worker.main import connect_worker


# Define the command-line options used to start the distributed computing node.
def main():
    # Create the command-line argument parser.
    parser = argparse.ArgumentParser(description="Distributed Computing Platform")

    # Require the user to choose whether this computer is the HQ or a worker.
    parser.add_argument("--role", choices=["hq", "worker"], required=True)

    # Accept the HQ's IP address when starting a worker.
    parser.add_argument("--hq", default="127.0.0.1")

    # Allow the listening or connection port to be changed when necessary.
    parser.add_argument("--port", type=int, default=5050)

    # Parse the command-line arguments supplied by the user.
    args = parser.parse_args()

    try:
        # Start the TCP server when this computer is configured as the HQ.
        if args.role == "hq":
            # Listen on all network interfaces so other computers can connect.
            start_hq(host="0.0.0.0", port=args.port)
        else:
            # Connect this worker to the specified HQ address and port.
            connect_worker(args.hq, args.port)
    except (ValueError, OSError, ConnectionError, ProtocolError) as error:
        parser.exit(1, f"Python prototype stopped: {error}\n")


# Run the startup function only when this file is executed as the program entry point.
if __name__ == "__main__":
    # Start the selected operating mode.
    main()
