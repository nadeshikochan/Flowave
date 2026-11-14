"""Lightweight, host-pinned paths for optional downloaded resources.

No model imports, downloads or directory creation while importing this module.
The managed tree is relocatable; no absolute paths are persisted.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from runtime_paths import resolve_data_dir


def source_root(root):
    root = Path(root)
    packaged = root / 'backend/source'
    return packaged if packaged.is_dir() else root


def source_path(root, name):
    return source_root(root) / name


def catalog(root):
    file = Path(root) / 'resources/catalog.json'
    return json.loads(file.read_text(encoding='utf-8')) if file.is_file() else {'groups': {}, 'profiles': {}, 'modules': {}}


def revision(item):
    return hashlib.sha256(json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def managed_dir(root, kind, name, item):
    # Keep Windows DLL paths below MAX_PATH in ordinary portable locations.
    # The readiness marker still verifies the full SHA256, including collisions.
    return resolve_data_dir(root) / 'components/resources' / kind / name / revision(item)[:16]


def ready(directory, item):
    try:
        return json.loads((directory / '.ready.json').read_text(encoding='utf-8')).get('revision') == revision(item)
    except (OSError, ValueError, TypeError):
        return False


def ensure_runtime_path(directory):
    dll = Path(directory) / 'python/Lib/site-packages/torch/lib/cudnn_engines_runtime_compiled64_9.dll'
    if os.name == 'nt' and len(str(dll.resolve())) >= 260:
        raise ValueError('程序目录过深，Windows无法加载计算环境。请退出并将整个便携目录移到较短的位置后重试。')


def asset_path(root, relative):
    """Resolve only host-declared prefixes; retain original development layout."""
    relative = str(relative).replace('\\', '/').strip('/')
    if '..' in relative.split('/') or ':' in relative:
        raise ValueError('资源路径无效。')
    matches = []
    for name, item in catalog(root).get('groups', {}).items():
        for prefix in item.get('prefixes', []):
            if relative == prefix or relative.startswith(prefix + '/'):
                matches.append((len(prefix), name, item))
    if matches:
        _, name, item = max(matches, key=lambda row: row[0])
        directory = managed_dir(root, 'assets', name, item)
        if ready(directory, item):
            return directory / 'tree' / relative
    data = resolve_data_dir(root)
    if relative.startswith('data/'):
        return data / relative[5:]
    imported = data / 'components/resources/legacy' / relative
    if relative.startswith('models/') and imported.exists():
        return imported
    return Path(root) / relative


def runtime_python(root, profile, required=True):
    item = catalog(root).get('profiles', {}).get(profile)
    if item:
        directory = managed_dir(root, 'runtimes', profile, item)
        exe = directory / 'python/python.exe'
        if ready(directory, item) and exe.is_file():
            ensure_runtime_path(directory)
            return exe
    for legacy in (resolve_data_dir(root) / 'components/resources/legacy/python-index/Scripts/python.exe',
                   Path(root) / '.venv-index/Scripts/python.exe'):
        if legacy.is_file():
            return legacy
    if required:
        raise ValueError('必要的计算环境尚未准备好，请在插件与模型中完成安装。')
    return None


def worker_command(root, profile, name, *arguments):
    python = runtime_python(root, profile)
    source = source_root(root)
    # Embedded Python deliberately ignores host PYTHONPATH and installed Python.
    # This small audited launcher adds only our shipped source directory.
    return [str(python), '-I', '-X', 'utf8', '-c',
            'import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name="__main__")',
            str(source), str(source / name), *map(str, arguments)]


def recipe_asset_path(root, relative):
    """Read pinned recipe metadata independently of downloaded model weights."""
    actual = asset_path(root, relative)
    if actual.is_file():
        return actual
    for group in catalog(root).get('groups', {}).values():
        entry = group.get('metadata', {}).get(relative)
        if entry:
            file = Path(root) / entry['file']
            if file.is_file() and hashlib.sha256(file.read_bytes()).hexdigest() == entry['sha256']:
                return file
    return actual


def status(root):
    from resource_plan import module_plan
    data = catalog(root)
    return {name:module_plan(root, name, data) for name in data.get('modules', {})}


def worker_environment(root):
    root=Path(root).resolve()
    data = resolve_data_dir(root)
    cache = data / 'cache'
    temporary = cache / 'tmp'
    temporary.mkdir(parents=True, exist_ok=True)
    return {**os.environ, 'KUMIKO_APP_HOME': str(root), 'KUMIKO_DATA_DIR': str(data), 'PYTHONIOENCODING': 'utf-8',
            'PYTHONUNBUFFERED': '1', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
            'HF_HOME':str(cache/'huggingface'),'HF_HUB_CACHE':str(cache/'huggingface/hub'),
            'HF_MODULES_CACHE':str(cache/'huggingface/modules'),'TORCH_HOME':str(cache/'torch'),
            'TEMP':str(temporary),'TMP':str(temporary),'TMPDIR':str(temporary),
            'OMP_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2'}
