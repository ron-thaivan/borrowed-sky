
# Import threading so running tasks can receive cancellation signals.
import threading


# Define a distinct exception for tasks cancelled by HQ.
class TaskCancelled(Exception):
    # Initialize the cancellation exception with a readable message.
    pass


# Check whether a number is prime without using external libraries.
def is_prime(number):
    # Numbers smaller than two are not prime.
    if number < 2:
        return False

    # Two is the only even prime number.
    if number == 2:
        return True

    # Other even numbers cannot be prime.
    if number % 2 == 0:
        return False

    # Test odd divisors up to the square root of the number.
    divisor = 3

    # Continue while the divisor could still divide the number.
    while divisor * divisor <= number:
        # Return False when a divisor divides the number evenly.
        if number % divisor == 0:
            return False

        # Advance to the next odd divisor.
        divisor += 2

    # No divisors were found, so the number is prime.
    return True


# Execute a supported task using its supplied payload and cancellation event.
def execute_task(task_type, payload, cancel_event):
    # Read the beginning of the requested integer range.
    start = payload["start"]

    # Read the end of the requested integer range.
    end = payload["end"]

    # Execute the SUM_RANGE workload.
    if task_type == "SUM_RANGE":
        # Use the arithmetic-series formula to calculate the inclusive sum.
        return (end * (end + 1) // 2) - ((start - 1) * start // 2)

    # Execute the COUNT_PRIMES workload.
    if task_type == "COUNT_PRIMES":
        # Initialize the number of primes discovered.
        prime_count = 0

        # Examine every integer in the requested inclusive range.
        for number in range(start, end + 1):
            # Check for cancellation periodically rather than on every iteration.
            if number % 1024 == 0 and cancel_event.is_set():
                # Stop execution when HQ has requested cancellation.
                raise TaskCancelled("Task was cancelled by HQ.")

            # Increment the count when the current integer is prime.
            if is_prime(number):
                prime_count += 1

        # Return the final number of primes discovered.
        return prime_count

    # Reject task types that are not explicitly supported.
    raise ValueError(f"Unsupported task type: {task_type}")
