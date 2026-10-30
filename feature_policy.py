"""Immutable startup selection for official modules. No services/models or writes."""
import hashlib
import json
import os
from pathlib import Path

IDS = ('analysis', 'history', 'practice', 'recommendation')


def load_selection(path: Path, raw=None):
    error = ''
    try:
        value = json.loads(raw if raw is not None else path.read_text(encoding='utf-8-sig'))
        revision = value.get('revision')
        if (value.get('schema') != 1 or type(revision) is not int or not 0 <= revision <= 9007199254740991
                or set(value.get('enabled', {})) != set(IDS)
                or any(type(value['enabled'][key]) is not bool for key in IDS)):
            raise ValueError('Invalid feature selection')
        value = dict(schema=1, revision=revision, enabled={key: value['enabled'][key] for key in IDS})
    except FileNotFoundError:
        value = dict(schema=1, revision=0, enabled=dict.fromkeys(IDS, True))
    except (OSError, ValueError, TypeError, AttributeError):
        error = '功能选择文件无法读取，已保留原文件并暂停可选功能。'
        value = dict(schema=1, revision=0, enabled=dict.fromkeys(IDS, False))
    encoded = json.dumps([value['revision'], *[value['enabled'][key] for key in IDS]], separators=(',', ':'))
    return {**value, 'signature': hashlib.sha256(encoded.encode()).hexdigest(), 'error': error}


def startup_selection(path):
    # A backend restarted by this running desktop must keep that session's
    # selection, even after the user saved a different next-start selection.
    return load_selection(path, os.environ.get('FLOWAVE_FEATURES_SNAPSHOT'))


def route_module(path):
    if any(path == p or path.startswith(p + '/') for p in
           ('/recommend', '/recommendation-rate', '/sound-map', '/seeds', '/index', '/online/index', '/listening-traces')):
        return 'recommendation'
    if any(path == p or path.startswith(p + '/') for p in ('/practice', '/stems')):
        return 'practice'
    if path == '/analysis' or path.startswith('/analysis/'):
        return 'analysis'
    return None
