# Start a short Python test program that imports the new registry.
# below line is for when you run this directly in the terminal it works as a wrapper
# python - <<'PY'
# Import the registry class we just created.
from backend.coordinator.registry import DeviceRegistry

# Create an empty registry to simulate HQ's inventory.
registry = DeviceRegistry()

# Simulate two worker processes connecting from the same physical laptop.
registry.register_device("laptop-a", "session-1", "Laptop A")
registry.register_device("laptop-a", "session-2", "Laptop A")

# Simulate the laptop reporting its available hardware resources.
registry.update_resources(
    "laptop-a",
    "session-1",
    {"cpu_cores": 8, "available_ram_gb": 6.2}
)

# Retrieve the current inventory from the registry.
devices = registry.snapshot()

# Confirm that two sessions still represent only one physical device.
assert len(devices) == 1

# Confirm that both worker connections are being tracked.
assert devices[0]["active_sessions"] == 2

# Confirm that the physical device is online.
assert devices[0]["status"] == "online"

# Disconnect the first worker process.
registry.disconnect_session("laptop-a", "session-1")

# Confirm that the second connection keeps the physical device online.
assert registry.snapshot()[0]["status"] == "online"

# Disconnect the final worker process.
registry.disconnect_session("laptop-a", "session-2")

# Confirm that the physical device is now offline.
assert registry.snapshot()[0]["status"] == "offline"

# Print a success message if every assertion passed.
print("SUCCESS: Device registry tests passed!")


# PY
# above line is end of the wrapper for direct terminal usage
