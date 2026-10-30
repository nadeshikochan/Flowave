"""Small stdout protocol shared by the heavy worker and its model pipeline."""
import json
import time

_state = {}


def report_progress(**fields):
    _state.update(fields)
    print("FLOWAVE_PROGRESS " + json.dumps({**_state, "updated_at": time.time()}, ensure_ascii=False), flush=True)
