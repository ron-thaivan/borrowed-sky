# Import json so the API can read incoming requests and return JSON responses.
import json

# Import threading so the HTTP API can run separately from the TCP coordinator.
import threading

# Import BaseHTTPRequestHandler to define the API's HTTP request behavior.
from http.server import BaseHTTPRequestHandler

# Import ThreadingHTTPServer so multiple frontend requests can be handled concurrently.
from http.server import ThreadingHTTPServer

# Define the maximum accepted HTTP request body size.
MAX_REQUEST_SIZE = 1024 * 1024


# Define the HTTP handler used by the coordinator API.
class CoordinatorAPIHandler(BaseHTTPRequestHandler):

    # Send a JSON response with the requested HTTP status code.
    def send_json(self, status_code, data):
        # Convert the response dictionary into UTF-8 JSON bytes.
        response_body = json.dumps(data).encode("utf-8")

        # Set the HTTP response status.
        self.send_response(status_code)

        # Tell the client that the response contains JSON.
        self.send_header("Content-Type", "application/json")

        # Allow browser-based frontend requests during local development.
        self.send_header("Access-Control-Allow-Origin", "*")

        # Tell the client how many bytes are in the response.
        self.send_header("Content-Length", str(len(response_body)))

        # Finish writing the HTTP response headers.
        self.end_headers()

        # Send the JSON response body to the client.
        self.wfile.write(response_body)

    # Handle browser preflight requests used by cross-origin frontend requests.
    def do_OPTIONS(self):
        # Return a successful response for the browser's preflight check.
        self.send_response(204)

        # Allow the HTTP methods supported by this initial API.
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        # Allow the headers used by JSON requests.
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

        # Allow local development frontend origins.
        self.send_header("Access-Control-Allow-Origin", "*")

        # Finish the preflight response.
        self.end_headers()

    # Handle requests that retrieve coordinator information.
    def do_GET(self):
        # Retrieve the shared HQ server and its managers.
        coordinator = self.server.coordinator

        # Read the requested API path.
        path = self.path.split("?", 1)[0]

        # Return an overview of the coordinator and its connected devices.
        if path == "/api/status":
            # Return the current connected worker IDs and device count.
            self.send_json(200, {
                "status": "online",
                "connected_workers": coordinator.connection_manager.get_connected_devices(),
                "device_count": len(coordinator.registry.snapshot()),
                "task_count": len(coordinator.task_manager.list_tasks()),
            })

        # Return the currently registered physical devices.
        elif path == "/api/devices":
            # Read the device registry without exposing its internal dictionary.
            devices = coordinator.registry.snapshot()

            # Read each online device's currently available resource capacity.
            resource_pool = coordinator.resource_manager.get_pool()

            # Return both device information and allocatable resource information.
            self.send_json(200, {
                "devices": devices,
                "resource_pool": resource_pool,
            })

        # Return all tasks known to the coordinator.
        elif path == "/api/tasks":
            # Retrieve a safe task listing from the task manager.
            tasks = coordinator.task_manager.list_tasks()

            # Return the task list to the client.
            self.send_json(200, {"tasks": tasks})

        # Return the details of one specific task.
        elif path.startswith("/api/tasks/"):
            # Extract the task ID from the final part of the URL.
            task_id = path.rsplit("/", 1)[-1]

            # Retrieve the requested task.
            task = coordinator.task_manager.get_task(task_id)

            # Return a not-found response if the task ID is unknown.
            if task is None:
                self.send_json(404, {"error": "Task not found."})

            # Return the task details when it exists.
            else:
                self.send_json(200, {"task": task})

        # Reject paths that are not part of the API.
        else:
            # Return a not-found response for an unsupported endpoint.
            self.send_json(404, {"error": "Endpoint not found."})

    # Handle requests that submit new work to the distributed system.
    def do_POST(self):
        # Retrieve the shared HQ server and its task service.
        coordinator = self.server.coordinator

        # Read the requested API path.
        path = self.path.split("?", 1)[0]

        # Only task submission is supported by this initial POST endpoint.
        if path != "/api/tasks":
            # Return a not-found response for unsupported POST endpoints.
            self.send_json(404, {"error": "Endpoint not found."})
            return

        # Read the size of the incoming request body.
        content_length = int(self.headers.get("Content-Length", "0"))

        # Reject empty or excessively large request bodies.
        if content_length <= 0 or content_length > MAX_REQUEST_SIZE:
            # Return a client error explaining the body-size restriction.
            self.send_json(400, {"error": "Invalid or oversized request body."})
            return

        # Read the request body and decode its JSON representation.
        try:
            # Parse the request body into a Python dictionary.
            request_data = json.loads(self.rfile.read(content_length).decode("utf-8"))

        # Handle malformed JSON or invalid UTF-8.
        except (json.JSONDecodeError, UnicodeDecodeError):
            # Return a clear client error for invalid JSON.
            self.send_json(400, {"error": "Request body must contain valid JSON."})
            return

        # Ensure the parsed request is a JSON object.
        if not isinstance(request_data, dict):
            # Reject arrays, strings, and other non-object request bodies.
            self.send_json(400, {"error": "Request body must be a JSON object."})
            return

        # Extract the requested workload type.
        task_type = request_data.get("task_type")

        # Extract the workload's operation-specific input.
        payload = request_data.get("payload")

        # Extract the requested CPU reservation, defaulting to one core.
        cpu_cores = request_data.get("cpu_cores", 1.0)

        # Extract the requested memory reservation, defaulting to 128 MB.
        memory_mb = request_data.get("memory_mb", 128.0)

        # Ensure the required task fields were supplied.
        if not isinstance(task_type, str) or not isinstance(payload, dict):
            # Return a client error when required fields are missing or invalid.
            self.send_json(400, {
                "error": "Request must include a task_type string and payload object."
            })
            return

        # Ask the task service to create, schedule, and dispatch the task.
        try:
            # Submit the task using the requested resource requirements.
            task = coordinator.task_service.submit_task(
                task_type,
                payload,
                cpu_cores,
                memory_mb,
            )

        # Handle invalid task types, invalid payloads, and scheduling errors.
        except (ValueError, TypeError) as error:
            # Return a client error describing why the task was rejected.
            self.send_json(400, {"error": str(error)})
            return

        # Return a server error if the task was created but dispatch failed.
        if task["status"] == "FAILED":
            # Include the failed task so the client can inspect its state.
            self.send_json(503, {
                "error": task.get("error", "Task dispatch failed."),
                "task": task,
            })
            return

        # Return the created task, whether scheduled or waiting for capacity.
        self.send_json(202, {
            "message": "Task accepted by the coordinator.",
            "task": task,
        })

    # Keep the development server's console output concise.
    def log_message(self, format_string, *args):
        # Print a short API prefix followed by the HTTP request information.
        print(f"[API] {format_string % args}")


# Start the HTTP API in a background thread alongside the TCP coordinator.
def start_api(coordinator, host="127.0.0.1", port=8080):
    # Create the threaded HTTP server using the API request handler.
    api_server = ThreadingHTTPServer((host, port), CoordinatorAPIHandler)

    # Give the HTTP handler access to the coordinator's shared managers.
    api_server.coordinator = coordinator

    # Create a background thread that runs the HTTP server.
    api_thread = threading.Thread(
        target=api_server.serve_forever,
        daemon=True,
    )

    # Start accepting HTTP requests without blocking the TCP coordinator.
    api_thread.start()

    # Display the address where the API can be reached locally.
    print(f"[API] Listening on http://{host}:{port}")

    # Return the server so HQ can shut it down cleanly.
    return api_server