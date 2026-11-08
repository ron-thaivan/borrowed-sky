"""Thread-safe task records with session-bound, single-use assignments."""
import copy
import math
import threading
import time
import uuid

from backend.common.workload import validate_workload
from backend.coordinator.registry import MAX_MEMORY_MB


class TaskManager:
    SUPPORTED_TASK_TYPES = {"SUM_RANGE", "COUNT_PRIMES"}
    ACTIVE_STATES = {"SCHEDULED", "RUNNING"}

    def __init__(self, max_attempts=3, assignment_timeout=300, max_tasks=1000, now=time.time):
        if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or max_attempts < 1:
            raise ValueError("max_attempts must be a positive integer")
        if isinstance(assignment_timeout, bool) or not isinstance(assignment_timeout, (int, float)) or not 0 < assignment_timeout <= 86400 or not math.isfinite(assignment_timeout):
            raise ValueError("assignment_timeout must be finite and positive")
        if isinstance(max_tasks, bool) or not isinstance(max_tasks, int) or max_tasks < 1:
            raise ValueError("max_tasks must be a positive integer")
        self.tasks = {}
        self.lock = threading.RLock()
        self.max_attempts = max_attempts
        self.assignment_timeout = assignment_timeout
        self.max_tasks = max_tasks
        self.now = now

    @staticmethod
    def _validate_requirement(value, field_name):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{field_name} must be a finite positive number")
        upper = 1024 if field_name == "cpu_cores" else MAX_MEMORY_MB
        valid = 0 < value <= upper and math.isfinite(value)
        if not valid:
            raise ValueError(f"{field_name} must be a finite positive number no greater than {upper}")
        return float(value)

    def create_task(self, task_type, payload, cpu_cores=1.0, memory_mb=128.0):
        payload = validate_workload(task_type, payload)
        cpu = self._validate_requirement(cpu_cores, "cpu_cores")
        memory = self._validate_requirement(memory_mb, "memory_mb")
        with self.lock:
            if len(self.tasks) >= self.max_tasks:
                raise ValueError("Task history is full; save results and restart the coordinator")
            timestamp = self.now()
            task_id = str(uuid.uuid4())
            task = {"task_id": task_id, "task_type": task_type, "payload": payload,
                    "requirements": {"cpu_cores": cpu, "memory_mb": memory},
                    "status": "PENDING", "assigned_device": None, "assigned_session": None,
                    "assignment_token": None, "assignment_expires_at": None,
                    "attempts": 0, "recoveries": 0, "result": None, "error": None,
                    "created_at": timestamp, "updated_at": timestamp}
            self.tasks[task_id] = task
            return copy.deepcopy(task)

    def _get(self, task_id):
        if not isinstance(task_id, str) or task_id not in self.tasks:
            raise ValueError("Unknown task ID")
        return self.tasks[task_id]

    def assign_task(self, task_id, device_id, session_id):
        if any(not isinstance(value, str) or not value.strip() for value in (device_id, session_id)):
            raise ValueError("Assignment requires a device and session")
        with self.lock:
            task = self._get(task_id)
            if task["status"] != "PENDING":
                raise ValueError("Only pending tasks can be assigned")
            if task["attempts"] >= self.max_attempts:
                raise ValueError("Task retry limit reached")
            if any(item["status"] in self.ACTIVE_STATES and item["assigned_device"] == device_id
                   and item["assigned_session"] == session_id for item in self.tasks.values()):
                raise ValueError("Worker session already has an active assignment")
            task.update(status="SCHEDULED", assigned_device=device_id, assigned_session=session_id,
                        assignment_token=str(uuid.uuid4()), assignment_expires_at=self.now() + self.assignment_timeout,
                        attempts=task["attempts"] + 1, updated_at=self.now())
            return copy.deepcopy(task)

    def _assignment(self, task_id, device_id, session_id, token):
        task = self._get(task_id)
        if (task["status"] not in self.ACTIVE_STATES or task["assigned_device"] != device_id
                or task["assigned_session"] != session_id or not isinstance(token, str)
                or task["assignment_token"] != token or self.now() >= task["assignment_expires_at"]):
            raise ValueError("Stale assignment or incorrect worker ownership")
        return task

    def handle_worker_message(self, task_id, device_id, session_id, token, message_type, payload):
        """Validate ownership and lifecycle atomically before accepting a worker outcome."""
        with self.lock:
            task = self._assignment(task_id, device_id, session_id, token)
            if message_type == "JOB_ACCEPTED":
                if task["status"] != "SCHEDULED":
                    raise ValueError("Task is not awaiting acknowledgement")
                task["status"] = "RUNNING"
            elif message_type == "JOB_RESULT":
                if task["status"] != "RUNNING":
                    raise ValueError("Only a running assignment can return a result")
                result = payload.get("result")
                if isinstance(result, bool) or not isinstance(result, int):
                    raise ValueError("Task result must be an integer")
                start, end = task["payload"]["start"], task["payload"]["end"]
                if task["task_type"] == "SUM_RANGE":
                    expected = (start + end) * (end - start + 1) // 2
                    if result != expected:
                        raise ValueError("Invalid range sum result")
                elif not 0 <= result <= end - start + 1:
                    raise ValueError("Invalid prime count result")
                task.update(status="COMPLETED", result=result)
            elif message_type == "JOB_FAILED":
                error = payload.get("error", "Worker execution failed")
                if not isinstance(error, str) or not error or len(error) > 1000:
                    raise ValueError("Invalid worker error")
                task.update(status="FAILED", error=error)
            elif message_type == "JOB_CANCELLED":
                task["status"] = "CANCELLED"
            else:
                raise ValueError("Unsupported worker task message")
            if task["status"] not in self.ACTIVE_STATES:
                task["assignment_token"] = None
                task["assignment_expires_at"] = None
            task["updated_at"] = self.now()
            return copy.deepcopy(task)

    def recover_task(self, task_id, reason):
        """Revoke an abandoned attempt. Called under the service orchestration lock."""
        with self.lock:
            task = self._get(task_id)
            if task["status"] not in self.ACTIVE_STATES:
                return None
            task.update(assignment_token=None, assignment_expires_at=None, assigned_device=None,
                        assigned_session=None, result=None, recoveries=task["recoveries"] + 1,
                        last_recovery=reason, updated_at=self.now())
            if task["attempts"] >= self.max_attempts:
                task.update(status="FAILED", error="Retry limit reached: " + reason)
            else:
                task.update(status="PENDING", error=None)
            return copy.deepcopy(task)

    def get_task(self, task_id):
        with self.lock:
            return copy.deepcopy(self.tasks.get(task_id))

    def list_tasks(self):
        with self.lock:
            return copy.deepcopy(list(self.tasks.values()))
