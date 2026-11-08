
# Import threading so concurrent scheduling requests cannot reserve the same capacity.
import threading

# Import math to reject invalid numeric resource requirements.
import math


# Define the manager responsible for calculating and reserving device resources.
class ResourceManager:
    # Initialize the manager with the shared physical-device registry.
    def __init__(self, registry):
        # Keep a reference to the registry so capacity comes from current device reports.
        self.registry = registry

        # Store reservations by physical device, with task IDs identifying each reservation.
        self.reservations = {}

        # Protect reservation changes from concurrent scheduler operations.
        self.lock = threading.RLock()

        # Limit distributed CPU usage to an 80 percent utilization target.
        self.cpu_utilization_limit = 80.0

        # Make only 80 percent of reported available RAM eligible for distributed tasks.
        self.memory_safety_factor = 0.80

    # Check that a resource requirement is a finite positive number.
    def _validate_requirement(self, value, field_name):
        # Reject booleans and values that are not integers or floating-point numbers.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{field_name} must be a number")

        # Reject zero, negative, infinite, and NaN resource requirements.
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f"{field_name} must be a finite positive number")

    # Calculate the safe allocatable capacity for one physical device.
    def _calculate_capacity(self, device):
        # Read the latest hardware report stored for this physical device.
        resources = device["resources"]

        # Read the number of logical CPU cores reported by the worker.
        logical_cores = resources.get("logical_cores", 0)

        # Read the current CPU utilization percentage reported by the worker.
        cpu_percent = resources.get("cpu_percent", 100)

        # Read the amount of currently available RAM in megabytes.
        available_memory_mb = resources.get("available_memory_mb", 0)

        # Reject invalid CPU-core values instead of treating them as usable capacity.
        if isinstance(logical_cores, bool) or not isinstance(logical_cores, (int, float)) or logical_cores <= 0:
            logical_cores = 0

        # Reject invalid CPU utilization values and conservatively treat them as fully busy.
        if isinstance(cpu_percent, bool) or not isinstance(cpu_percent, (int, float)) or not math.isfinite(cpu_percent):
            cpu_percent = 100

        # Keep CPU utilization within its valid percentage range.
        cpu_percent = max(0.0, min(100.0, float(cpu_percent)))

        # Reject invalid memory values instead of reporting negative or unusable RAM.
        if isinstance(available_memory_mb, bool) or not isinstance(available_memory_mb, (int, float)) or available_memory_mb < 0:
            available_memory_mb = 0

        # Calculate how many logical cores can be allocated without exceeding the CPU target.
        available_cpu_cores = logical_cores * max(
            0.0,
            (self.cpu_utilization_limit - cpu_percent) / 100.0,
        )

        # Apply a safety margin so distributed tasks do not consume all reported free RAM.
        available_memory_mb = available_memory_mb * self.memory_safety_factor

        # Return the safe CPU and memory capacity for this physical device.
        return {
            "cpu_cores": available_cpu_cores,
            "memory_mb": available_memory_mb,
        }

    # Return the currently available capacity for one online physical device.
    def get_device_capacity(self, device_id):
        # Acquire the lock so capacity calculations see consistent reservations.
        with self.lock:
            # Find the requested physical device in the current registry snapshot.
            device = next(
                (
                    item
                    for item in self.registry.snapshot()
                    if item["device_id"] == device_id
                ),
                None,
            )

            # Return no capacity if the device is unknown or offline.
            if device is None or device["status"] != "online":
                return None

            # Calculate the safe capacity based on the latest hardware report.
            capacity = self._calculate_capacity(device)

            # Start with zero reserved CPU and memory for this device.
            reserved_cpu = 0.0
            reserved_memory = 0.0

            # Find all tasks currently reserving resources on this physical device.
            for reservation in self.reservations.get(device_id, {}).values():
                # Add each task's reserved CPU requirement.
                reserved_cpu += reservation["cpu_cores"]

                # Add each task's reserved memory requirement.
                reserved_memory += reservation["memory_mb"]

            # Subtract reserved CPU from the device's safe CPU capacity.
            remaining_cpu = max(0.0, capacity["cpu_cores"] - reserved_cpu)

            # Subtract reserved RAM from the device's safe memory capacity.
            remaining_memory = max(0.0, capacity["memory_mb"] - reserved_memory)

            # Return both total safe capacity and capacity remaining after reservations.
            return {
                "cpu_capacity": capacity["cpu_cores"],
                "memory_capacity_mb": capacity["memory_mb"],
                "reserved_cpu_cores": reserved_cpu,
                "reserved_memory_mb": reserved_memory,
                "available_cpu_cores": remaining_cpu,
                "available_memory_mb": remaining_memory,
            }

    # Reserve resources on one physical device for a particular task.
    def reserve(self, device_id, task_id, cpu_cores, memory_mb):
        # Validate the requested CPU allocation before changing reservation records.
        self._validate_requirement(cpu_cores, "cpu_cores")

        # Validate the requested memory allocation before changing reservation records.
        self._validate_requirement(memory_mb, "memory_mb")

        # Reject missing task identifiers before creating a reservation.
        if not isinstance(task_id, str) or not task_id:
            raise ValueError("task_id must be a non-empty string")

        # Acquire the lock so two tasks cannot reserve the same remaining capacity.
        with self.lock:
            # Calculate the device's remaining capacity after existing reservations.
            capacity = self.get_device_capacity(device_id)

            # Reject unknown or offline devices.
            if capacity is None:
                raise ValueError("Device is unknown or offline")

            # Reject a task if the device does not have enough remaining CPU capacity.
            if cpu_cores > capacity["available_cpu_cores"]:
                raise ValueError("Insufficient available CPU capacity")

            # Reject a task if the device does not have enough remaining RAM.
            if memory_mb > capacity["available_memory_mb"]:
                raise ValueError("Insufficient available memory")

            # Create the reservation collection for this device if it does not exist.
            device_reservations = self.reservations.setdefault(device_id, {})

            # Reject a task ID that is already reserved anywhere in the resource pool.
            if any(
                task_id in reservations
                for reservations in self.reservations.values()
            ):
                raise ValueError("Task already has a resource reservation")

            # Store the amount of CPU and memory assigned to this task.
            device_reservations[task_id] = {
                "cpu_cores": float(cpu_cores),
                "memory_mb": float(memory_mb),
            }

            # Confirm that the reservation was successfully recorded.
            return True

    # Release the resources reserved by a completed, cancelled, or failed task.
    def release(self, task_id):
        # Acquire the lock so reservation removal cannot conflict with another operation.
        with self.lock:
            # Search every device because the caller supplies the task ID, not its device.
            for device_id, device_reservations in self.reservations.items():
                # Check whether this physical device contains the requested task reservation.
                if task_id in device_reservations:
                    # Remove the task's reservation so its resources become available again.
                    del device_reservations[task_id]

                    # Confirm that the reservation was successfully released.
                    return True

            # Report that no reservation existed for the supplied task ID.
            return False

    # Return the current capacity of every online physical device.
    def get_pool(self):
        # Acquire the lock so the returned pool reflects consistent reservations.
        with self.lock:
            # Create a list that will contain capacity information for online devices.
            pool = []

            # Read the current physical-device inventory from the registry.
            for device in self.registry.snapshot():
                # Ignore offline devices because they cannot accept new work.
                if device["status"] != "online":
                    continue

                # Calculate the device's remaining allocatable capacity.
                capacity = self.get_device_capacity(device["device_id"])

                # add device identity and capacity info to pool
                pool.append({
                    "device_id": device["device_id"],   # identify physical device
                    "hostname": device["hostname"],     # provide device readable name
                    "capacity": capacity,               # Store capacity as a nested dictionary for coordinator display
                })
                # # Add the device identity and capacity information to the pool.
                # pool.append({
                #     "device_id": device["device_id"],
                #     "hostname": device["hostname"],
                #     **capacity,
                # })

            # Return the complete list of online devices and their available capacity.
            return pool
