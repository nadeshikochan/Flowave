"""Durable configuration with a last valid backup and preserved corrupt inputs."""
from pathlib import Path
import json
import os
import shutil
import uuid


def _read(path):
    value = json.loads(path.read_text(encoding='utf-8-sig'))
    if not isinstance(value, dict):
        raise ValueError('配置内容必须为对象。')
    return value


def _publish(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with staged.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        staged.replace(path)
    finally:
        staged.unlink(missing_ok=True)


def read_config(path):
    path = Path(path)
    if not path.exists():
        return None
    try:
        return _read(path)
    except (OSError, ValueError) as error:
        backup = path.with_name(path.name + '.previous')
        try:
            restored = _read(backup)
        except (OSError, ValueError):
            raise ValueError('配置损坏且没有可用备份，原文件已保留。请退出软件并恢复工作区备份，或打开其他工作区。') from error
        archive = path.with_name(path.name + '.corrupt-' + uuid.uuid4().hex)
        shutil.copy2(path, archive)
        _publish(path, restored)
        return restored


def write_config(path, value):
    path = Path(path)
    if not isinstance(value, dict):
        raise ValueError('配置内容必须为对象。')
    if path.exists():
        try:
            current = _read(path)
        except (OSError, ValueError) as error:
            raise ValueError('当前配置无法读取，已阻止覆盖。请先退出软件并恢复备份。') from error
        _publish(path.with_name(path.name + '.previous'), current)
    _publish(path, value)
