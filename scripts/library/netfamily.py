"""
Pin every connection of a fetcher to the IP family that actually works.

This network keeps advertising both IPv4 and IPv6 while only one of them
reaches the internet - and which one has flipped before. Left alone, each
request stalls on the dead family until it times out before trying the other.
"""
import socket

_getaddrinfo = socket.getaddrinfo


def _reaches(family, host):
    try:
        addr = _getaddrinfo(host, 443, family, socket.SOCK_STREAM)[0][4]
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.settimeout(4)
            s.connect(addr)
        return True
    except OSError:
        return False


def pin(host="www.youtube.com"):
    """Probe once, then resolve only that family. Returns 4 or 6 (yt-dlp's -4 / -6)."""
    family = socket.AF_INET if _reaches(socket.AF_INET, host) or not _reaches(socket.AF_INET6, host) else socket.AF_INET6
    socket.getaddrinfo = lambda h, port, _family=0, *a, **k: _getaddrinfo(h, port, family, *a, **k)
    return 4 if family == socket.AF_INET else 6
