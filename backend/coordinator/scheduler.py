
# Import math to calculate normalized resource utilization safely.
import math

# Import threading to protect scheduling operations from concurrent calls.
import threading


# Define the scheduler that assigns pending tasks to available physical devices.
class Scheduler:
    # Initialize the scheduler with the shared task and resource managers.
    def __init__(self, task_manager, resource_manager):
        # Store the task manager that owns task records and lifecycle states.
        self.task_manager = task_manager

        # Store the resource manager that calculates capacity and creates reservations.
        self.resource_manager = resource_manager

        # Prevent two scheduling operations from assigning the same pending task simultaneously.
        self.lock = threading.RLock()

    # Calculate how suitable a device is for a particular task.
    @staticmethod
    def _calculate_fit_score(capacity, cpu_required, memory_required):
        # Read the CPU capacity currently available for new tasks.
        available_cpu = capacity["available_cpu_cores"]

        # Read the memory capacity currently available for new tasks.
        available_memory = capacity["available_memory_mb"]

        # Calculate the CPU capacity that would remain after assigning the task.
        remaining_cpu = available_cpu - cpu_required

        # Calculate the memory capacity that would remain after assigning the task.
        remaining_memory = available_memory - memory_required

        # Normalize remaining CPU against the device's current available CPU.
        cpu_score = remaining_cpu / max(available_cpu, 0.000001)

        # Normalize remaining memory against the device's current available memory.
        memory_score = remaining_memory / max(available_memory, 0.000001)

        # Combine both resource scores so neither CPU nor memory dominates solely because of its units.
        return cpu_score + memory_score

    # Find eligible devices and choose the best fit for a task.
    def _select_device(self, task):
        # Read the amount of CPU capacity requested by this task.
        cpu_required = task["requirements"]["cpu_cores"]

        # Read the amount of memory requested by this task.
        memory_required = task["requirements"]["memory_mb"]

        # Retrieve all currently online devices and their resource capacities.
        devices = self.resource_manager.get_pool()

        # Create a list containing devices capable of running this task.
        candidates = []

        # Examine each online device in the resource pool.
        for device in devices:
            # Read the nested capacity information for this physical device.
            capacity = device["capacity"]

            # Skip devices that do not have enough available CPU capacity.
            if capacity["available_cpu_cores"] < cpu_required:
                # Continue checking the remaining devices.
                continue

            # Skip devices that do not have enough available memory.
            if capacity["available_memory_mb"] < memory_required:
                # Continue checking the remaining devices.
                continue

            # Calculate how much normalized capacity would remain after assignment.
            score = self._calculate_fit_score(capacity, cpu_required, memory_required)

            # Store the device and its score for ranking.
            candidates.append((score, device))

        # Sort candidates so the device with the smallest remaining capacity is considered first.
        candidates.sort(key=lambda candidate: candidate[0])

        # Return the ranked list of eligible devices.
        return candidates

    # Schedule one task by selecting a device and reserving its resources.
    def schedule_task(self, task_id):
        # Acquire the scheduler lock to prevent competing scheduling operations.
        with self.lock:
            # Retrieve the latest task record from the task manager.
            task = self.task_manager.get_task(task_id)

            # Reject task IDs that do not exist.
            if task is None:
                # Explain that the scheduler cannot find this task.
                raise ValueError(f"Unknown task ID: {task_id}")

            # Only tasks waiting in PENDING can be scheduled.
            if task["status"] != "PENDING":
                # Return no assignment when the task is already being handled.
                return None

            # Find devices with enough available CPU and memory.
            candidates = self._select_device(task)

            # Try eligible devices in best-fit order.
            for score, device in candidates:
                # Read the selected physical device's persistent identifier.
                device_id = device["device_id"]

                # Read the CPU requirement from the task record.
                cpu_required = task["requirements"]["cpu_cores"]

                # Read the memory requirement from the task record.
                memory_required = task["requirements"]["memory_mb"]

                # Attempt to reserve the required resources on the selected device.
                try:
                    # Create a reservation so another task cannot consume the same capacity.
                    self.resource_manager.reserve(
                        device_id,
                        task_id,
                        cpu_required,
                        memory_required,
                    )

                # Try the next device if its capacity changed or the reservation cannot be made.
                except ValueError:
                    # Continue through the remaining eligible devices.
                    continue

                # Assign the task to the device after the reservation succeeds.
                try:
                    # Update the task lifecycle and record its assigned device.
                    assigned_task = self.task_manager.assign_task(task_id, device_id)

                # Release the reservation if task assignment fails.
                except Exception:
                    # Prevent resources from remaining reserved for an unassigned task.
                    self.resource_manager.release(task_id)

                    # Propagate the original assignment error for diagnosis.
                    raise

                # Return the assigned task and the selected device's identity.
                return {
                    # Include the updated task record.
                    "task": assigned_task,

                    # Include the identifier of the selected physical computer.
                    "device_id": device_id,

                    # Include the calculated best-fit score for diagnostics.
                    "fit_score": score,
                }

            # Return None when no online device can satisfy the task requirements.
            return None

    # Attempt to schedule every task that is currently pending.
    def schedule_pending(self):
        # Acquire the scheduler lock before processing the pending task collection.
        with self.lock:
            # Retrieve a snapshot of all known tasks.
            tasks = self.task_manager.list_tasks()

            # Create a list that will contain successful task assignments.
            assignments = []

            # Examine each task in the snapshot.
            for task in tasks:
                # Ignore tasks that are no longer waiting for scheduling.
                if task["status"] != "PENDING":
                    # Continue to the next task.
                    continue

                # Attempt to assign the current pending task to an eligible device.
                assignment = self.schedule_task(task["task_id"])

                # Record the assignment when a suitable device was found.
                if assignment is not None:
                    # Add the successful assignment to the result collection.
                    assignments.append(assignment)

            # Return all assignments completed during this scheduling pass.
            return assignments
