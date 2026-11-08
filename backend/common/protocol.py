
# convert protocol messages between python dictionaries and JSON bytes
import json

# use to encode/decode four byte header
import struct
import socket
import time
import math

# every msg and connection session gets a key
import uuid

# protocol version to identify incompatible messages in the future
PROTOCOL_VERSION = 1

# maximum message size, prevent huge messages
MAX_MESSAGE_SIZE = 8 * 1024 * 1024

# all protocol message types
MESSAGE_TYPES = {
    "REGISTER",
    "REGISTER_ACK",
    "RESOURCE_REPORT",
    "RESOURCE_UPDATE",
    "HEARTBEAT",
    "JOB_SUBMIT",
    "JOB_ACCEPTED",
    "JOB_RESULT",
    "JOB_FAILED",
    "JOB_CANCEL",
    "JOB_CANCELLED",
    "DISCONNECT",
    "ERROR",
}


# exception to differentiate protool errors vs other errors
class ProtocolError(Exception):
    pass


# this function will create a consistent protocol message, payload is optional as different messages
# may or may not require additional payload data
def create_message(message_type, device_id, session_id, payload=None):

    # throw error if the message type is invalid
    if not isinstance(message_type, str) or message_type not in MESSAGE_TYPES:
        raise ProtocolError(f"Unsupported message type: {message_type}")


    # returns the consistent protocol structure shared by any given message
    return {
        "protocol_version": PROTOCOL_VERSION,
        "message_type": message_type,
        "message_id": str(uuid.uuid4()),
        "device_id": device_id,
        "session_id": session_id,
        "timestamp": time.time(),
        "payload": payload if payload is not None else {},
    }



# final message validation
def validate_message(message):

    # ensures that the message is a JSOn object instead of a string, list, or something else
    if not isinstance(message, dict):
        raise ProtocolError("Message must be a JSON object")

    # ensure all the fields ar there
    required_fields = {
        "protocol_version",
        "message_type",
        "message_id",
        "device_id",
        "session_id",
        "timestamp",
        "payload",
    }

    # figure out what fields are missing from the message 
    missing_fields = required_fields - message.keys()

    # raise the error with the missing fields included
    if missing_fields:
        raise ProtocolError(f"Missing fields: {sorted(missing_fields)}")

    # ensure the correct protocol version
    if type(message["protocol_version"]) is not int or message["protocol_version"] != PROTOCOL_VERSION:
        raise ProtocolError("Unsupported protocol version")

    # reject unknown
    if not isinstance(message["message_type"], str) or message["message_type"] not in MESSAGE_TYPES:
        raise ProtocolError("Unknown message type")

    # check over the key value types
    for field in ("message_id", "device_id", "session_id"):
        if not isinstance(message[field], str) or not message[field].strip() or len(message[field]) > 128 or any(ord(c) < 32 or ord(c) == 127 for c in message[field]):
            raise ProtocolError(f"Invalid {field}")

    
    timestamp = message["timestamp"]
    if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)) or not 0 <= timestamp <= 1e12 or not math.isfinite(timestamp):
        raise ProtocolError("Invalid timestamp")

    # make sure that the message is an object
    if not isinstance(message["payload"], dict):
        raise ProtocolError("Payload must be a JSON object")

    def check_json(value, depth=0):
        if depth > 32:
            raise ProtocolError("Message nesting is too deep")
        if isinstance(value, dict):
            for key, child in value.items():
                if not isinstance(key, str):
                    raise ProtocolError("JSON keys must be strings")
                check_json(child, depth + 1)
        elif isinstance(value, (list, tuple)):
            for child in value:
                check_json(child, depth + 1)
        elif isinstance(value, float) and not math.isfinite(value):
            raise ProtocolError("Non-finite JSON values are not supported")
        elif value is not None and not isinstance(value, (str, int, float, bool)):
            raise ProtocolError("Unsupported JSON value")

    check_json(message)

    # return validated message
    return message


# AI BUILT: 
# Convert a protocol message into a framed byte sequence ready for TCP transmission.
def encode_message(message):
    # Validate the outgoing message before attempting to serialize it.
    validate_message(message)

    # Serialize the dictionary as compact JSON and encode it as UTF-8 bytes.
    try:
        payload = json.dumps(message, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise ProtocolError("Message cannot be encoded as JSON") from error

    # Reject an outgoing payload that exceeds our protocol's maximum message size.
    if len(payload) > MAX_MESSAGE_SIZE:
        raise ProtocolError("Outgoing message exceeds maximum size")

    # Encode the payload length as a four-byte unsigned integer in network byte order.
    header = struct.pack("!I", len(payload))

    # Return the length header followed by the serialized JSON payload.
    return header + payload


# Read exactly the requested number of bytes from a TCP socket.
def receive_exact(sock, byte_count):
    # Create a buffer that will hold the bytes received from the TCP stream.
    received = bytearray()

    # Continue receiving until the requested number of bytes has arrived.
    while len(received) < byte_count:
        # Request only the number of bytes that are still missing.
        chunk = sock.recv(byte_count - len(received))

        # Treat an empty receive as a closed connection rather than a valid message.
        if not chunk:
            raise ConnectionError("Peer closed the connection")

        # Append the newly received bytes to our buffer.
        received.extend(chunk)

    # Return the complete byte sequence after all requested bytes have arrived.
    return bytes(received)


# Receive one complete framed protocol message from a TCP socket.
def receive_message(sock):
    # Read the four-byte header before attempting to read the JSON payload.
    header = receive_exact(sock, 4)

    # Decode the header as an unsigned integer using network byte order.
    payload_length = struct.unpack("!I", header)[0]

    # Reject empty payloads and payloads that exceed our configured size limit.
    if payload_length == 0 or payload_length > MAX_MESSAGE_SIZE:
        raise ProtocolError("Invalid message length")

    # Read exactly the number of payload bytes specified by the header.
    payload = receive_exact(sock, payload_length)

    # Decode the UTF-8 payload and parse its JSON representation.
    try:
        def invalid_constant(value):
            raise ValueError(f"Invalid JSON constant: {value}")
        message = json.loads(payload.decode("utf-8"), parse_constant=invalid_constant)
    # Convert invalid UTF-8 or malformed JSON into a protocol-specific error.
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise ProtocolError("Malformed JSON payload") from error

    # Validate the parsed message before returning it to application code.
    return validate_message(message)


# Send one complete protocol message over an established TCP connection.
def send_message(sock, message):
    # Encode the message into a length-prefixed byte sequence.
    framed_message = encode_message(message)

    # Send all bytes, allowing Python to handle partial underlying socket writes.
    sock.sendall(framed_message)


# handles protocol conversion, validation, sending, receiving, for all devices (workers or main) 
# doesn't know anything about hardware
# handling formatting
