"""Explicit composite-seed refresh only; cached NumPy, no audio/model runtime."""
import io
import json
import sqlite3
import threading
from collections import OrderedDict
from contextlib import closing
from pathlib import Path
import numpy as np
from music_analysis_store import recipe_version
from recipe_compatibility import equivalent_recipes, accepted_recipes


class SeedSemanticError(ValueError):
    pass


class SeedSemanticVerifier:
    VERSION = 1  # branch_nearest_minus_005 in the frozen offline evaluation

    def __init__(self, root, database):
        self.root = Path(root)
        self.database = Path(database)
        self.cache = OrderedDict()
        self.lock = threading.RLock()

    def stamp(self):
        result = []
        for path in (self.database, Path(str(self.database) + '-wal')):
            try:
                s = path.stat(); result.append((s.st_size, s.st_mtime_ns))
            except FileNotFoundError:
                result.append(None)
        return tuple(result)

    @staticmethod
    def source(path):
        s = Path(path).stat()
        return f'{s.st_size}:{s.st_mtime_ns}'

    def current(self, snapshot):
        try:
            return (self.stamp() == snapshot['database'] and recipe_version(self.root) == snapshot['recipe']
                    and all(self.source(p) == version for p, version in snapshot['sources'].items()))
        except OSError:
            return False

    def review(self, seeds, candidates, support, own):
        """Only request vectors for MERT-admitted candidates and effective seeds.

        Missing seeds abort refresh, missing candidates are explicitly pending;
        neither is silently interpreted as an ordinary low similarity result.
        """
        try:
            stamp = self.stamp()
            recipe = recipe_version(self.root)
            snapshot = dict(database=stamp, recipe=recipe, sources={})
            with closing(sqlite3.connect(self.database.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)) as con:
                con.execute('BEGIN')
                edges = con.execute('SELECT old,new FROM recipe_compatibility').fetchall()
                accepted = accepted_recipes(recipe, edges, equivalent_recipes(self.root, recipe))

                def load(rid, path):
                    try: source = self.source(path)
                    except OSError: return None
                    snapshot['sources'][path] = source
                    key = (rid, path, source, recipe, stamp)
                    with self.lock:
                        if key in self.cache:
                            self.cache.move_to_end(key)
                            return self.cache[key]
                    row = con.execute('SELECT source,recipe,payload,vectors FROM results WHERE id=?', (rid,)).fetchone()
                    if not row or row[0] != source or row[1] not in accepted or not row[3]: return None
                    try:
                        payload = json.loads(row[2]); segments = payload['segments']
                        duration = float(payload['duration'])
                        matrix = np.load(io.BytesIO(row[3]), allow_pickle=False)
                        if matrix.shape != (len(segments), 512) or not len(segments) or not np.isfinite(matrix).all(): return None
                        start = np.array([float(s['from']) for s in segments])
                        end = np.array([float(s['to']) for s in segments])
                        if (not np.isfinite(duration) or not np.isfinite(start).all() or not np.isfinite(end).all()
                            or abs(start[0]) > .01 or abs(end[-1] - duration) > .01
                            or np.any(end <= start) or np.any(abs(end[:-1] - start[1:]) > .01)): return None
                        norms = np.linalg.norm(matrix, axis=1)
                        valid = np.array([not s.get('silent', False) for s in segments]) & (norms > 0)
                        if not valid.any(): return None
                        vector = np.average(matrix[valid] / norms[valid, None], axis=0, weights=(end - start)[valid])
                        norm = np.linalg.norm(vector)
                        if not np.isfinite(norm) or norm == 0: return None
                        vector = (vector / norm).astype(np.float32)
                    except (ValueError, TypeError, KeyError, EOFError): return None
                    with self.lock:
                        self.cache[key] = vector
                        while len(self.cache) > 1024: self.cache.popitem(last=False)
                    return vector

                seed_vectors = [load(rid, path) for rid, path in seeds]
                missing = sum(v is None for v in seed_vectors)
                if missing:
                    raise SeedSemanticError(f'{missing} 首喜欢方向缺少有效歌曲分析。请先在音乐处理中完成分析；在线歌曲需先下载入库。已有推荐已保留。')
                seed_matrix = np.stack(seed_vectors)
                if len(seeds) > 1:
                    pair = seed_matrix @ seed_matrix.T
                    np.fill_diagonal(pair, -np.inf)
                    thresholds = pair.max(axis=1) - .05
                else:
                    thresholds = np.full(1, .90, dtype=np.float32)
                keep = np.zeros(len(candidates), dtype=bool)
                details = [{} for _ in candidates]
                pending = 0
                pending_tracks = []
                for i, (rid, path) in enumerate(candidates):
                    vector = load(rid, path)
                    if vector is None:
                        pending += 1
                        if len(pending_tracks) < 20: pending_tracks.append(path)
                        continue
                    sims = seed_matrix @ vector
                    margins = np.where(support[:, i], sims - thresholds, -np.inf)
                    anchor = int(np.argmax(margins))
                    keep[i] = bool(own[i] or margins[anchor] >= 0)
                    details[i] = dict(verification_version=self.VERSION, semantic_similarity=float(sims[anchor]),
                        semantic_threshold=float(thresholds[anchor]), semantic_seed=seeds[anchor][1])
            if not self.current(snapshot):
                raise SeedSemanticError('歌曲分析或音频在复核期间发生变化，请重试；已有推荐已保留。')
            return keep, details, dict(verification_version=self.VERSION, verification_policy='branch_nearest_minus_005',
                semantic_pending=pending, semantic_pending_tracks=pending_tracks,
                semantic_rejected=int((~keep).sum()) - pending), snapshot
        except SeedSemanticError:
            raise
        except (OSError, sqlite3.DatabaseError) as exc:
            raise SeedSemanticError('歌曲分析暂不可用，请检查音乐处理页面后重试；已有推荐已保留。') from exc
