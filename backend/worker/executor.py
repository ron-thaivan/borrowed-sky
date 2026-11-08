"""Execute only bounded arithmetic workloads; no arbitrary code loading."""
from backend.common.workload import validate_workload


class TaskCancelled(Exception):
    pass


def check_cancelled(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise TaskCancelled("Task was cancelled by HQ")


def is_prime(number, cancel_event=None):
    check_cancelled(cancel_event)
    if number < 2:
        return False
    if number == 2:
        return True
    if number % 2 == 0:
        return False
    divisor = 3
    while divisor * divisor <= number:
        # Check even inside a single expensive primality calculation.
        if divisor % 2048 == 3:
            check_cancelled(cancel_event)
        if number % divisor == 0:
            return False
        divisor += 2
    return True


def execute_task(task_type, payload, cancel_event):
    payload = validate_workload(task_type, payload)
    check_cancelled(cancel_event)
    start, end = payload["start"], payload["end"]
    if task_type == "SUM_RANGE":
        return (end * (end + 1) // 2) - ((start - 1) * start // 2)
    count = 0
    for number in range(start, end + 1):
        check_cancelled(cancel_event)
        if is_prime(number, cancel_event):
            count += 1
    return count
