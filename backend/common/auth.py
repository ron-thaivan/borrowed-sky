"""Shared-cluster authentication for the optional Python demo backend."""
import hmac
import os

TOKEN_ENV = "BORROWED_SKY_CLUSTER_TOKEN"


def load_token(token=None):
    token = os.environ.get(TOKEN_ENV) if token is None else token
    if (not isinstance(token, str) or not 32 <= len(token) <= 256
            or not token.isascii() or any(c.isspace() or ord(c) < 33 or ord(c) > 126 for c in token)):
        raise ValueError(f"Set {TOKEN_ENV} to a random 32–256 character ASCII token on HQ and workers.")
    return token


def matches_token(expected, supplied):
    return (isinstance(supplied, str) and supplied.isascii()
            and len(supplied) <= 256 and hmac.compare_digest(expected, supplied))
