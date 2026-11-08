"""Installed Python worker entry point (separate from browser Web Workers)."""
import argparse
import os
import platform
import socket
import tempfile
import uuid
from pathlib import Path

import psutil

from backend.common.auth import load_token
from backend.common.protocol import ProtocolError, create_message, receive_message, send_message
from backend.worker.runtime import MESSAGE_TIMEOUT, run_worker_loop


def load_device_id(directory=None):
    config_directory = Path(directory) if directory is not None else Path.home() / ".dcp"
    config_directory.mkdir(parents=True, exist_ok=True)
    identity_file = config_directory / "device_id"
    if not identity_file.exists():
        # Publish a complete file without replacing another process's identity.
        # An exclusive hard link is atomic; concurrent first starts read the winner.
        with tempfile.NamedTemporaryFile(mode="w", encoding="ascii", dir=config_directory,
                                         prefix=".device_id-", suffix=".tmp", delete=False) as candidate:
            candidate.write(str(uuid.uuid4()))
            candidate_path = Path(candidate.name)
        try:
            try:
                os.link(candidate_path, identity_file)
            except FileExistsError:
                pass
        finally:
            candidate_path.unlink(missing_ok=True)
    value = identity_file.read_text().strip()
    try:
        return str(uuid.UUID(value))
    except ValueError as error:
        raise ValueError("Saved device_id is invalid; restore or remove the file before reconnecting") from error


def collect_resources():
    memory = psutil.virtual_memory()
    return {
        "os_name": platform.system(),
        "os_version": platform.release(),
        "architecture": platform.machine(),
        "logical_cores": psutil.cpu_count(logical=True),
        "physical_cores": psutil.cpu_count(logical=False),
        "total_memory_mb": round(memory.total / (1024 * 1024)),
        "available_memory_mb": round(memory.available / (1024 * 1024)),
        "cpu_percent": psutil.cpu_percent(interval=0.2),
        "gpu": {"available": False},
    }


def connect_worker(hq_host, hq_port, token=None):
    # Refuse an unconfigured worker before creating a connection or identity.
    token = load_token(token)
    device_id, session_id = load_device_id(), str(uuid.uuid4())
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(MESSAGE_TIMEOUT)
        connection.connect((hq_host, hq_port))
        send_message(connection, create_message("REGISTER", device_id, session_id,
                     {"role": "worker", "hostname": platform.node(), "token": token}))
        acknowledgement = receive_message(connection)
        if (acknowledgement["message_type"] != "REGISTER_ACK"
                or acknowledgement["device_id"] != "hq"
                or acknowledgement["session_id"] != session_id
                or acknowledgement["payload"].get("accepted") is not True):
            raise ConnectionError("HQ rejected worker registration")
        print(f"[WORKER] Registered {device_id} with {hq_host}:{hq_port}")
        try:
            resources = collect_resources()
        except Exception:
            resources = {}
            print("[WORKER] Hardware report unavailable; retrying on the next update")
        send_message(connection, create_message("RESOURCE_REPORT", device_id, session_id, resources))
        try:
            run_worker_loop(connection, device_id, session_id, collect_resources)
        except KeyboardInterrupt:
            try:
                send_message(connection, create_message("DISCONNECT", device_id, session_id,
                             {"reason": "User stopped worker"}))
            except (OSError, ConnectionError):
                pass
            print("\n[WORKER] Disconnecting from HQ")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Start a distributed computing worker")
    parser.add_argument("--host", default="127.0.0.1", help="HQ coordinator address")
    parser.add_argument("--port", type=int, default=5050, help="HQ coordinator TCP port")
    args = parser.parse_args()
    try:
        connect_worker(args.host, args.port)
    except (ValueError, OSError, ConnectionError, ProtocolError) as error:
        parser.exit(1, f"Worker stopped: {error}\n")
