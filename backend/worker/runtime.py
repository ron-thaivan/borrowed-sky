
# Import select so the worker can check for incoming messages without blocking its heartbeat loop.
import select

# Import threading so task cancellation can be communicated safely.
import threading

# Import time for heartbeat and resource-update scheduling.
import time

# Import queue so background task threads can return results to the network loop.
import queue

# Import ThreadPoolExecutor so task execution does not block network communication.
from concurrent.futures import ThreadPoolExecutor

# Import the shared protocol helpers used by HQ and workers.
from backend.common.protocol import create_message, receive_message, send_message

# Import the supported task executor and its cancellation exception.
from backend.worker.executor import execute_task, TaskCancelled


# Define the worker's communication intervals.
HEARTBEAT_INTERVAL = 5
RESOURCE_UPDATE_INTERVAL = 15


# Run the worker's main communication and task-processing loop.
def run_worker_loop(connection, device_id, session_id, collect_resources):
    # Create a thread pool that executes one task at a time on this worker.
    executor = ThreadPoolExecutor(max_workers=1)

    # Create a queue for task results produced by background execution threads.
    completed_tasks = queue.Queue()

    # Track cancellation events for currently running or queued tasks.
    cancellation_events = {}

    # Track task IDs so the worker does not accept duplicate submissions.
    active_tasks = set()

    # Record when the next heartbeat should be sent.
    next_heartbeat = time.monotonic() + HEARTBEAT_INTERVAL

    # Record when the next resource report should be sent.
    next_resource_update = time.monotonic() + RESOURCE_UPDATE_INTERVAL

    # Define a helper that creates and sends messages from the worker.
    def send_worker_message(message_type, payload):
        # Construct a message using this worker's persistent device and session IDs.
        message = create_message(message_type, device_id, session_id, payload)

        # Transmit the framed message to HQ.
        send_message(connection, message)

    # Define a callback that collects a completed background task.
    def collect_task_result(task_id, future):
        # Retrieve the task's result or capture its execution error.
        try:
            # Read the value returned by the task executor.
            result = future.result()

            # Place a successful result into the network loop's queue.
            completed_tasks.put({
                "task_id": task_id,
                "status": "completed",
                "result": result,
            })

        # Handle tasks that were cancelled during execution.
        except TaskCancelled as error:
            # Queue the cancellation outcome for HQ.
            completed_tasks.put({
                "task_id": task_id,
                "status": "cancelled",
                "error": str(error),
            })

        # Handle all other task execution errors.
        except Exception as error:
            # Queue the failure outcome for HQ.
            completed_tasks.put({
                "task_id": task_id,
                "status": "failed",
                "error": str(error),
            })

    # Keep the worker connected until HQ or the network closes the connection.
    try:
        # Begin the worker's main event loop.
        while True:
            # Record the current monotonic time.
            now = time.monotonic()

            # Send a heartbeat when its deadline has arrived.
            if now >= next_heartbeat:
                # Tell HQ that this worker is still alive.
                send_worker_message("HEARTBEAT", {})

                # Schedule the next heartbeat.
                next_heartbeat = now + HEARTBEAT_INTERVAL

            # Send updated hardware information when its deadline has arrived.
            if now >= next_resource_update:
                # Collect the latest CPU, memory, and hardware information.
                resources = collect_resources()

                # Send the updated resource report to HQ.
                send_worker_message("RESOURCE_UPDATE", {"resources": resources})

                # Schedule the next resource report.
                next_resource_update = now + RESOURCE_UPDATE_INTERVAL

            # Send all task results waiting in the completion queue.
            while not completed_tasks.empty():
                # Retrieve the next completed task.
                completed = completed_tasks.get()

                # Remove the task from the active task set.
                active_tasks.discard(completed["task_id"])

                # Remove its cancellation event from the tracking dictionary.
                cancellation_events.pop(completed["task_id"], None)

                # Send the successful result to HQ.
                if completed["status"] == "completed":
                    # Include the task ID and calculated result.
                    send_worker_message("JOB_RESULT", {
                        "task_id": completed["task_id"],
                        "result": completed["result"],
                    })

                # Tell HQ when a task was cancelled.
                elif completed["status"] == "cancelled":
                    # Include the task ID and cancellation explanation.
                    send_worker_message("JOB_CANCELLED", {
                        "task_id": completed["task_id"],
                        "error": completed["error"],
                    })

                # Tell HQ when task execution failed.
                else:
                    # Include the task ID and error message.
                    send_worker_message("JOB_FAILED", {
                        "task_id": completed["task_id"],
                        "error": completed["error"],
                    })

            # Calculate the time remaining until the next scheduled message.
            timeout = min(
                max(0, next_heartbeat - time.monotonic()),
                max(0, next_resource_update - time.monotonic()),
                0.25,
            )

            # Wait briefly for HQ to send a task or cancellation request.
            readable, _, _ = select.select([connection], [], [], timeout)

            # Continue the loop when no incoming message is available.
            if not readable:
                continue

            # Receive one complete framed message from HQ.
            message = receive_message(connection)

            # Exit when the connection has been closed by HQ.
            if message is None:
                break

            # Read the message type from the protocol envelope.
            message_type = message["message_type"]

            # Read the message payload from the protocol envelope.
            payload = message.get("payload", {})

            # Handle a new task submission from HQ.
            if message_type == "JOB_SUBMIT":
                # Extract the task ID.
                task_id = payload.get("task_id")

                # Extract the requested task type.
                task_type = payload.get("task_type")

                # Extract the task's operation-specific input.
                task_payload = payload.get("task_payload")

                # Reject malformed or duplicate task submissions.
                if not task_id or task_id in active_tasks or not isinstance(task_payload, dict):
                    # Inform HQ that the submission could not be accepted.
                    send_worker_message("JOB_FAILED", {
                        "task_id": task_id,
                        "error": "Invalid or duplicate task submission.",
                    })

                    # Skip the remainder of this message.
                    continue

                # Create a cancellation event for the new task.
                cancel_event = threading.Event()

                # Store the cancellation event under the task ID.
                cancellation_events[task_id] = cancel_event

                # Mark the task as active on this worker.
                active_tasks.add(task_id)

                # Submit the task to the background executor.
                future = executor.submit(
                    execute_task,
                    task_type,
                    task_payload,
                    cancel_event,
                )

                # Register a callback that queues the task's eventual outcome.
                future.add_done_callback(
                    lambda completed_future, current_id=task_id:
                    collect_task_result(current_id, completed_future)
                )

                # Tell HQ that the worker accepted the task.
                send_worker_message("JOB_ACCEPTED", {"task_id": task_id})

            # Handle a cancellation request from HQ.
            elif message_type == "JOB_CANCEL":
                # Extract the task ID to cancel.
                task_id = payload.get("task_id")

                # Find the cancellation event for that task.
                cancel_event = cancellation_events.get(task_id)

                # Signal the task to stop if it is currently known to this worker.
                if cancel_event is not None:
                    # Set the event so the executor can detect cancellation.
                    cancel_event.set()

    # Handle normal socket shutdown and communication errors.
    finally:
        # Request cancellation of tasks that have not yet completed.
        for cancel_event in cancellation_events.values():
            # Signal each task's cancellation event.
            cancel_event.set()

        # Shut down the executor without blocking the network cleanup indefinitely.
        executor.shutdown(wait=False, cancel_futures=True)
