"""Lazy optional coordinators; probing idle state and shutdown never activates one."""
from threading import RLock


class DeferredService:
    def __init__(self, factory):
        self._factory = factory
        self._value = None
        self._lock = RLock()

    def _get(self):
        with self._lock:
            if self._value is None:
                self._value = self._factory()
            return self._value

    @property
    def initialized(self):
        with self._lock:
            return self._value is not None

    @property
    def running(self):
        with self._lock:
            return bool(self._value is not None and self._value.running)

    def pending_for(self, *args, **kwargs):
        with self._lock:
            return bool(self._value is not None and self._value.pending_for(*args, **kwargs))

    def close(self):
        with self._lock:
            value = self._value
        if value is not None:
            value.close()

    def __getattr__(self, name):
        return getattr(self._get(), name)
