# Import the coordinator components needed for the test.
from backend.coordinator.registry import DeviceRegistry
from backend.coordinator.resource_manager import ResourceManager
from backend.coordinator.task_manager import TaskManager
from backend.coordinator.scheduler import Scheduler
from backend.coordinator.connection_manager import WorkerConnectionManager
from backend.coordinator.task_service import TaskService


# Test that the coordinator's task orchestration components initialize together.
def test_task_service_initializes():
    # Create the device registry.
    registry = DeviceRegistry()

    # Create the resource manager using the registry.
    resource_manager = ResourceManager(registry)

    # Create the task manager.
    task_manager = TaskManager()

    # Create the scheduler using the task and resource managers.
    scheduler = Scheduler(task_manager, resource_manager)

    # Create the worker connection manager.
    connection_manager = WorkerConnectionManager()

    # Create the task service using its required dependencies.
    task_service = TaskService(
        task_manager,
        scheduler,
        resource_manager,
        connection_manager,
    )

    # Verify that the task service was successfully created.
    assert task_service is not None


# Test that the device registry starts with no registered devices.
def test_registry_starts_empty():
    # Create a new device registry.
    registry = DeviceRegistry()

    # Verify that its snapshot is an empty list.
    assert registry.snapshot() == []