import io
import json
import struct
import unittest
from concurrent.futures import ThreadPoolExecutor

from backend.common.protocol import (
    ProtocolError, MAX_MESSAGE_SIZE, create_message, encode_message, receive_message,
)
from backend.coordinator.registry import DeviceRegistry, MAX_DEVICES, MAX_SESSIONS_PER_DEVICE
from backend.coordinator.resource_manager import ResourceManager


def resources():
    return {"logical_cores": 8, "physical_cores": 4, "cpu_percent": 20,
            "total_memory_mb": 16000, "available_memory_mb": 6000,
            "os_name": "Windows", "os_version": "11", "architecture": "AMD64",
            "gpu": {"available": False}}


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.registry = DeviceRegistry()
        self.registry.register_device("device-a", "session-a", "Laptop A")

    def test_registry_copies_resources_and_tracks_independent_sessions(self):
        report = resources()
        self.registry.update_resources("device-a", "session-a", report)
        report["gpu"]["available"] = True
        snapshot = self.registry.snapshot()
        self.assertFalse(snapshot[0]["resources"]["gpu"]["available"])
        snapshot[0]["resources"]["logical_cores"] = 100
        self.assertEqual(self.registry.snapshot()[0]["resources"]["logical_cores"], 8)
        self.registry.register_device("device-a", "session-b", "Laptop A")
        self.assertEqual(self.registry.snapshot()[0]["active_sessions"], 2)
        self.registry.disconnect_session("device-a", "session-a")
        self.assertEqual(self.registry.snapshot()[0]["status"], "online")
        with self.assertRaises(ValueError):
            self.registry.update_resources("device-a", "session-a", resources())
        with self.assertRaises(ValueError):
            self.registry.record_heartbeat("device-a", "session-a")
        self.registry.disconnect_session("device-a", "session-b")
        self.assertEqual(self.registry.snapshot()[0]["status"], "offline")
        self.registry.register_device("device-a", "session-c", "Renamed laptop")
        self.assertEqual(self.registry.snapshot()[0]["resources"], {})
        self.assertEqual(ResourceManager(self.registry).get_device_capacity("device-a")["available_cpu_cores"], 0)

    def test_invalid_registration_and_duplicate_session_are_rejected(self):
        for args in [(3, "s", "name"), ("d", [], "name"), ("", "s", "name"),
                     ("d", "s", None), ("d", "s", "x" * 256), ("d", "s\n", "name")]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.registry.register_device(*args)
        for device in ["device-a", "other-device"]:
            with self.assertRaises(ValueError):
                self.registry.register_device(device, "session-a", "Duplicated")
        self.assertEqual(len(self.registry.snapshot()), 1)
        self.assertEqual(self.registry.snapshot()[0]["hostname"], "Laptop A")

    def test_registration_limits_are_bounded(self):
        for number in range(MAX_SESSIONS_PER_DEVICE - 1):
            self.registry.register_device("device-a", f"session-{number}", "Laptop A")
        with self.assertRaises(ValueError):
            self.registry.register_device("device-a", "too-many", "Laptop A")
        for number in range(MAX_DEVICES - 1):
            self.registry.register_device(f"device-{number}", f"other-session-{number}", "Laptop")
        with self.assertRaises(ValueError):
            self.registry.register_device("too-many", "unused-session", "Laptop")
        self.assertEqual(len(self.registry.snapshot()), MAX_DEVICES)

    def test_invalid_resource_reports_do_not_overwrite_valid_information(self):
        self.registry.update_resources("device-a", "session-a", resources())
        for patch in [{"logical_cores": float("nan")}, {"logical_cores": float("inf")},
                      {"logical_cores": True}, {"logical_cores": 2048}, {"logical_cores": "8"},
                      {"physical_cores": 9}, {"available_memory_mb": float("inf")},
                      {"total_memory_mb": -1}, {"available_memory_mb": 16001},
                      {"cpu_percent": -1}, {"cpu_percent": 101}, {"cpu_percent": float("nan")},
                      {"hostname": "private"}, {"gpu": {"available": "no"}},
                      {"architecture": "x" * 129}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.registry.update_resources("device-a", "session-a", {**resources(), **patch})
            self.assertEqual(self.registry.snapshot()[0]["resources"], resources())
        self.registry.update_resources("device-a", "session-a", {"physical_cores": None})
        capacity = ResourceManager(self.registry).get_device_capacity("device-a")
        self.assertEqual(capacity["available_cpu_cores"], 0)
        self.assertEqual(capacity["available_memory_mb"], 0)


class ResourceManagerTests(unittest.TestCase):
    def setUp(self):
        self.registry = DeviceRegistry()
        self.registry.register_device("device", "session", "Laptop")
        self.registry.update_resources("device", "session", resources())
        self.manager = ResourceManager(self.registry)

    def test_capacity_reservations_are_finite_and_released(self):
        capacity = self.manager.get_device_capacity("device")
        self.assertAlmostEqual(capacity["cpu_capacity"], 4.8)
        self.assertEqual(capacity["memory_capacity_mb"], 4800)
        self.manager.reserve("device", "task", 3, 3000)
        capacity = self.manager.get_device_capacity("device")
        self.assertAlmostEqual(capacity["available_cpu_cores"], 1.8)
        self.assertEqual(capacity["available_memory_mb"], 1800)
        with self.assertRaises(ValueError):
            self.manager.reserve("device", "other-task", 2, 2000)
        self.assertTrue(self.manager.release("task"))
        self.assertEqual(self.manager.reservations, {})
        self.assertFalse(self.manager.release("task"))

    def test_invalid_requirements_and_invalid_reports_cannot_allocate_capacity(self):
        for value in [float("inf"), float("nan"), -1, 0, True, "1", 10 ** 400]:
            for cpu, memory in [(value, 1), (1, value)]:
                with self.subTest(cpu=cpu, memory=memory), self.assertRaises(ValueError):
                    self.manager.reserve("device", "task", cpu, memory)
        self.assertEqual(self.manager.reservations, {})
        # Defense in depth for a legacy/custom registry that did not validate reports.
        for value in [float("nan"), float("inf"), True, -1, "8", 10 ** 400]:
            capacity = self.manager._calculate_capacity({"resources": {
                "logical_cores": value, "available_memory_mb": value, "cpu_percent": 0}})
            self.assertEqual(capacity, {"cpu_cores": 0, "memory_mb": 0})

    def test_concurrent_reservations_cannot_overcommit(self):
        def reserve(number):
            try:
                return self.manager.reserve("device", f"task-{number}", 1, 1000)
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=8) as pool:
            accepted = list(pool.map(reserve, range(20)))
        self.assertEqual(sum(accepted), 4)
        self.assertEqual(self.manager.get_device_capacity("device")["reserved_cpu_cores"], 4)


