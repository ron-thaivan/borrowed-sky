"""Shared arithmetic workload limits for coordinator and installed workers."""
from math import isqrt

SUPPORTED_TASK_TYPES = {"SUM_RANGE", "COUNT_PRIMES"}
MAX_PRIME_MAGNITUDE = 1_000_000_000
MAX_PRIME_RANGE = 500_000
MAX_PRIME_WORK = 500_000_000
MAX_SUM_MAGNITUDE = 1_000_000_000_000
MAX_SUM_RANGE = 10_000_000


def validate_workload(task_type, payload):
    if not isinstance(task_type, str) or task_type not in SUPPORTED_TASK_TYPES:
        raise ValueError("Unsupported task type")
    if not isinstance(payload, dict) or set(payload) != {"start", "end"}:
        raise ValueError("Task payload must contain exactly start and end")
    start, end = payload["start"], payload["end"]
    if any(isinstance(value, bool) or not isinstance(value, int) for value in (start, end)):
        raise ValueError("Task start and end must be integers")
    if start > end:
        raise ValueError("Task start cannot be greater than task end")
    size = end - start + 1
    if task_type == "COUNT_PRIMES":
        if max(abs(start), abs(end)) > MAX_PRIME_MAGNITUDE:
            raise ValueError("COUNT_PRIMES endpoints must be within +/- 1000000000")
        if size > MAX_PRIME_RANGE:
            raise ValueError("COUNT_PRIMES range cannot exceed 500000 integers")
        # Conservative trial-division bound, not a prediction of wall time.
        if size * isqrt(max(0, end)) > MAX_PRIME_WORK:
            raise ValueError("COUNT_PRIMES workload exceeds the computation budget; use a smaller range")
    else:
        if max(abs(start), abs(end)) > MAX_SUM_MAGNITUDE or size > MAX_SUM_RANGE:
            raise ValueError("SUM_RANGE requires endpoints within +/- 1000000000000 and at most 10000000 integers")
    return {"start": start, "end": end}
