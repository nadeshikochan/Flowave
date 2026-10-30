"""Persistent stem generations and mix settings. Resident code never imports models."""
from contextlib import contextmanager
from pathlib import Path
import hashlib
import json
import re
import sqlite3
import time

NAMES = {'vocals': '人声', 'drums': '鼓', 'bass': '贝斯', 'guitar': '吉他', 'piano': '钢琴', 'other': '其他伴奏'}


def safe_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value):
        raise ValueError('歌曲标识无效。')
    return value


def fingerprint(path):
    """Content digest is computed only by the explicit worker, never on catalog reads."""
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


class StemStore:
    def __init__(self, root):
        self.root = Path(root)
        self.usage_cache = None

    @contextmanager
    def connect(self):
        self.root.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.root / 'stems.sqlite3', timeout=10)
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS stems (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS mixes (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS task (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)')
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def get(self, rid):
        safe_id(rid)
        with self.connect() as db:
            row = db.execute('SELECT payload FROM stems WHERE id=?', (rid,)).fetchone()
        return json.loads(row[0]) if row else None

    def publish(self, rid, payload):
        safe_id(rid)
        with self.connect() as db:
            backup_path = self.root / 'stems.previous.partial.sqlite3'
            backup = sqlite3.connect(backup_path)
            try:
                db.backup(backup)
            finally:
                backup.close()
            backup_path.replace(self.root / 'stems.previous.sqlite3')
            db.execute('INSERT OR REPLACE INTO stems VALUES (?,?)', (rid, json.dumps(payload, ensure_ascii=False)))
        self.usage_cache = None

    def all(self):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT payload FROM stems')]

    def track_usage(self, rid):
        folder = self.root / safe_id(rid)
        total = 0
        for path in folder.glob('*/*'):
            try:
                if path.is_file():
                    total += path.stat().st_size
            except FileNotFoundError:
                pass
        return total

    def task(self, value=None):
        with self.connect() as db:
            if value is not None:
                db.execute('INSERT OR REPLACE INTO task VALUES (1,?)', (json.dumps(value, ensure_ascii=False),))
            row = db.execute('SELECT payload FROM task WHERE id=1').fetchone()
        return json.loads(row[0]) if row else {'state': 'idle'}

    def mix(self, rid, value=None):
        safe_id(rid)
        with self.connect() as db:
            if value is not None:
                clean = {}
                for name in NAMES:
                    item = value.get(name, {})
                    volume = float(item.get('volume', 100))
                    if not 0 <= volume <= 100:
                        raise ValueError('音轨音量应为0到100。')
                    clean[name] = {'volume': volume, 'muted': item.get('muted') is True}
                db.execute('INSERT OR REPLACE INTO mixes VALUES (?,?)', (rid, json.dumps(clean)))
            row = db.execute('SELECT payload FROM mixes WHERE id=?', (rid,)).fetchone()
        return json.loads(row[0]) if row else {}

    def file(self, payload, name):
        if name not in NAMES or name not in payload.get('stems', {}):
            raise ValueError('音轨不存在。')
        generation = safe_id(payload['generation'])
        path = self.root / safe_id(payload['id']) / generation / (name + '.opus')
        if not path.is_file() or path.stat().st_size != payload['stems'][name]['bytes']:
            raise ValueError('分轨文件缺失或已变化，请重新分离。')
        return path

    def usage(self):
        if self.usage_cache and time.monotonic() - self.usage_cache[0] < 5:
            return dict(self.usage_cache[1])
        with self.connect() as db:
            rows = [json.loads(r[0]) for r in db.execute('SELECT payload FROM stems')]
        # Include retained generations, not just the current database pointers.
        size = sum(self.track_usage(path.name) for path in self.root.iterdir() if path.is_dir())
        value = {'tracks': len(rows), 'bytes': size}
        self.usage_cache = (time.monotonic(), value)
        return dict(value)

    def forget(self, rid):
        safe_id(rid)
        with self.connect() as db:
            db.execute('DELETE FROM stems WHERE id=?', (rid,))
            db.execute('DELETE FROM mixes WHERE id=?', (rid,))
        self.usage_cache = None