class ProtocolTests(unittest.TestCase):
    def read_bytes(self, data):
        class FragmentedSocket:
            def __init__(self):
                self.stream = io.BytesIO(data)

            def recv(self, count):
                return self.stream.read(min(count, 3))

        return receive_message(FragmentedSocket())

    def test_protocol_round_trip_and_bad_envelopes(self):
        message = create_message("HEARTBEAT", "device", "session", {"status": "alive"})
        self.assertEqual(self.read_bytes(encode_message(message)), message)
        for patch in [{"message_type": []}, {"message_type": "OTHER"}, {"protocol_version": True},
                      {"device_id": "x" * 129}, {"session_id": "\n"}, {"message_id": 7},
                      {"timestamp": float("nan")}, {"timestamp": float("inf")},
                      {"timestamp": 10 ** 400}, {"payload": []}, {"payload": {"number": float("inf")}}]:
            with self.subTest(patch=patch), self.assertRaises(ProtocolError):
                encode_message({**message, **patch})

    def test_wire_rejects_nonfinite_deep_truncated_and_oversized_json(self):
        message = create_message("HEARTBEAT", "device", "session")
        message["payload"] = {"value": float("nan")}
        encoded = json.dumps(message).encode()
        with self.assertRaises(ProtocolError):
            self.read_bytes(struct.pack("!I", len(encoded)) + encoded)
        nested = {}; message["payload"] = nested
        for _ in range(40):
            child = {}; nested["child"] = child; nested = child
        with self.assertRaises(ProtocolError):
            encode_message(message)
        with self.assertRaises(ProtocolError):
            self.read_bytes(struct.pack("!I", MAX_MESSAGE_SIZE + 1))
        with self.assertRaises(ConnectionError):
            self.read_bytes(struct.pack("!I", 10) + b"{}")


if __name__ == "__main__":
    unittest.main()
