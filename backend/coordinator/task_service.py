# Import threading to prevent overlapping scheduling and dispatch passes.
import threading


# Coordinate task creation, scheduling, dispatch, and worker-disconnect cleanup.
class TaskService:

    # Receive the managers owned by the coordinator.
    def __init__(self, task_manager, scheduler, resource_manager, connection_manager):
        # Store the task manager that owns task records and lifecycle states.
        self.task_manager = task_manager

        # Store the scheduler that selects workers and reserves resources.
        self.scheduler = scheduler

        # Store the resource manager that tracks task reservations.
        self.resource_manager = resource_manager

        # Store the connection manager that sends messages to workers.
        self.connection_manager = connection_manager

        # Prevent simultaneous service calls from dispatching the same assignments.
        self.lock = threading.RLock()

    # Send one already-scheduled task to its assigned worker.
    def _dispatch_assignment(self, assignment):
        # Extract the task record produced by the scheduler.
        assigned_task = assignment["task"]

        # Extract the physical device selected by the scheduler.
        device_id = assignment["device_id"]

        # Extract the unique task identifier.
        task_id = assigned_task["task_id"]

        # Construct the payload expected by the worker runtime.
        message_payload = {
            # Identify the task the worker must execute.
            "task_id": task_id,
            # Identify the allowlisted operation the worker must execute.
            "task_type": assigned_task["task_type"],
            # Provide the validated input data for that operation.
            "task_payload": assigned_task["payload"],
            # Provide the task's requested resource amounts.
            "requirements": assigned_task["requirements"],
        }

        # Attempt to send the task to the selected worker.
        try:
            # Send the JOB_SUBMIT message over the worker's registered socket.
            sent = self.connection_manager.send_to_device(
                # Target the device selected by the scheduler.
                device_id,
                # Tell the worker to execute a task.
                "JOB_SUBMIT",
                # Include the task details.
                message_payload,
            )

            # Treat a missing or failed connection as a dispatch failure.
            if not sent:
                # Raise an error so the reservation and task state are cleaned up.
                raise ConnectionError("Selected worker is no longer connected.")

        # Handle dispatch failures without leaving tasks stuck as scheduled.
        except Exception as error:
            # Mark the scheduled task as failed with the dispatch error.
            self.task_manager.fail_task(task_id, str(error))

            # Release the CPU and memory reserved for this task.
            self.resource_manager.release(task_id)

            # Return the latest failed task record.
            return self.task_manager.get_task(task_id)

        # Return the current task record after successful local socket delivery.
        return self.task_manager.get_task(task_id)

    # Schedule and dispatch every pending task that currently fits the resource pool.
    def schedule_available(self):
        # Serialize service-level scheduling and dispatch operations.
        with self.lock:
            # Ask the scheduler to assign all currently eligible pending tasks.
            assignments = self.scheduler.schedule_pending()

            # Store the latest state of each task dispatched in this pass.
            dispatched_tasks = []

            # Process each assignment returned by the scheduler.
            for assignment in assignments:
                # Dispatch the assigned task to its selected worker.
                task = self._dispatch_assignment(assignment)

                # Record the task's latest state for the caller.
                dispatched_tasks.append(task)

            # Return the task records processed during this scheduling pass.
            return dispatched_tasks

    # Create a task and immediately try to schedule it.
    def submit_task(self, task_type, payload, cpu_cores=1.0, memory_mb=128.0):
        # Create a new task in the PENDING state.
        task = self.task_manager.create_task(
            # Supply the allowlisted task type.
            task_type,
            # Supply the task's input payload.
            payload,
            # Supply its requested CPU capacity.
            cpu_cores,
            # Supply its requested memory capacity.
            memory_mb,
        )

        # Run a scheduling pass so the new task can be dispatched if possible.
        self.schedule_available()

        # Return the latest task state, whether pending, scheduled, or failed.
        return self.task_manager.get_task(task["task_id"])

    # Mark unfinished tasks assigned to a disconnected worker as failed.
    def handle_worker_disconnect(self, device_id):
        # Serialize disconnect cleanup with task dispatch operations.
        with self.lock:
            # Retrieve a snapshot of every task known to the task manager.
            tasks = self.task_manager.list_tasks()

            # Store the IDs of tasks that were failed during cleanup.
            failed_task_ids = []

            # Examine each task in the snapshot.
            for task in tasks:
                # Ignore tasks assigned to other physical devices.
                if task["assigned_device"] != device_id:
                    # Continue checking the remaining tasks.
                    continue

                # Read the task's current lifecycle state.
                status = task["status"]

                # Only scheduled or running tasks can be failed by this event.
                if status not in ("SCHEDULED", "RUNNING"):
                    # Ignore pending and terminal tasks.
                    continue

                # Extract the task's unique identifier.
                task_id = task["task_id"]

                # Record why the coordinator can no longer track execution.
                error = "Worker disconnected before task completion was confirmed."

                # Mark the task as failed.
                self.task_manager.fail_task(task_id, error)

                # Release resources reserved on the disconnected worker.
                self.resource_manager.release(task_id)

                # Record the task ID for diagnostics.
                failed_task_ids.append(task_id)

            # Return the IDs of tasks that were affected by this disconnect.
            return failed_task_ids