
# Import copy so callers cannot accidentally modify registry data through returned snapshots.
import copy

# Import threading so the registry can safely handle simultaneous worker-handler threads.
import threading

# Import time so we can record when devices connect and last report activity occurs.
import time
import math


MAX_DEVICES = 128
MAX_SESSIONS_PER_DEVICE = 32
MAX_MEMORY_MB = 16 * 1024 * 1024


def validate_identifier(value, name, limit=128):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(f"{name} must be a nonempty string of at most {limit} characters")


def validate_resources(resources):
    fields = {"os_name", "os_version", "architecture", "logical_cores", "physical_cores",
              "total_memory_mb", "available_memory_mb", "cpu_percent", "gpu"}
    if not isinstance(resources, dict) or not set(resources).issubset(fields):
        raise ValueError("Resource information has unsupported fields")
    result = copy.deepcopy(resources)
    for key in ("os_name", "os_version", "architecture"):
        if key in result and result[key] is not None:
            validate_identifier(result[key], key)
    for key in ("logical_cores", "physical_cores"):
        value = result.get(key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 1024):
            raise ValueError(f"{key} must be an integer from 1 to 1024 or null")
    for key in ("total_memory_mb", "available_memory_mb", "cpu_percent"):
        value = result.get(key)
        upper = 100 if key == "cpu_percent" else MAX_MEMORY_MB
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= upper or not math.isfinite(value)):
            raise ValueError(f"{key} must be finite and between 0 and {upper}, or null")
    logical, physical = result.get("logical_cores"), result.get("physical_cores")
    if logical is not None and physical is not None and physical > logical:
        raise ValueError("Physical core count cannot exceed logical core count")
    total, available = result.get("total_memory_mb"), result.get("available_memory_mb")
    if total is not None and available is not None and available > total:
        raise ValueError("Available memory cannot exceed total memory")
    if "gpu" in result and (not isinstance(result["gpu"], dict) or set(result["gpu"]) != {"available"} or type(result["gpu"]["available"]) is not bool):
        raise ValueError("gpu must contain only an available boolean")
    return result


# Define the central inventory that HQ uses to track physical devices.
class DeviceRegistry:
    # Initialize an empty inventory and a lock that protects shared registry data.
    def __init__(self):
        # Store one record per physical device, using its persistent device ID as the key.
        self._devices = {}

        # Prevent two handler threads from modifying the inventory at the same time.
        self._lock = threading.RLock()

    # Add a worker connection to a physical device, or update an existing device record.
    def register_device(self, device_id, session_id, hostname):
        # Reject missing or invalid identifiers before changing the inventory.
        validate_identifier(device_id, "device_id")
        validate_identifier(session_id, "session_id")
        validate_identifier(hostname, "hostname", 255)

        # Acquire the lock before reading or changing shared inventory data.
        with self._lock:
            if any(session_id in item["sessions"] for item in self._devices.values()):
                raise ValueError("Session ID is already registered")
            # Look for an existing physical-device record.
            device = self._devices.get(device_id)

            # Create a new record only when this physical device has never connected before.
            if device is None:
                if len(self._devices) >= MAX_DEVICES:
                    raise ValueError("Device registry is full")
                # Store hardware information once per physical device, not once per process.
                device = {
                    "device_id": device_id,
                    "hostname": hostname,
                    "status": "online",
                    "resources": {},
                    "sessions": set(),
                    "connected_at": time.time(),
                    "last_seen": time.time(),
                }

                # Add the newly created physical-device record to the inventory.
                self._devices[device_id] = device

            if len(device["sessions"]) >= MAX_SESSIONS_PER_DEVICE:
                raise ValueError("Device session limit reached")
            if not device["sessions"]:
                # A returning device must report current capacity before scheduling.
                device["resources"] = {}

            # Refresh the hostname in case the device's reported name has changed.
            device["hostname"] = hostname

            # Mark the physical device online because a worker session has connected.
            device["status"] = "online"

            # Track this connection separately so multiple processes do not duplicate hardware.
            device["sessions"].add(session_id)

            # Record the time at which this connection most recently contacted HQ.
            device["last_seen"] = time.time()

    # Save a worker's initial hardware report or a later resource update.
    def update_resources(self, device_id, session_id, resources):
        # Require a dictionary because protocol resource payloads are JSON objects.
        validated = validate_resources(resources)

        # Acquire the lock before accessing the shared device inventory.
        with self._lock:
            # Find the physical device associated with this connection.
            device = self._devices.get(device_id)

            # Reject resource reports from sessions that have not registered.
            if device is None or session_id not in device["sessions"]:
                raise ValueError("Resource report came from an unregistered session")

            # Replace the previous report with a copy of the newest resource information.
            device["resources"] = validated

            # Record that the worker is still communicating with HQ.
            device["last_seen"] = time.time()

    # Record that a registered worker session is still alive.
    def record_heartbeat(self, device_id, session_id):
        # Acquire the lock before updating shared device information.
        with self._lock:
            # Find the physical device associated with this connection.
            device = self._devices.get(device_id)

            # Reject heartbeat messages from sessions that are not registered.
            if device is None or session_id not in device["sessions"]:
                raise ValueError("Heartbeat came from an unregistered session")

            # Update the most recent contact time for this physical device.
            device["last_seen"] = time.time()

    # Remove a connection and mark its physical device offline only when no sessions remain.
    def disconnect_session(self, device_id, session_id):
        # Acquire the lock before changing the session collection.
        with self._lock:
            # Find the physical device associated with the closing connection.
            device = self._devices.get(device_id)

            # Return False if the device or connection is not currently registered.
            if device is None or session_id not in device["sessions"]:
                return False

            # Remove only the session that has actually disconnected.
            device["sessions"].remove(session_id)

            # Mark the physical device offline only after its final session disconnects.
            if not device["sessions"]:
                device["status"] = "offline"

            # Record the time at which this connection ended.
            device["last_seen"] = time.time()

            # Confirm that a registered session was successfully removed.
            return True

    # Return a safe copy of the current inventory for display or scheduling.
    def snapshot(self):
        # Acquire the lock so the snapshot represents a consistent view of the inventory.
        with self._lock:
            # Build a new list rather than exposing the registry's internal dictionaries.
            return [
                {
                    # Copy the persistent identity of the physical device.
                    "device_id": device["device_id"],

                    # Copy the reported computer name.
                    "hostname": device["hostname"],

                    # Copy whether the physical device is currently online.
                    "status": device["status"],

                    # Deep-copy resources so callers cannot modify stored hardware reports.
                    "resources": copy.deepcopy(device["resources"]),

                    # Report the number of active worker connections for this device.
                    "active_sessions": len(device["sessions"]),

                    # Copy when the device first connected to this running HQ process.
                    "connected_at": device["connected_at"],

                    # Copy the most recent heartbeat or resource-report timestamp.
                    "last_seen": device["last_seen"],
                }
                # Include each physical device exactly once in the returned inventory.
                for device in self._devices.values()
            ]
