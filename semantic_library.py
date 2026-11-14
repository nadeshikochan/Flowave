"""Validated MuQ aggregate cache. Query-index setup belongs to AnalysisStore; no model loading."""
from contextlib import closing
import io
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time

import numpy as np
from music_analysis_store import AnalysisStore, recipe_version
from analysis_visibility import DISPLAY_LIMITS, visible_groups
from recipe_compatibility import equivalent_recipes, accepted_recipes

try:
    from pydantic_core import from_json as _fast_from_json
except ImportError:
    _fast_from_json = None


def _decode_payload(payload):
    if _fast_from_json is not None:
        try:
            return _fast_from_json(payload, cache_strings='keys', allow_partial=False, allow_inf_nan=True)
        except (ValueError, TypeError):
            # Retain stdlib handling of legacy escapes and older core versions.
            pass
    return json.loads(payload)


def aggregate_vector(payload, blob):
    """Same full-coverage/time-weighted contract as the selected seed verifier."""
    if isinstance(payload, (str, bytes, bytearray)):
        payload = _decode_payload(payload)
    segments = payload['segments']
    duration = float(payload['duration'])
    matrix = np.load(io.BytesIO(blob), allow_pickle=False)
    if matrix.shape != (len(segments), 512) or not len(segments) or not np.isfinite(matrix).all():
        return None
    start = np.array([float(s['from']) for s in segments])
    end = np.array([float(s['to']) for s in segments])
    if (not np.isfinite(duration) or not np.isfinite(start).all() or not np.isfinite(end).all()
            or abs(start[0]) > .01 or abs(end[-1] - duration) > .01
            or np.any(end <= start) or np.any(abs(end[:-1] - start[1:]) > .01)):
        return None
    norms = np.linalg.norm(matrix, axis=1)
    valid = np.array([not s.get('silent', False) for s in segments]) & (norms > 0)
    if not valid.any():
        return None
    vector = np.average(matrix[valid] / norms[valid, None], axis=0, weights=(end-start)[valid])
    norm = np.linalg.norm(vector)
    return (vector / norm).astype(np.float32) if np.isfinite(norm) and norm > 0 else None


