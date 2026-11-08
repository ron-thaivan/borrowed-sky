
# Import copy so callers cannot accidentally modify the task manager's internal records.
import copy
# Import math to reject invalid floating-point resource requirements.
import math
# Import threading to protect shared task records from concurrent access.
import threading
# Import time to record task creation and update timestamps.
import time
# Import uuid to generate a unique identifier for every submitted task.
import uuid


# Define the task manager responsible for creating and tracking jobs.
class TaskManager:
    # Define the only task types workers will initially be allowed to execute.
    SUPPORTED_TASK_TYPES = {"SUM_RANGE", "COUNT_PRIMES"}

    # Define which state transitions are permitted throughout a task's lifecycle.
    ALLOWED_TRANSITIONS = {
        "PENDING": {"SCHEDULED", "CANCELLED"},
        "SCHEDULED": {"RUNNING", "FAILED", "CANCELLED"},
        "RUNNING": {"COMPLETED", "FAILED", "CANCELLED"},
        "COMPLETED": set(),
        "FAILED": set(),
        "CANCELLED": set(),
    }

    # Initialize the task manager and its shared task storage.
    def __init__(self):
        # Store task records using their unique task IDs as dictionary keys.
        self.tasks = {}
        # Create a reentrant lock to protect task operations across threads.
        self.lock = threading.RLock()

    # Validate that a task input is an integer and not a Boolean value.
    @staticmethod
    def _validate_integer(value, field_name):
        # Reject Booleans because Python treats True and False as integers.
        if isinstance(value, bool) or not isinstance(value, int):
            # Explain which task input failed validation.
            raise ValueError(f"{field_name} must be an integer")

    # Validate the operation and its input before accepting a task.
    def _validate_payload(self, task_type, payload):
        # Require task inputs to be provided as a dictionary.
        if not isinstance(payload, dict):
            # Reject inputs that cannot be safely interpreted.
            raise ValueError("Task payload must be a dictionary")

        # Require both supported operations to use start and end values.
        if set(payload.keys()) != {"start", "end"}:
            # Reject missing or unexpected task input fields.
            raise ValueError("Task payload must contain exactly start and end")

        # Read the beginning of the requested integer range.
        start = payload["start"]
        # Read the end of the requested integer range.
        end = payload["end"]

        # Ensure the beginning of the range is an integer.
        self._validate_integer(start, "start")
        # Ensure the end of the range is an integer.
        self._validate_integer(end, "end")

        # Reject ranges that run backward.
        if start > end:
            # Explain that the range boundaries are invalid.
            raise ValueError("Task start cannot be greater than task end")

        # Calculate the number of integers included in the range.
        range_size = end - start + 1

        # Apply a stricter range limit to the more expensive prime-counting task.
        if task_type == "COUNT_PRIMES" and range_size > 500_000:
            # Prevent an initial test workload from consuming excessive resources.
            raise ValueError("COUNT_PRIMES range cannot exceed 500000 integers")

        # Limit the range size for the sum operation as well.
        if task_type == "SUM_RANGE" and range_size > 10_000_000:
            # Prevent unreasonably large initial task submissions.
            raise ValueError("SUM_RANGE range cannot exceed 10000000 integers")

        # Return a separate copy of the validated task inputs.
        return copy.deepcopy(payload)

    # Validate a requested CPU or memory allocation.
    @staticmethod
    def _validate_requirement(value, field_name):
        # Reject Booleans, non-numeric values, and non-finite numbers.
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            # Explain that the resource requirement must be a finite number.
            raise ValueError(f"{field_name} must be a finite number")

        # Reject zero and negative resource requirements.
        if value <= 0:
            # Explain that tasks must request positive resources.
            raise ValueError(f"{field_name} must be greater than zero")

        # Return the validated requirement as a floating-point number.
        return float(value)

    # Create and store a new task in the PENDING state.
    def create_task(self, task_type, payload, cpu_cores=1.0, memory_mb=128.0):
        # Reject operations that are not in the supported task allowlist.
        if task_type not in self.SUPPORTED_TASK_TYPES:
            # Explain which task types are currently accepted.
            raise ValueError(f"Unsupported task type: {task_type}")

        # Validate and copy the operation's input values.
        validated_payload = self._validate_payload(task_type, payload)

        # Validate how much CPU capacity the task requests.
        validated_cpu = self._validate_requirement(cpu_cores, "cpu_cores")

        # Validate how much memory the task requests.
        validated_memory = self._validate_requirement(memory_mb, "memory_mb")

        # Generate a unique identifier for this task.
        task_id = str(uuid.uuid4())

        # Capture the creation time for task history and diagnostics.
        current_time = time.time()

        # Build the complete task record before storing it.
        task = {
            # Store the unique identifier used by the scheduler and workers.
            "task_id": task_id,
            # Store the allowlisted operation that the worker will execute.
            "task_type": task_type,
            # Store the validated input parameters for the operation.
            "payload": validated_payload,
            # Store the resources requested by the task.
            "requirements": {
                "cpu_cores": validated_cpu,
                "memory_mb": validated_memory,
            },
            # Mark new tasks as waiting for scheduler assignment.
            "status": "PENDING",
            # Reserve a field for the device selected by the scheduler.
            "assigned_device": None,
            # Reserve a field for the operation's eventual result.
            "result": None,
            # Reserve a field for any execution failure details.
            "error": None,
            # Record when the task was originally submitted.
            "created_at": current_time,
            # Record when the task record was last modified.
            "updated_at": current_time,
        }

        # Acquire the lock before modifying the shared task dictionary.
        with self.lock:
            # Store the new task using its unique identifier.
            self.tasks[task_id] = task

        # Return a copy so external code cannot modify internal task state.
        return copy.deepcopy(task)

    # Change a task's status while enforcing valid lifecycle transitions.
    def _transition(self, task_id, new_status):
        # Acquire the lock before reading or changing a task.
        with self.lock:
            # Look up the task and report an error if it does not exist.
            task = self.tasks.get(task_id)

            # Reject references to unknown tasks.
            if task is None:
                # Explain that the requested task ID is not registered.
                raise ValueError(f"Unknown task ID: {task_id}")

            # Read the task's current status.
            current_status = task["status"]

            # Check whether the requested transition is allowed.
            if new_status not in self.ALLOWED_TRANSITIONS[current_status]:
                # Reject transitions that would violate the task lifecycle.
                raise ValueError(f"Invalid task transition: {current_status} -> {new_status}")

            # Update the task's status after validation succeeds.
            task["status"] = new_status

            # Refresh the task's modification timestamp.
            task["updated_at"] = time.time()

            # Return a safe copy of the updated task.
            return copy.deepcopy(task)

    # # Assign a pending task to a selected physical device.
    # def assign_task(self, task_id, device_id):
    #     # Require the scheduler to provide a nonempty device identifier.
    #     if not isinstance(device_id, str) or not device_id.strip():
    #         # Reject invalid device assignments.
    #         raise ValueError("device_id must be a nonempty string")

    #     # Transition the task from PENDING to SCHEDULED.
    #     task = self._transition(task_id, "SCHEDULED")

    #     # Acquire the lock before attaching the selected device.
    #     with self.lock:
    #         # Store which physical computer has been selected for this task.
    #         self.tasks[task_id]["assigned_device"] = device_id

    #         # Return the updated task record.
    #         return copy.deepcopy(self.tasks[task_id])

        

    # Assign a pending task to a selected physical device.
    def assign_task(self, task_id, device_id):
        # Require the scheduler to provide a nonempty device identifier.
        if not isinstance(device_id, str) or not device_id.strip():
            # Reject invalid device assignments.
            raise ValueError("device_id must be a nonempty string")

        # Acquire the lock so assignment and status changes happen atomically.
        with self.lock:
            # Look up the task that the scheduler wants to assign.
            task = self.tasks.get(task_id)

            # Reject references to tasks that do not exist.
            if task is None:
                # Explain that the requested task ID is not registered.
                raise ValueError(f"Unknown task ID: {task_id}")

            # Ensure that only pending tasks can be assigned.
            if task["status"] != "PENDING":
                # Reject tasks that have already been assigned or completed.
                raise ValueError(f"Cannot assign task in state: {task['status']}")

            # Change the task status to indicate that a worker was selected.
            task["status"] = "SCHEDULED"

            # Record the physical device selected by the scheduler.
            task["assigned_device"] = device_id

            # Refresh the task's modification timestamp.
            task["updated_at"] = time.time()

            # Return a safe copy of the assigned task.
            return copy.deepcopy(task)











    # Mark a scheduled task as actively executing on its assigned worker.
    def mark_running(self, task_id):
        # Transition the task from SCHEDULED to RUNNING.
        return self._transition(task_id, "RUNNING")

    # Store the successful result returned by a worker.
    # Mark a task completed and store its result as one atomic operation.
    def complete_task(self, task_id, result):
        # Acquire the task-manager lock before changing the task record.
        with self.lock:
            # Retrieve the task using its actual dictionary attribute.
            task = self.tasks.get(task_id)

            # Reject task IDs that do not exist.
            if task is None:
                # Explain which task could not be completed.
                raise ValueError(f"Unknown task ID: {task_id}")

            # Check whether the current state allows a transition to COMPLETED.
            if "COMPLETED" not in self.ALLOWED_TRANSITIONS.get(task["status"], set()):
                # Reject invalid or duplicate completion messages.
                raise ValueError(
                    f"Cannot complete task {task_id} from state {task['status']}"
                )

            # Store the result before exposing the completed state.
            task["result"] = result

            # Change the lifecycle state after the result has been stored.
            task["status"] = "COMPLETED"

            # Update the task's modification timestamp.
            task["updated_at"] = time.time()

            # Return a deep copy so callers cannot modify the internal task record.
            return copy.deepcopy(task)

    # Record an execution or scheduling failure.
    def fail_task(self, task_id, error):
        # Require failure details to be represented as readable text.
        if not isinstance(error, str):
            # Reject invalid error descriptions.
            raise ValueError("error must be a string")

        # Acquire the lock before examining the current task state.
        with self.lock:
            # Look up the task that experienced the failure.
            task = self.tasks.get(task_id)

            # Reject references to tasks that do not exist.
            if task is None:
                # Explain that the requested task ID is not registered.
                raise ValueError(f"Unknown task ID: {task_id}")

            # Read the current state before selecting a valid failure transition.
            current_status = task["status"]

            # Allow failures only before a task reaches a terminal state.
            if current_status not in {"SCHEDULED", "RUNNING"}:
                # Reject failures reported for tasks that cannot fail in their current state.
                raise ValueError(f"Cannot fail task in state: {current_status}")

            # Transition the task into the FAILED state.
            task["status"] = "FAILED"

            # Save the error details for inspection by HQ or the frontend.
            task["error"] = error

            # Refresh the task's modification timestamp.
            task["updated_at"] = time.time()

            # Return a safe copy of the failed task.
            return copy.deepcopy(task)

    # Cancel a task that has not yet reached a terminal state.
    def cancel_task(self, task_id):
        # Transition the task into the CANCELLED state.
        return self._transition(task_id, "CANCELLED")

    # Retrieve one task using its unique identifier.
    def get_task(self, task_id):
        # Acquire the lock while reading shared task information.
        with self.lock:
            # Look up the requested task.
            task = self.tasks.get(task_id)

            # Return None when the task ID is unknown.
            if task is None:
                # Indicate that no matching task exists.
                return None

            # Return a copy that cannot mutate the stored record.
            return copy.deepcopy(task)

    # Retrieve copies of every task currently known to HQ.
    def list_tasks(self):
        # Acquire the lock while reading the task collection.
        with self.lock:
            # Return independent copies of all stored task records.
            return copy.deepcopy(list(self.tasks.values()))
