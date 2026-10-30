"""Lightweight multi-folder library scope. No model imports or configuration writes."""
import os
from pathlib import Path


def path_key(path):
    return os.path.normcase(os.path.abspath(os.path.expanduser(str(path).strip())))


def contains(root, path):
    try:
        return os.path.commonpath([path_key(root), path_key(path)]) == path_key(root)
    except ValueError:
        return False


def normalize_roots(values):
    """Preserve order, collapse duplicates/contained roots; never probe an offline drive."""
    result = []
    for value in values or []:
        if not str(value or '').strip():
            continue
        candidate = os.path.abspath(os.path.expanduser(str(value).strip()))
        if any(contains(root, candidate) for root in result):
            continue
        covered = [i for i, root in enumerate(result) if contains(candidate, root)]
        position = min(covered) if covered else len(result)
        result = [root for root in result if not contains(candidate, root)]
        result.insert(position, candidate)
    return result


def configured_roots(config):
    values = config.get('audio_dirs')
    return normalize_roots(values if isinstance(values, list) else [config.get('audio_dir') or ''])


def roots_key(roots):
    return tuple(path_key(root) for root in normalize_roots(roots))


def scan_roots(roots, list_files):
    """An unavailable root aborts the whole candidate snapshot, preserving the published library."""
    roots = normalize_roots(roots)
    if not roots:
        raise ValueError('请至少保留一个音乐文件夹。')
    files, seen = [], set()
    for root in roots:
        target = Path(root)
        if not target.is_dir():
            raise FileNotFoundError(f'音乐文件夹暂时不可用：{root}')
        # Explicit scandir propagates permission errors that Path.rglob may suppress.
        with os.scandir(target):
            pass
        for item in list_files(target):
            item = Path(item)
            identity = os.path.normcase(os.path.realpath(item))
            if identity not in seen:
                seen.add(identity)
                files.append(item)
    return files
