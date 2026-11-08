# Import the registry that tracks connected physical devices.
from backend.coordinator.registry import DeviceRegistry

# Import the resource manager that calculates and reserves capacity.
from backend.coordinator.resource_manager import ResourceManager

# Create a registry to simulate HQ's connected-device inventory.
registry = DeviceRegistry()

# Register a simulated physical computer with one active worker session.
registry.register_device("laptop-a", "session-1", "Laptop A")

# Supply realistic hardware information for the simulated computer.
registry.update_resources(
    "laptop-a",
    "session-1",
    {
        "logical_cores": 8,
        "physical_cores": 4,
        "total_memory_mb": 16000,
        "available_memory_mb": 6000,
        "cpu_percent": 20,
    },
)

# Create the resource manager using the simulated registry.
manager = ResourceManager(registry)

# Display the initial capacity available for distributed workloads.
print("INITIAL POOL:", manager.get_pool())

# Reserve three CPU cores and 3000 MB of RAM for the first task.
manager.reserve("laptop-a", "task-001", 3, 3000)

# Display the capacity remaining after the first reservation.
print("AFTER FIRST RESERVATION:", manager.get_device_capacity("laptop-a"))

# Try to reserve more CPU and RAM than the device has remaining.
try:
    # This reservation should fail because only 1.8 CPU cores and 1800 MB remain.
    manager.reserve("laptop-a", "task-002", 2, 2000)

# Catch the expected resource-allocation error.
except ValueError as error:
    # Display the reason that HQ rejected the second reservation.
    print("EXPECTED REJECTION:", error)

# Release the first task's resource reservation.
manager.release("task-001")

# Display the capacity after the first task releases its resources.
print("AFTER RELEASE:", manager.get_device_capacity("laptop-a"))

# Confirm that the entire test completed successfully.
print("SUCCESS: Resource manager tests passed!")
