"""Best-fit device scheduling, limited to one active job per worker session."""
import threading


class Scheduler:
    def __init__(self, task_manager, resource_manager, connection_manager=None):
        self.task_manager = task_manager
        self.resource_manager = resource_manager
        self.connection_manager = connection_manager
        self.lock = threading.RLock()

    @staticmethod
    def _calculate_fit_score(capacity, cpu_required, memory_required):
        cpu = capacity["available_cpu_cores"]
        memory = capacity["available_memory_mb"]
        return (cpu - cpu_required) / max(cpu, .000001) + (memory - memory_required) / max(memory, .000001)

    def _select_device(self, task):
        cpu = task["requirements"]["cpu_cores"]
        memory = task["requirements"]["memory_mb"]
        candidates = []
        for device in self.resource_manager.get_pool():
            capacity = device["capacity"]
            if not capacity or capacity["available_cpu_cores"] < cpu or capacity["available_memory_mb"] < memory:
                continue
            candidates.append((self._calculate_fit_score(capacity, cpu, memory), device))
        return sorted(candidates, key=lambda candidate: (candidate[0], candidate[1]["device_id"]))

    def schedule_task(self, task_id):
        with self.lock:
            task = self.task_manager.get_task(task_id)
            if task is None:
                raise ValueError("Unknown task ID")
            if task["status"] != "PENDING" or self.connection_manager is None:
                return None
            occupied = {(t["assigned_device"], t["assigned_session"]) for t in self.task_manager.list_tasks()
                        if t["status"] in self.task_manager.ACTIVE_STATES}
            for score, device in self._select_device(task):
                device_id = device["device_id"]
                sessions = [s for s in self.connection_manager.get_sessions(device_id) if (device_id, s) not in occupied]
                if not sessions:
                    continue
                session_id = sessions[0]
                try:
                    self.resource_manager.reserve(device_id, task_id, task["requirements"]["cpu_cores"], task["requirements"]["memory_mb"])
                except ValueError:
                    continue
                try:
                    assigned = self.task_manager.assign_task(task_id, device_id, session_id)
                except Exception:
                    self.resource_manager.release(task_id)
                    raise
                return {"task": assigned, "device_id": device_id, "session_id": session_id, "fit_score": score}
            return None

    def schedule_pending(self):
        with self.lock:
            assignments = []
            for task in self.task_manager.list_tasks():
                if task["status"] == "PENDING":
                    assignment = self.schedule_task(task["task_id"])
                    if assignment:
                        assignments.append(assignment)
            return assignments
