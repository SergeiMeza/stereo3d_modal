"""``Cls.with_options`` that leaves the class it came from alone.

Modal 1.2.x shares one options object between a Cls and every variant
``with_options`` makes from it, and merges the new options into that
shared object. So ``VideoDepthWorker.with_options(gpu="B200")`` also
turns plain ``VideoDepthWorker`` into a B200 class for the rest of the
process. With one job per coordinator container that never showed; since
the coordinator takes several jobs at once (2026-10-03), one 4K depth job
sent every later 1080p job in that container to the B200 queue, where
they waited for hours (2026-10-27, 9 jobs from 5 customers stuck at
"Profiling scenes").

``with_options`` here gives each variant its own copy, cached per
(class, options), and the GPU-routing call sites use a variant for every
tier, the default one included, so no job binds a class another thread
is changing.
"""

import copy
import threading

from modal._utils.async_utils import synchronizer

_lock = threading.Lock()
_variants: dict[tuple, object] = {}


def _key(value):
    if isinstance(value, (list, tuple)):
        return tuple(_key(v) for v in value)
    return value


def with_options(cls, **options):
    """``cls.with_options(**options)`` with options private to the result."""
    key = (id(cls), tuple(sorted((k, _key(v)) for k, v in options.items())))
    with _lock:
        variant = _variants.get(key)
        if variant is None:
            raw = synchronizer._translate_in(cls)
            shared = raw._options
            # with_options copies raw._options by reference into the new
            # Cls and merges into it: hand it a private copy instead.
            raw._options = copy.copy(shared)
            try:
                variant = cls.with_options(**options)
            finally:
                raw._options = shared
            _variants[key] = variant
    return variant