class SemanticLibrary:
    def __init__(self, root, database):
        self.root, self.database = Path(root), Path(database)
        self.lock = threading.Lock()
        self.snapshot = None
        self.building = False
        self.failed_key = None
        self.failed_at = 0.
        self.row_cache = {}
        self.warming = False
        implementation = b''.join(Path(__file__).with_name(name).read_bytes().replace(b'\r\n', b'\n')
                                  for name in ('semantic_library.py', 'analysis_visibility.py'))
        self.aggregate_version = hashlib.sha256(
            implementation + json.dumps(DISPLAY_LIMITS, sort_keys=True).encode() + np.__version__.encode()).hexdigest()

    def stamp(self):
        # Task/progress writes share this database; they must not invalidate all vectors.
        if not self.database.exists():
            return None, None
        with closing(sqlite3.connect(self.database.resolve().as_uri()+'?mode=ro', uri=True, timeout=5)) as con:
            con.execute('BEGIN')
            columns = {row[1] for row in con.execute('PRAGMA table_info(results)')}
            if 'updated' not in columns:  # Legacy/test databases lack publish revisions.
                def physical(path):
                    try:
                        stat = path.stat()
                        return stat.st_size, stat.st_mtime_ns
                    except (OSError, sqlite3.DatabaseError):
                        return None
                return physical(self.database), physical(Path(str(self.database)+'-wal'))
            rows = con.execute('SELECT id,source,recipe,updated FROM results ORDER BY id').fetchall()
            edges = con.execute('SELECT old,new FROM recipe_compatibility ORDER BY old,new').fetchall()
        digest = hashlib.sha256(json.dumps([rows,edges],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        return digest, len(rows)

    @staticmethod
    def sources(entries):
        result = {}
        for rid, path in entries:
            try:
                s = Path(path).stat()
                result[rid] = f'{s.st_size}:{s.st_mtime_ns}'
            except (OSError, sqlite3.DatabaseError):
                result[rid] = None
        return result

    def revision(self, entries):
        stamp = self.stamp()
        recipe = None if stamp[0] is None or stamp[1] == 0 else recipe_version(self.root)
        return [stamp, recipe, self.sources(entries)]

    def warm(self, entries):
        """Explicit consumer preparation, without blocking the UI or loading models."""
        entries = tuple(entries)
        with self.lock:
            if self.warming or self.building or not entries or not self.database.exists():
                return
            self.warming = True
        def run():
            try:
                try:
                    AnalysisStore(self.database).prepare_query_index()
                except (OSError, sqlite3.DatabaseError):
                    # Optional schema acceleration must not disable a readable store.
                    pass
                self.get(entries)
            finally:
                with self.lock:
                    self.warming = False
        threading.Thread(target=run, daemon=True, name='recommendation-warmup').start()

    def get(self, entries):
        entries = tuple(entries)
        if not entries:
            return {}, 'missing'
        try:
            stamp = self.stamp()
            if stamp[0] is None or stamp[1] == 0:
                return {}, 'missing'
            recipe = recipe_version(self.root)
        except (OSError, sqlite3.DatabaseError):
            return {}, 'unavailable'
        key = (entries, stamp, recipe)
        sources = self.sources(entries)
        with self.lock:
            saved = self.snapshot
            if saved and saved['key'] == key and saved['sources'] == sources:
                return saved['vectors'], 'ready'
            if not self.building and (self.failed_key != (key, sources) or time.monotonic()-self.failed_at > 10):
                self.building = True
                threading.Thread(target=self._build, args=(key, sources), daemon=True,
                                 name='recommendation-semantic-cache').start()
            return {}, 'building' if self.building else 'unavailable'

    def _build(self, key, sources):
        entries, stamp, recipe = key
        vectors, tags = {}, {}
        try:
            store = AnalysisStore(self.database)
            try:
                persisted = store.semantic_aggregates()
            except (OSError, sqlite3.DatabaseError):
                persisted = {}
            derived = []
            with closing(sqlite3.connect(self.database.resolve().as_uri()+'?mode=ro', uri=True, timeout=5)) as con:
                con.execute('BEGIN')
                edges = con.execute('SELECT old,new FROM recipe_compatibility').fetchall()
                accepted = accepted_recipes(recipe, edges, equivalent_recipes(self.root, recipe))
                wanted = dict(entries)
                columns = {row[1] for row in con.execute('PRAGMA table_info(results)')}
                updated_column = 'updated' if 'updated' in columns else 'NULL'
                metadata = con.execute(f'SELECT id,source,recipe,{updated_column} FROM results').fetchall()
                next_rows = {}
                for rid, source, version, updated in metadata:
                    signature = (source, version, updated)
                    saved = self.row_cache.get(rid)
                    if rid in wanted and sources[rid] == source and version in accepted and updated is not None and saved and saved[0] == signature:
                        vectors[rid] = saved[1]
                        tags[rid] = saved[2]
                        next_rows[rid] = saved
                        continue
                    cached = persisted.get(rid)
                    if rid in wanted and sources[rid] == source and version in accepted and updated is not None and cached and cached[:4] == (*signature, self.aggregate_version):
                        try:
                            blob, profile_text, digest = cached[4:]
                            if hashlib.sha256(blob + profile_text.encode()).hexdigest() != digest:
                                raise ValueError('derived checksum')
                            vector = np.frombuffer(blob, dtype='<f4').copy()
                            if vector.shape != (512,) or not np.isfinite(vector).all() or not .999 < float(np.linalg.norm(vector)) < 1.001:
                                raise ValueError('derived vector')
                            profile = _decode_payload(profile_text)
                            if not isinstance(profile, dict):
                                raise ValueError('derived tags')
                            vectors[rid] = vector
                            tags[rid] = profile
                            next_rows[rid] = (signature, vector, profile)
                            continue
                        except (ValueError, TypeError, AttributeError):
                            pass
                    row = con.execute('SELECT payload,vectors FROM results WHERE id=?', (rid,)).fetchone() if rid in wanted and sources[rid] == source and version in accepted else None
                    if not row:
                        continue
                    payload, blob = row
                    if rid not in wanted or sources[rid] != source or version not in accepted or not blob:
                        continue
                    try:
                        payload = _decode_payload(payload)
                        vector = aggregate_vector(payload, blob)
                    except (ValueError, TypeError, KeyError, EOFError, IndexError, AttributeError):
                        continue
                    if vector is not None:
                        vectors[rid] = vector
                        raw_tags = payload.get('tags')
                        groups = visible_groups(raw_tags if isinstance(raw_tags, dict) else {})
                        profile = {kind: {str(t['id']): min(1., float(t['score'])) for t in rows[:8] if t.get('id')}
                                   for kind, rows in groups.items()}
                        tags[rid] = profile
                        next_rows[rid] = (signature, vector, profile)
                        if updated is not None:
                            vector_blob = vector.astype('<f4', copy=False).tobytes()
                            profile_text = json.dumps(profile, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
                            digest = hashlib.sha256(vector_blob + profile_text.encode()).hexdigest()
                            derived.append((rid, source, version, updated, self.aggregate_version, vector_blob, profile_text, digest))
            # Keep provenance-keyed computation memo even when a concurrent publish invalidates this snapshot.
            # It is never served directly; the next build rechecks every row/version and the complete snapshot.
            with self.lock:
                self.row_cache = next_rows
            if self.stamp() != stamp or recipe_version(self.root) != recipe or self.sources(entries) != sources:
                return
            with self.lock:
                self.snapshot = dict(key=key, sources=sources, vectors=vectors, tags=tags)
                self.failed_key = None
                self.row_cache = next_rows
            try:
                store.save_semantic_aggregates(derived)
            except (OSError, sqlite3.DatabaseError):
                pass
        except (OSError, sqlite3.DatabaseError):
            with self.lock:
                self.failed_key = (key, sources)
                self.failed_at = time.monotonic()
        finally:
            with self.lock:
                self.building = False

    def features(self, vectors):
        # Features and semantic vectors share the same source/recipe/publish transaction.
        with self.lock:
            saved = self.snapshot
            return saved.get('tags', {}) if saved and saved['vectors'] is vectors else {}

    def current(self, vectors):
        with self.lock:
            saved = self.snapshot
        if not saved or saved['vectors'] is not vectors:
            return False
        entries, stamp, recipe = saved['key']
        try:
            return self.stamp() == stamp and recipe_version(self.root) == recipe and self.sources(entries) == saved['sources']
        except (OSError, sqlite3.DatabaseError):
            return False
