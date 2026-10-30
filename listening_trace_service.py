"""Explicit trace migration/read coordination; no work or filesystem access at construction."""
from __future__ import annotations

import json
from pathlib import Path
import re
import threading

from listening_trace_store import ListeningTraceStore, TraceConflict, SCHEMA_VERSION


class ListeningTraceService:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.lock = threading.RLock()
        self.stores = {}

    def _store(self, migration_id, existing=True):
        if not isinstance(migration_id, str) or not re.fullmatch(r'[a-f0-9]{32}', migration_id):
            raise TraceConflict('Invalid managed trace generation')
        directory = self.directory / 'views' / migration_id
        if not directory.resolve().is_relative_to(self.directory.resolve()):
            raise TraceConflict('Trace generation escaped its managed directory')
        if existing and not (directory / 'legacy-source.json').is_file():
            raise TraceConflict('Preserved trace source is unavailable')
        if migration_id not in self.stores:
            self.stores[migration_id] = ListeningTraceStore(directory, self.directory)
            while len(self.stores) > 2:
                del self.stores[next(iter(self.stores))]
        return self.stores[migration_id]

    def begin(self, migration_id, legacy_json, watermarks):
        if not isinstance(legacy_json, str) or len(legacy_json.encode('utf-8')) > 64 * 1024 * 1024:
            raise TraceConflict('Invalid or oversized legacy trace snapshot')
        if not isinstance(watermarks, dict):
            raise TraceConflict('A complete durable journal frontier is required')
        with self.lock:
            store = self._store(migration_id, existing=False)
            store.import_legacy(legacy_json, watermarks)
            return self.prepare(migration_id)

    def prepare(self, migration_id):
        """One bounded journal batch per call. Callers retain their current view while pending."""
        with self.lock:
            store = self._store(migration_id)
            status = store.sync_journal()
            with store.connect(readonly=True) as db:
                validated = store.meta(db, 'validated')
                source = store.meta(db, 'legacy_source')
            if not status['pending'] and not validated:
                header, raw = store.legacy_source()
                original = json.loads(raw)
                exported = store.export_legacy()
                by_attempt = {row['attemptId']: row for row in exported}
                mutable = {'eventSequence', 'listenedSeconds', 'creditedMediaSeconds', 'rejected',
                           'rejectionReason', 'contextMismatch', 'traceArchived'}
                for row in original:
                    current = by_attempt.get(row['attemptId'])
                    if current is None or any(key not in mutable and (key not in current or current[key] != value) for key, value in row.items()):
                        raise TraceConflict('Legacy payload failed migration validation')
                legacy_ids = {row['attemptId'] for row in original}
                order = [row['attemptId'] for row in exported if row['attemptId'] in legacy_ids]
                if order != [row['attemptId'] for row in original] or not store.validate_source():
                    raise TraceConflict('Legacy order/source failed migration validation')
                validated = dict(source_sha256=header['sha256'], legacy_rows=len(original))
                with store.connect() as db:
                    store.put_meta(db, 'validated', validated)
            return dict(migrationId=migration_id, schema=SCHEMA_VERSION,
                        status='ready' if validated and not status['pending'] else 'building',
                        source=source, validated=validated, **status)

    def _readable(self, migration_id):
        store = self._store(migration_id)
        with store.connect(readonly=True) as db:
            if not store.meta(db, 'validated'):
                raise TraceConflict('Trace view is still being prepared')
        return store

    def routes(self, migration_id, limit=100, before_order=None):
        with self.lock:
            status = self.prepare(migration_id)
            store = self._readable(migration_id)
            rows = store.routes(limit, before_order)
            with store.connect(readonly=True) as db:
                for row in rows:
                    first = db.execute("SELECT json_extract(payload_json,'$.at') FROM attempts WHERE trace_id=? AND visible=1 ORDER BY observed_order LIMIT 1", (row['trace_id'],)).fetchone()
                    row['startedAt'] = first[0] if first else None
            return dict(rows=rows, cursor=rows[-1]['last_order'] if len(rows) == limit else None,
                        syncing=status['pending'], schema=SCHEMA_VERSION)

    def route(self, migration_id, trace_id):
        if not isinstance(trace_id, str) or not 1 <= len(trace_id) <= 256:
            raise TraceConflict('Invalid trace identity')
        with self.lock:
            status = self.prepare(migration_id)
            return {**self._readable(migration_id).route(trace_id), 'syncing': status['pending']}

    def attempt(self, migration_id, attempt_id):
        if not isinstance(attempt_id, str) or not 1 <= len(attempt_id) <= 256:
            raise TraceConflict('Invalid playback attempt identity')
        with self.lock:
            self.prepare(migration_id)
            return self._readable(migration_id).attempt(attempt_id)

    def export(self, migration_id):
        with self.lock:
            status = self.prepare(migration_id)
            if status['pending']:
                raise TraceConflict('Journal replay is incomplete; rollback export is not ready')
            return self._readable(migration_id).export_legacy()

    def rebuild(self, previous_id, migration_id):
        """Create a new generation; never replace/remove a corrupt selected SQLite file."""
        if previous_id == migration_id:
            raise TraceConflict('Rebuild requires a new managed generation')
        with self.lock:
            previous = self._store(previous_id)
            header, raw = previous.legacy_source()
            if not header.get('frontier_known'):
                raise TraceConflict('Original journal frontier is unknown; preserve sources for explicit recovery')
            return self.begin(migration_id, raw.decode('utf-8'), header['watermarks'])
