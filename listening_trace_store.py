"""Rebuildable, bounded-read trace projection. Importing this module performs no I/O.

Only this explicit store writes its SQLite view. The source journal is read-only;
legacy source bytes are retained independently so the view is disposable.
"""
from __future__ import annotations

import hashlib
import heapq
import json
import math
import os
from contextlib import contextmanager
from pathlib import Path
import re
import sqlite3
import tempfile
import threading


SCHEMA_VERSION = 1
JOURNAL_BATCH_BYTES = 4 * 1024 * 1024
THIN_FIELDS = ('attemptId', 'traceId', 'previousAttemptId', 'resourceId', 'songKey', 'path',
               'at', 'title', 'artist', 'source', 'durationSeconds', 'listenedSeconds',
               'creditedMediaSeconds', 'rejected', 'rejectionReason', 'contextMismatch', 'eventSequence')


class TraceConflict(ValueError):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def atomic_bytes(path, raw):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name, suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def thin(row):
    result = {key: row[key] for key in THIN_FIELDS if key in row}
    decision = row.get('decision')
    if isinstance(decision, dict):
        brief = {key: decision[key] for key in ('id', 'intent', 'trigger', 'contextReferences', 'recordingMembers') if key in decision}
        details = decision.get('policyDetails')
        if isinstance(details, dict):
            brief['policyDetails'] = {key: details[key] for key in ('effective_intent', 'origin_key', 'direction_keys') if key in details}
        result['decision'] = brief
    return result


