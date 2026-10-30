"""Lightweight, independently persisted practice information; never loads models."""
from pathlib import Path
import json
import math
import sqlite3
import time


def validate(payload):
    if payload.get('schema') != 1:
        raise ValueError('演奏分析版本无效。')
    duration = payload.get('duration', 0)
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 3600:
        raise ValueError('演奏分析时长无效。')
    for name, fields in [('beats', 4), ('chords', 3), ('keys', 3), ('notes', 4)]:
        values = payload.get(name, [])
        if not isinstance(values, list) or len(values) > 100000:
            raise ValueError('演奏事件数量无效。')
        previous = -1
        for row in values:
            if not isinstance(row, list) or len(row) != fields:
                raise ValueError('演奏事件格式无效。')
            start = row[0]
            if not isinstance(start, (int, float)) or not math.isfinite(start) or not 0 <= start <= duration or start < previous:
                raise ValueError('演奏事件时间无效。')
            previous = start
            if name != 'beats' and (not isinstance(row[1], (int, float)) or not math.isfinite(row[1]) or not start <= row[1] <= duration + .01):
                raise ValueError('演奏事件结束无效。')
            if name == 'notes' and (not isinstance(row[2], (int, float)) or not math.isfinite(row[2]) or not 0 <= row[2] <= 127):
                raise ValueError('旋律音高无效。')
            if name == 'beats' and (any(not isinstance(v, int) for v in row[1:]) or not 1 <= row[1] <= row[2] <= 32 or row[3] not in (1, 2, 4, 8, 16, 32)):
                raise ValueError('拍点格式无效。')
    json.dumps(payload, allow_nan=False)


class PracticeAnalysisStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory / 'results.sqlite3'

    def read(self, resource_id, source):
        if not self.path.exists():
            return {'status': 'missing'}
        try:
            con = sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True, timeout=5)
            try:
                row = con.execute('SELECT source,payload,updated FROM results WHERE id=?', (resource_id,)).fetchone()
            finally:
                con.close()
            if not row:
                return {'status': 'missing'}
            if source == 'unavailable' or row[0] != source:
                return {'status': 'outdated', 'message': '歌曲已变化，原演奏分析暂不用于当前音频。'}
            payload = json.loads(row[1]); validate(payload)
            return {'status': 'ready', 'id': resource_id, 'revision': row[2], 'analysis': payload}
        except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
            return {'status': 'unreadable', 'message': '演奏分析暂时无法读取，已保存的数据保持原样。'}

    def publish(self, resource_id, source, payload, evidence=None, expected_digest=None):
        validate(payload)
        from practice_melody_evidence import encode_evidence, analysis_digest
        if payload.get('melody_evidence') and evidence is None:
            raise ValueError('旋律证据尚未完整保存，原分析保留。')
        blob = encode_evidence(evidence, payload) if evidence is not None else None
        self.directory.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            original = sqlite3.connect(self.path)
            backup = sqlite3.connect(self.directory / 'previous.sqlite3')
            try:
                original.backup(backup)
            finally:
                backup.close(); original.close()
        con = sqlite3.connect(self.path, timeout=5)
        try:
            with con:
                con.execute('BEGIN IMMEDIATE')
                con.execute('CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL, updated REAL NOT NULL)')
                con.execute('CREATE TABLE IF NOT EXISTS melody_evidence (id TEXT PRIMARY KEY, analysis_sha256 TEXT NOT NULL, payload BLOB NOT NULL)')
                con.execute('CREATE TABLE IF NOT EXISTS melody_versions (id TEXT NOT NULL, digest TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, updated REAL NOT NULL, evidence BLOB, PRIMARY KEY(id,digest))')
                old = con.execute('SELECT source,payload,updated FROM results WHERE id=?', (resource_id,)).fetchone()
                if expected_digest is not None and (not old or old[0] != source or analysis_digest(json.loads(old[1])) != expected_digest):
                    raise ValueError('演奏分析已变化，请刷新后重试。')
                if old:
                    old_digest = analysis_digest(json.loads(old[1]))
                    old_evidence = con.execute('SELECT payload FROM melody_evidence WHERE id=? AND analysis_sha256=?', (resource_id,old_digest)).fetchone()
                    con.execute('INSERT OR IGNORE INTO melody_versions VALUES (?,?,?,?,?,?)', (resource_id,old_digest,old[0],old[1],old[2],old_evidence[0] if old_evidence else None))
                con.execute('INSERT OR REPLACE INTO results VALUES (?,?,?,?)', (resource_id, source, json.dumps(payload, ensure_ascii=False, allow_nan=False), time.time()))
                con.execute('DELETE FROM melody_evidence WHERE id=?', (resource_id,))
                if blob is not None:
                    con.execute('INSERT INTO melody_evidence VALUES (?,?,?)', (resource_id, analysis_digest(payload), blob))
                con.execute('INSERT OR IGNORE INTO melody_versions VALUES (?,?,?,?,?,?)', (resource_id,analysis_digest(payload),source,json.dumps(payload,ensure_ascii=False,allow_nan=False),time.time(),blob))
        finally:
            con.close()

    def read_evidence(self, resource_id, source):
        """Only explicit review reads decompress evidence; normal page reads stay light."""
        if not self.path.exists():
            return None
        from practice_melody_evidence import analysis_digest, decode_evidence
        con = sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True, timeout=5)
        try:
            if not con.execute("SELECT 1 FROM sqlite_master WHERE name='melody_evidence' AND type='table'").fetchone():
                return None
            row = con.execute('SELECT r.source,r.payload,e.analysis_sha256,e.payload FROM results r '
                              'JOIN melody_evidence e ON r.id=e.id WHERE r.id=?', (resource_id,)).fetchone()
            if not row or source == 'unavailable' or row[0] != source:
                return None
            payload = json.loads(row[1]); validate(payload)
            if analysis_digest(payload) != row[2]:
                raise ValueError('旋律证据已不属于当前分析。')
            return decode_evidence(row[3], payload)
        finally:
            con.close()

    def versions(self, resource_id, source):
        current = self.read(resource_id, source)
        if current['status'] != 'ready':
            return []
        from practice_melody_evidence import analysis_digest
        digest = analysis_digest(current['analysis'])
        con = sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True, timeout=5)
        try:
            rows = []
            if con.execute("SELECT 1 FROM sqlite_master WHERE name='melody_versions' AND type='table'").fetchone():
                rows = con.execute('SELECT digest,payload,updated FROM melody_versions WHERE id=? AND source=? ORDER BY updated DESC', (resource_id,source)).fetchall()
            if not any(r[0] == digest for r in rows):
                rows.insert(0, (digest,json.dumps(current['analysis']),current['revision']))
            return [dict(digest=d,updated=t,current=d==digest,notes=len(json.loads(p)['notes']),
                         language=json.loads(p).get('provenance',{}).get('language','unspecified')) for d,p,t in rows]
        finally:
            con.close()

    def restore_version(self, resource_id, source, digest, expected_digest):
        if not self.path.exists():
            raise ValueError('演奏分析暂不可用。')
        con = sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True, timeout=5)
        try:
            if not con.execute("SELECT 1 FROM sqlite_master WHERE name='melody_versions' AND type='table'").fetchone():
                raise ValueError('尚无可切换的分析版本。')
            row = con.execute('SELECT payload,evidence FROM melody_versions WHERE id=? AND source=? AND digest=?', (resource_id,source,digest)).fetchone()
        finally:
            con.close()
        if not row:
            raise ValueError('此分析版本不属于当前歌曲。')
        from practice_melody_evidence import decode_evidence, analysis_digest
        payload = json.loads(row[0]); validate(payload)
        if analysis_digest(payload) != digest:
            raise ValueError('分析版本校验失败。')
        evidence = decode_evidence(row[1],payload) if row[1] is not None else None
        self.publish(resource_id,source,payload,evidence,expected_digest=expected_digest)

    def catalog(self):
        if not self.path.exists():
            return []
        con = sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True, timeout=5)
        try:
            totals = {}
            for table, expression in [('melody_versions','length(CAST(payload AS BLOB))+COALESCE(length(evidence),0)'), ('melody_evidence','length(payload)')]:
                if con.execute("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'", (table,)).fetchone():
                    for rid, size in con.execute(f'SELECT id,SUM({expression}) FROM {table} GROUP BY id'):
                        totals[rid] = totals.get(rid,0) + size
            return [dict(id=a,source=b,bytes=c+totals.get(a,0),updated=d) for a,b,c,d in con.execute('SELECT id,source,length(CAST(payload AS BLOB)),updated FROM results')]
        finally:
            con.close()

    def forget(self, resource_id):
        if not self.path.exists():
            return
        con = sqlite3.connect(self.path, timeout=5)
        try:
            with con:
                con.execute('DELETE FROM results WHERE id=?', (resource_id,))
                if con.execute("SELECT 1 FROM sqlite_master WHERE name='melody_evidence' AND type='table'").fetchone():
                    con.execute('DELETE FROM melody_evidence WHERE id=?', (resource_id,))
                if con.execute("SELECT 1 FROM sqlite_master WHERE name='melody_versions' AND type='table'").fetchone():
                    con.execute('DELETE FROM melody_versions WHERE id=?', (resource_id,))
        finally:
            con.close()
