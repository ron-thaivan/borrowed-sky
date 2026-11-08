"""Serialize scheduling, ownership-checked outcomes and bounded recovery."""
import threading


class TaskService:
    def __init__(self, task_manager, scheduler, resource_manager, connection_manager):
        self.task_manager = task_manager
        self.scheduler = scheduler
        self.resource_manager = resource_manager
        self.connection_manager = connection_manager
        self.scheduler.connection_manager = connection_manager
        self.lock = threading.RLock()

    def _retire_session(self, device_id, session_id):
        # Closing the socket wakes its reader; duplicate handler cleanup is harmless.
        self.connection_manager.disconnect_session(device_id, session_id)
        self.resource_manager.registry.disconnect_session(device_id, session_id)

    def _recover_session(self, device_id, session_id, reason):
        affected = []
        for task in self.task_manager.list_tasks():
            if (task["assigned_device"] == device_id and (session_id is None or task["assigned_session"] == session_id)
                    and task["status"] in self.task_manager.ACTIVE_STATES):
                self.task_manager.recover_task(task["task_id"], reason)
                self.resource_manager.release(task["task_id"])
                affected.append(task["task_id"])
        return affected

    def _expire_locked(self):
        expired = []
        for task in self.task_manager.list_tasks():
            if (task["status"] in self.task_manager.ACTIVE_STATES
                    and self.task_manager.now() >= task["assignment_expires_at"]):
                device, session = task["assigned_device"], task["assigned_session"]
                self._retire_session(device, session)
                expired.extend(self._recover_session(device, session, "Assignment timed out"))
        return expired

    def _dispatch_assignment(self, assignment):
        task = assignment["task"]
        device, session = task["assigned_device"], task["assigned_session"]
        payload = {"task_id": task["task_id"], "assignment_token": task["assignment_token"],
                   "task_type": task["task_type"], "task_payload": task["payload"],
                   "requirements": task["requirements"]}
        try:
            sent = self.connection_manager.send_to_session(device, session, "JOB_SUBMIT", payload)
        except (OSError, ConnectionError, TimeoutError):
            sent = False
        if not sent:
            self._retire_session(device, session)
            self._recover_session(device, session, "Worker disconnected during dispatch")
        return sent

    def schedule_available(self):
        with self.lock:
            self._expire_locked()
            dispatched = []
            # Failures retire sessions, so this terminates even with several broken sockets.
            while True:
                assignments = self.scheduler.schedule_pending()
                if not assignments:
                    break
                failed = False
                for assignment in assignments:
                    if not self._dispatch_assignment(assignment):
                        failed = True
                    dispatched.append(self.task_manager.get_task(assignment["task"]["task_id"]))
                if not failed:
                    break
            return dispatched

    def submit_task(self, task_type, payload, cpu_cores=1.0, memory_mb=128.0):
        with self.lock:
            task = self.task_manager.create_task(task_type, payload, cpu_cores, memory_mb)
            self.schedule_available()
            return self.task_manager.get_task(task["task_id"])

    def handle_worker_message(self, device_id, session_id, message_type, payload):
        if not isinstance(payload, dict):
            raise ValueError("Worker task payload must be an object")
        with self.lock:
            if self._expire_locked():
                # Even a stale outcome can be the first observation of expiry.
                # Reassign recovered work before rejecting that old outcome.
                self.schedule_available()
            task = self.task_manager.handle_worker_message(payload.get("task_id"), device_id, session_id,
                                                          payload.get("assignment_token"), message_type, payload)
            if task["status"] not in self.task_manager.ACTIVE_STATES:
                self.resource_manager.release(task["task_id"])
                self.schedule_available()
            return task

    def handle_worker_disconnect(self, device_id, session_id=None):
        with self.lock:
            if session_id is not None:
                self._retire_session(device_id, session_id)
            else:
                for session in self.connection_manager.get_sessions(device_id):
                    self._retire_session(device_id, session)
            affected = self._recover_session(device_id, session_id, "Worker disconnected before completion")
            self.schedule_available()
            return affected

    def expire_assignments(self):
        with self.lock:
            affected = self._expire_locked()
            if affected:
                self.schedule_available()
            return affected