class ListeningTraceStore:
    def __init__(self, directory, journal_directory=None):
        self.directory = Path(directory)
        self.journal_directory = Path(journal_directory) if journal_directory is not None else self.directory
        self.database = self.directory / 'views.sqlite3'
        self.lock = threading.RLock()

    @contextmanager
    def connect(self, readonly=False, create=False):
        mode = 'ro' if readonly else 'rwc' if create else 'rw'
        con = sqlite3.connect(self.database.resolve().as_uri() + '?mode=' + mode, uri=True, timeout=5)
        con.row_factory = sqlite3.Row
        try:
            if not create and con.execute('PRAGMA user_version').fetchone()[0] != SCHEMA_VERSION:
                raise TraceConflict('Unsupported trace view version')
            with con:
                yield con
        finally:
            con.close()

    def initialize(self):
        """Explicitly create an empty view. No user source is discovered or modified."""
        with self.lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            with self.connect(create=True) as db:
                version = db.execute('PRAGMA user_version').fetchone()[0]
                if version not in (0, SCHEMA_VERSION):
                    raise TraceConflict('Unsupported trace view version')
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('PRAGMA synchronous=FULL')
                db.executescript('''
                  CREATE TABLE IF NOT EXISTS trace_events (
                    event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, sequence INTEGER,
                    payload_json TEXT NOT NULL, source_file TEXT, source_offset INTEGER);
                  CREATE INDEX IF NOT EXISTS event_attempt ON trace_events(attempt_id,sequence);
                  CREATE TABLE IF NOT EXISTS legacy_rows (
                    source_id TEXT NOT NULL, ordinal INTEGER NOT NULL, attempt_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL, PRIMARY KEY(source_id,ordinal));
                  CREATE INDEX IF NOT EXISTS legacy_attempt ON legacy_rows(attempt_id);
                  CREATE TABLE IF NOT EXISTS attempts (
                    attempt_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, observed_order INTEGER NOT NULL,
                    revision INTEGER NOT NULL, baseline_sequence INTEGER, last_sequence INTEGER,
                    visible INTEGER NOT NULL, payload_json TEXT NOT NULL);
                  CREATE INDEX IF NOT EXISTS attempt_route ON attempts(trace_id,observed_order);
                  CREATE TABLE IF NOT EXISTS projection_meta (key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
                ''')
                db.execute(f'PRAGMA user_version={SCHEMA_VERSION}')

    @staticmethod
    def meta(db, key, default=None):
        row = db.execute('SELECT value_json FROM projection_meta WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    @staticmethod
    def put_meta(db, key, value):
        db.execute('INSERT OR REPLACE INTO projection_meta VALUES (?,?)', (key, encoded(value)))

    def import_legacy(self, raw, journal_watermarks=None):
        """Preserve exact source bytes before staging rows; any ambiguity aborts publication."""
        raw = raw.encode('utf-8') if isinstance(raw, str) else raw
        source_id = sha(raw)
        with self.lock:
            self.initialize()
            source = self.directory / ('legacy-' + source_id + '.json')
            if source.exists():
                if source.resolve().parent != self.directory.resolve() or source.read_bytes() != raw:
                    raise TraceConflict('Legacy source digest collision/corruption')
            else:
                atomic_bytes(source, raw)
        rows = json.loads(raw)
        if not isinstance(rows, list):
            raise TraceConflict('Legacy trace must be an array')
        seen = set()
        for i, row in enumerate(rows):
            if not isinstance(row, dict) or not isinstance(row.get('attemptId'), str) or not row['attemptId'] or not isinstance(row.get('path'), str):
                raise TraceConflict(f'Invalid legacy row at {i}; original source retained')
            if row['attemptId'] in seen:
                raise TraceConflict(f'Ambiguous legacy attempt at {i}; original source retained')
            seen.add(row['attemptId'])
            encoded(row)
        with self.lock:
            header_path = self.directory / 'legacy-source.json'
            if header_path.exists():
                header, preserved = self.legacy_source()
                if preserved != raw or header['rows'] != len(rows):
                    raise TraceConflict('A different legacy source header is already installed')
            else:
                watermarks = dict(journal_watermarks or {})
                if any(not re.fullmatch(r'\d{4}-\d{2}\.jsonl', name) or type(offset) is not int or offset < 0
                       for name, offset in watermarks.items()):
                    raise TraceConflict('Invalid captured journal frontier')
                header = dict(schema=SCHEMA_VERSION, file=source.name, sha256=source_id, rows=len(rows),
                              watermarks=watermarks, frontier_known=journal_watermarks is not None)
                atomic_bytes(header_path, encoded(header).encode('utf-8'))
            with self.connect() as db:
                previous = self.meta(db, 'legacy_source')
                if previous:
                    if previous['sha256'] != source_id:
                        raise TraceConflict('A different legacy baseline is already installed')
                    return previous
                for i, row in enumerate(rows):
                    sequence = row.get('eventSequence')
                    sequence = sequence if type(sequence) is int and sequence >= 0 else None
                    payload = encoded(row)
                    db.execute('INSERT INTO legacy_rows VALUES (?,?,?,?)', (source_id, i, row['attemptId'], payload))
                    db.execute('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?)',
                               (row['attemptId'], row.get('traceId') or 'legacy', i, 0, sequence, sequence, 1, payload))
                previous = dict(file=source.name, sha256=source_id, rows=len(rows))
                self.put_meta(db, 'legacy_source', previous)
                self.put_meta(db, 'baseline_journal_watermarks', header['watermarks'])
                self.put_meta(db, 'baseline_frontier_known', header.get('frontier_known', False))
                self.put_meta(db, 'next_order', len(rows))
                return previous

    def _apply(self, db, event, source_file=None, source_offset=None):
        if (not isinstance(event, dict) or type(event.get('schemaVersion')) is not int or event['schemaVersion'] != 1
                or not re.fullmatch(r'[A-Za-z0-9-]{8,100}', str(event.get('eventId', '')))
                or not isinstance(event.get('attemptId'), str) or not event['attemptId']
                or not isinstance(event.get('type'), str) or not event['type'] or not finite(event.get('occurredAt'))):
            raise TraceConflict('Invalid immutable trace event')
        sequence = event.get('eventSequence')
        if sequence is not None and (type(sequence) is not int or sequence < 0):
            raise TraceConflict('Invalid event sequence')
        payload = encoded(event)
        old = db.execute('SELECT payload_json FROM trace_events WHERE event_id=?', (event['eventId'],)).fetchone()
        if old:
            if old[0] != payload:
                raise TraceConflict('Conflicting duplicate event ID')
            return False
        conflict = db.execute('SELECT 1 FROM trace_events WHERE attempt_id=? AND sequence=?', (event['attemptId'], sequence)).fetchone() if sequence is not None else None
        if conflict:
            raise TraceConflict('Conflicting sequence in the same attempt')
        db.execute('INSERT INTO trace_events VALUES (?,?,?,?,?,?)',
                   (event['eventId'], event['attemptId'], sequence, payload, source_file, source_offset))
        saved = db.execute('SELECT * FROM attempts WHERE attempt_id=?', (event['attemptId'],)).fetchone()
        track = event.get('track') or {}
        if not isinstance(track, dict):
            raise TraceConflict('Invalid track reference')
        if saved:
            row = json.loads(saved['payload_json'])
            if row.get('resourceId') and track.get('resourceId') and row['resourceId'] != track['resourceId']:
                raise TraceConflict('Attempt changed its stable song identity')
            if row.get('traceId') and event.get('traceId') and row['traceId'] != event['traceId']:
                raise TraceConflict('Attempt changed its trace identity')
            trace_id, order, revision, visible = saved['trace_id'], saved['observed_order'], saved['revision'] + 1, saved['visible']
            baseline, latest = saved['baseline_sequence'], saved['last_sequence']
        else:
            row = {'attemptId': event['attemptId'], 'traceId': event.get('traceId') or 'legacy'}
            trace_id = row['traceId']
            order = self.meta(db, 'next_order', 0)
            self.put_meta(db, 'next_order', order + 1)
            revision, visible, baseline, latest = 1, 0, None, None
        # Old journal events may predate the complete migration snapshot.
        newer = sequence is None and latest is None or sequence is not None and (latest is None or sequence > latest)
        if saved and baseline is None and db.execute('SELECT 1 FROM legacy_rows WHERE attempt_id=?', (event['attemptId'],)).fetchone():
            watermarks = self.meta(db, 'baseline_journal_watermarks', {})
            # An old snapshot without a sequence cannot be ordered by wall time.
            # Only a captured durable journal boundary proves an event came later.
            newer = bool(newer and self.meta(db, 'baseline_frontier_known', False)
                         and source_file is not None and source_offset is not None
                         and source_offset > watermarks.get(source_file, 0))
        if event['type'] == 'play_started':
            visible = 1
            if 'decision' not in row and isinstance(event.get('decision'), dict):
                row['decision'] = event['decision']
        if event['type'] == 'legacy_observed':
            visible = 1
        if event['type'] in {'play_started', 'legacy_observed'}:
            row['traceArchived'] = True
        if newer:
            for key in ('resourceId', 'songKey', 'path', 'title', 'artist', 'durationSeconds'):
                if key not in row and key in track:
                    row[key] = track[key]
            for key, value in (('at', event.get('startedAt', event['occurredAt'])),
                               ('source', event.get('source', 'unknown')),
                               ('previousAttemptId', event.get('previousAttemptId'))):
                if key not in row:
                    row[key] = value
            if event['type'] != 'legacy_observed':
                for key in ('listenedSeconds', 'creditedMediaSeconds', 'rejected'):
                    if key in event:
                        row[key] = event[key]
            else:
                for key in ('listenedSeconds', 'creditedMediaSeconds', 'rejected'):
                    row.setdefault(key, None)
            if event['type'] == 'rejected' and event.get('reason'):
                row['rejectionReason'] = event['reason']
            if event['type'] == 'correction_requested' and event.get('reason') == 'restore_previous_feeling':
                row['contextMismatch'] = True
            row['traceArchived'] = True
        if sequence is not None:
            latest = sequence if latest is None else max(latest, sequence)
            row['eventSequence'] = latest
        db.execute('INSERT OR REPLACE INTO attempts VALUES (?,?,?,?,?,?,?,?)',
                   (event['attemptId'], trace_id, order, revision, baseline, latest, visible, encoded(row)))
        return True

    def apply_events(self, events):
        with self.lock, self.connect() as db:
            return sum(self._apply(db, event) for event in events)

    def sync_journal(self, max_bytes=JOURNAL_BATCH_BYTES):
        """Read complete new lines only; cursor and projection commit together."""
        if not 32768 <= max_bytes <= JOURNAL_BATCH_BYTES:
            raise ValueError('Invalid bounded journal batch')
        with self.lock, self.connect() as db:
            cursors = self.meta(db, 'journal_cursors', {})
            consumed, applied, pending = 0, 0, False
            files = sorted(p for p in self.journal_directory.iterdir() if re.fullmatch(r'\d{4}-\d{2}\.jsonl', p.name))
            for file in files:
                if file.resolve().parent != self.journal_directory.resolve():
                    raise TraceConflict('Journal source escaped the configured directory')
                cursor = cursors.get(file.name, {'offset': 0, 'anchor': sha(b'')})
                with file.open('rb') as stream:
                    stream.seek(0, 2)
                    size = stream.tell()
                    offset = cursor['offset']
                    if size < offset:
                        raise TraceConflict('Journal was truncated before its committed cursor')
                    stream.seek(max(0, offset - 64))
                    if sha(stream.read(offset - max(0, offset - 64))) != cursor['anchor']:
                        raise TraceConflict('Previously consumed journal bytes changed')
                    stream.seek(offset)
                    data = stream.read(max(0, max_bytes - consumed))
                    boundary = data.rfind(b'\n') + 1
                    for line in data[:boundary].splitlines(keepends=True):
                        end = offset + len(line)
                        if len(line) > 32769:
                            raise TraceConflict('Journal event exceeds the append contract')
                        applied += self._apply(db, json.loads(line), file.name, end)
                        offset = end
                    consumed += boundary
                    stream.seek(max(0, offset - 64))
                    cursors[file.name] = {'offset': offset, 'anchor': sha(stream.read(offset - max(0, offset - 64)))}
                    pending |= offset < size
                if consumed >= max_bytes - 32768:
                    pending |= file != files[-1]
                    break
            self.put_meta(db, 'journal_cursors', cursors)
            return dict(applied=applied, bytes=consumed, pending=pending, cursors=cursors)

    @staticmethod
    def ordered(records, legacy):
        """Preserve legacy relative order and actual predecessor links; reject cycles."""
        by_id = {r['attempt_id']: r for r in records}
        edges = {key: set() for key in by_id}
        degree = dict.fromkeys(by_id, 0)
        def link(left, right):
            if left in by_id and right in by_id and right not in edges[left]:
                edges[left].add(right)
                degree[right] += 1
        for record in records:
            payload = json.loads(record['payload_json'])
            link(payload.get('previousAttemptId'), record['attempt_id'])
        for left, right in zip(legacy, legacy[1:]):
            link(left, right)
        def priority(key):
            r = by_id[key]
            at = json.loads(r['payload_json']).get('at')
            return (at if finite(at) else 0, r['observed_order'], key)
        ready = [priority(key) for key in degree if degree[key] == 0]
        heapq.heapify(ready)
        result = []
        while ready:
            _, _, key = heapq.heappop(ready)
            result.append(by_id[key])
            for other in edges[key]:
                degree[other] -= 1
                if degree[other] == 0:
                    heapq.heappush(ready, priority(other))
        if len(result) != len(records):
            raise TraceConflict('Conflicting/cyclic trace ordering; source retained')
        return result

    def route(self, trace_id, full=False):
        with self.connect(readonly=True) as db:
            records = db.execute('SELECT * FROM attempts WHERE trace_id=? AND visible=1', (trace_id,)).fetchall()
            legacy = [r[0] for r in db.execute('SELECT l.attempt_id FROM legacy_rows l JOIN attempts a ON a.attempt_id=l.attempt_id WHERE a.trace_id=? ORDER BY l.ordinal', (trace_id,))]
        rows = self.ordered(records, legacy)
        return {'traceId': trace_id, 'revision': sum(r['revision'] for r in rows),
                'rows': [json.loads(r['payload_json']) if full else thin(json.loads(r['payload_json'])) for r in rows]}

    def routes(self, limit=100, before_order=None):
        if not 1 <= limit <= 200:
            raise ValueError('Invalid route limit')
        with self.connect(readonly=True) as db:
            rows = db.execute('SELECT trace_id,MIN(observed_order) first_order,MAX(observed_order) last_order,COUNT(*) count,SUM(revision) revision FROM attempts WHERE visible=1 GROUP BY trace_id ORDER BY last_order DESC').fetchall()
        return [dict(r) for r in rows if before_order is None or r['last_order'] < before_order][:limit]

    def attempt(self, attempt_id):
        with self.connect(readonly=True) as db:
            row = db.execute('SELECT payload_json,revision FROM attempts WHERE attempt_id=?', (attempt_id,)).fetchone()
        return None if row is None else {'row': json.loads(row[0]), 'revision': row[1]}

    def export_legacy(self):
        with self.connect(readonly=True) as db:
            records = db.execute('SELECT * FROM attempts WHERE visible=1').fetchall()
            legacy = [r[0] for r in db.execute('SELECT attempt_id FROM legacy_rows ORDER BY ordinal')]
        return [json.loads(r['payload_json']) for r in self.ordered(records, legacy)]

    def validate_source(self):
        with self.connect(readonly=True) as db:
            source = self.meta(db, 'legacy_source')
        if not source:
            return False
        header, _ = self.legacy_source()
        if any(source[key] != header[key] for key in ('file', 'sha256', 'rows')):
            raise TraceConflict('View and preserved legacy source disagree')
        return True

    def legacy_source(self):
        """Recovery metadata is independent of a missing/corrupt disposable view."""
        header = json.loads((self.directory / 'legacy-source.json').read_bytes())
        if header.get('schema') != SCHEMA_VERSION or not re.fullmatch(r'legacy-[a-f0-9]{64}\.json', str(header.get('file', ''))):
            raise TraceConflict('Invalid preserved source header')
        if header['file'] != 'legacy-' + str(header.get('sha256')) + '.json' or type(header.get('rows')) is not int:
            raise TraceConflict('Invalid preserved source provenance')
        if type(header.get('frontier_known', False)) is not bool:
            raise TraceConflict('Invalid captured frontier provenance')
        watermarks = header.get('watermarks')
        if not isinstance(watermarks, dict) or any(not re.fullmatch(r'\d{4}-\d{2}\.jsonl', name)
                or type(offset) is not int or offset < 0 for name, offset in watermarks.items()):
            raise TraceConflict('Invalid preserved journal frontier')
        file = self.directory / header['file']
        if file.resolve().parent != self.directory.resolve():
            raise TraceConflict('Preserved source escaped the archive directory')
        raw = file.read_bytes()
        if sha(raw) != header['sha256']:
            raise TraceConflict('Preserved legacy source is unavailable or changed')
        return header, raw
