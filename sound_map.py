"""Read-only, versioned sound graph. The builder runs in a low-priority process."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

VERSION = 4


def _json_write(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    # Windows readers/virus scanners may briefly hold a handle without delete
    # sharing. Keep the previous complete file until a bounded retry succeeds.
    for attempt in range(8):
        try:
            os.replace(temp, path)
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(.004 * (attempt + 1))


def build_graph(vectors, ids, progress=lambda *_: None):
    import numpy as np

    v = np.asarray(vectors, dtype=np.float32)
    if v.ndim != 2 or len(v) != len(ids) or len(set(ids)) != len(ids) or not len(v):
        raise ValueError('invalid_graph_identity')
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    if not np.isfinite(v).all() or not np.isfinite(norms).all() or (norms <= 0).any():
        raise ValueError('invalid_graph_vector')
    v = v / norms
    n = len(v)
    k = min(24, n - 1)
    neighbors = np.empty((n, k), dtype=np.int32)
    scores = np.empty((n, k), dtype=np.float32)
    for start in range(0, n, 96):
        stop = min(n, start + 96)
        sims = np.clip(v[start:stop] @ v.T, -1, 1)
        for row, i in enumerate(range(start, stop)):
            sims[row, i] = -np.inf
            # Stable tie ordering is important for identical recordings/vectors.
            order = np.lexsort((np.arange(n), -sims[row]))[:k]
            neighbors[i] = order
            scores[i] = sims[row, order]
        progress('neighbors', stop, n)
    sets = [set(row) for row in neighbors]
    edge_map = {}
    for i, row in enumerate(neighbors):
        for rank, j in enumerate(row):
            j = int(j)
            mutual = i in sets[j]
            if mutual or rank < 2:
                pair = (min(i, j), max(i, j))
                edge_map[pair] = [pair[0], pair[1], round(float(scores[i, rank]), 7), int(mutual)]

    centered = v - v.mean(axis=0)
    if n > 1 and float(np.linalg.norm(centered)) > 1e-7:
        rng = np.random.default_rng(7421)
        q, _ = np.linalg.qr(centered @ rng.standard_normal((v.shape[1], min(12, n)), dtype=np.float32))
        q, _ = np.linalg.qr(centered @ (centered.T @ q))
        _, _, vt = np.linalg.svd(q.T @ centered, full_matrices=False)
        xyz = centered @ vt[:3].T
        xyz = np.pad(xyz, ((0, 0), (0, max(0, 3 - xyz.shape[1]))))
        xyz /= max(float(np.quantile(np.linalg.norm(xyz, axis=1), .97)), 1e-6)
    else:
        xyz = np.zeros((n, 3), dtype=np.float32)
    progress('hierarchy', 0, n)

    # A nested tree built in the ORIGINAL vector space. Spatial tiles never define membership.
    groups = []
    def partition(members, parent=None, depth=0):
        group_id = len(groups)
        local = v[members]
        mean = local.mean(axis=0)
        representative = int(members[np.argmax(local @ mean)])
        group = {'id': group_id, 'parent': parent, 'children': [], 'count': len(members),
                 'members': [int(i) for i in members], 'representative': representative,
                 'position': xyz[members].mean(axis=0).round(6).tolist(), 'depth': depth}
        groups.append(group)
        if len(members) < 45 or depth >= 7:
            return group_id
        # Deterministic spherical bisection, retained only with actual graph separation.
        a = int(np.argmin(local @ mean))
        b = int(np.argmin(local @ local[a]))
        if float(np.linalg.norm(local[a] - local[b])) < 1e-5:
            return group_id
        centers = local[[a, b]].copy()
        for _ in range(14):
            labels = (local @ centers.T).argmax(axis=1)
            counts = np.bincount(labels, minlength=2)
            if min(counts) < max(8, len(members) * .04):
                return group_id
            for j in range(2):
                centers[j] = local[labels == j].mean(axis=0)
            centers /= np.maximum(np.linalg.norm(centers, axis=1, keepdims=True), 1e-8)
        label_map = dict(zip(map(int, members), map(int, labels)))
        crossing = 0
        internal = 0
        for i in members:
            for j in neighbors[i]:
                if int(j) in label_map:
                    internal += 1
                    crossing += label_map[int(i)] != label_map[int(j)]
        # Do not create a false island just to reach a requested number of groups.
        if internal and crossing / internal > .32:
            return group_id
        for label in range(2):
            group['children'].append(partition(members[labels == label], group_id, depth + 1))
        return group_id

    partition(np.arange(n))
    progress('layout', n, n)
    # Nested display positions: children retain their parent anchor on expansion.
    layout = xyz.copy()
    def arrange(gid, origin, radius):
        g = groups[gid]
        g['position'] = [round(float(x), 6) for x in origin]
        g['radius'] = round(float(radius), 6)
        children = g['children']
        if children:
            c0, c1 = (groups[c]['members'] for c in children)
            direction = xyz[c1].mean(axis=0) - xyz[c0].mean(axis=0)
            length = float(np.linalg.norm(direction))
            if length < 1e-6:
                direction = np.array([1., .3, .2])
                length = float(np.linalg.norm(direction))
            direction /= length
            arrange(children[0], origin - direction * radius * .46, radius * .52)
            arrange(children[1], origin + direction * radius * .46, radius * .52)
        else:
            members = g['members']
            sub = xyz[members] - xyz[members].mean(axis=0)
            extent = max(float(np.max(np.linalg.norm(sub, axis=1))), 1e-6)
            layout[members] = origin + sub / extent * radius * .88
    arrange(0, np.zeros(3), 2.4)
    if n > 24:
        # Independent NumPy implementation of the near/mid-near/further-pair
        # objectives described in Wang et al., JMLR 22(201), 2021 (PaCMAP).
        # Exact cosine neighbors are reused; no package/model runtime is loaded.
        rng = np.random.default_rng(7421)
        near_count = min(12, k)
        source = np.repeat(np.arange(n), near_count)
        target = neighbors[:, :near_count].reshape(-1)
        mid_source = np.repeat(np.arange(n), 5)
        mid_target = np.empty(n * 5, dtype=np.int32)
        for start in range(0, n, 64):
            stop = min(n, start + 64)
            candidates = rng.integers(0, n, (stop - start, 5, 6))
            own = np.arange(start, stop)[:, None, None]
            candidates = np.where(candidates == own, (candidates + 1) % n, candidates)
            similarities = np.einsum('id,ijkd->ijk', v[start:stop], v[candidates])
            choice = np.argsort(-similarities, axis=2)[:, :, 1]
            mid_target[start*5:stop*5] = np.take_along_axis(candidates, choice[:, :, None], axis=2).reshape(-1)
        far_source = np.repeat(np.arange(n), 10)
        far_target = np.empty(n * 10, dtype=np.int32)
        for i in range(n):
            forbidden = set(neighbors[i, :near_count]) | {i}
            candidates = rng.permutation(n)
            selected = [int(j) for j in candidates if j not in forbidden][:10]
            far_target[i*10:(i+1)*10] = selected
        # Three stages: establish broad structure, balance, then refine neighbors.
        layout = xyz.astype(np.float32).copy()
        layout += rng.normal(0, .0001, layout.shape).astype(np.float32)
        first_moment = np.zeros_like(layout)
        second_moment = np.zeros_like(layout)
        for step in range(300):
            if step < 75:
                near_weight, mid_weight, far_weight = 2., 1000. * (1-step/75) + 3.*step/75, 1.
            elif step < 150:
                near_weight, mid_weight, far_weight = 3., 3., 1.
            else:
                near_weight, mid_weight, far_weight = 1., 0., 1.
            gradient = np.zeros_like(layout)
            for left, right, kind, weight in ((source, target, 'near', near_weight),
                                             (mid_source, mid_target, 'mid', mid_weight),
                                             (far_source, far_target, 'far', far_weight)):
                if not weight:
                    continue
                delta = layout[left] - layout[right]
                squared = 1 + np.sum(delta * delta, axis=1)
                if kind == 'near':
                    coefficient = weight * 20 / (10 + squared)**2
                elif kind == 'mid':
                    coefficient = weight * 20000 / (10000 + squared)**2
                else:
                    coefficient = -weight * 2 / (1 + squared)**2
                contribution = delta * coefficient[:, None]
                for axis in range(3):
                    gradient[:, axis] += (np.bincount(left, contribution[:, axis], minlength=n)
                                          - np.bincount(right, contribution[:, axis], minlength=n))
            first_moment = .9 * first_moment + .1 * gradient
            second_moment = .999 * second_moment + .001 * gradient * gradient
            rate = .8 * np.sqrt(1-.999**(step+1)) / (1-.9**(step+1))
            layout -= rate * first_moment / (np.sqrt(second_moment) + 1e-7)
            if step % 25 == 0:
                progress('layout', step, 300)
        layout -= layout.mean(axis=0)
        layout *= 2.4 / max(float(np.quantile(np.linalg.norm(layout, axis=1), .99)), 1e-6)
        for group in groups:
            members = group['members']
            center = layout[members].mean(axis=0)
            group['position'] = center.round(6).tolist()
            group['radius'] = round(max(.015, float(np.quantile(np.linalg.norm(layout[members] - center, axis=1), .95))), 6)
    progress('layout', n, n)
    return {'version': VERSION, 'ids': ids, 'positions': layout.round(6).tolist(),
            'groups': groups, 'edges': list(edge_map.values()), 'neighbors': neighbors.tolist()}


def worker_main(directory):
    import numpy as np
    folder = Path(directory)
    meta = json.loads((folder / 'input.json').read_text(encoding='utf-8'))
    def progress(phase, done, total):
        try:
            _json_write(folder / 'progress.json', {'phase': phase, 'done': done, 'total': total})
        except PermissionError:
            # A lost progress update must not invalidate an otherwise valid graph.
            pass
    graph = build_graph(np.load(folder / 'input.npy', allow_pickle=False), meta['ids'], progress)
    graph['fingerprint'] = meta['fingerprint']
    if json.loads((folder / 'input.json').read_text(encoding='utf-8')) != meta:
        raise RuntimeError('stale_graph_input')
    _json_write(folder / 'graph.json', graph)
    _json_write(folder / 'graph-checksum.json', {'sha256': hashlib.sha256((folder / 'graph.json').read_bytes()).hexdigest()})
    return 0


class SoundMapService:
    def __init__(self, directory):
        self.folder = Path(directory)
        self.lock = threading.Lock()
        self.process = None
        self.source_generation = ''
        self.fingerprint = ''
        self.graph = None
        self.error = False
        self.started = 0.

    def status(self, generation, ids, vectors, retry=False):
        import numpy as np
        with self.lock:
            if self.process is not None:
                code = self.process.poll()
                if code is None:
                    if time.monotonic() - self.started > 180:
                        self.process.terminate()
                        self.process.wait(timeout=5)
                        self.process = None
                        self.error = True
                    else:
                        try:
                            progress = json.loads((self.folder / 'progress.json').read_text(encoding='utf-8'))
                        except (OSError, ValueError):
                            progress = {}
                        return {'status': 'building', **progress}
                else:
                    self.process = None
                    self.error = code != 0
                    self.graph = None
            if generation != self.source_generation:
                v = np.ascontiguousarray(vectors, dtype='<f4')
                h = hashlib.sha256(v.tobytes())
                h.update(json.dumps(ids, separators=(',', ':')).encode())
                h.update(str(VERSION).encode())
                self.fingerprint = h.hexdigest()
                self.source_generation = generation
                self.graph = None
                self.error = False
            if self.graph is None and not self.error:
                try:
                    raw = (self.folder / 'graph.json').read_bytes()
                    checksum = json.loads((self.folder / 'graph-checksum.json').read_text(encoding='utf-8'))
                    if hashlib.sha256(raw).hexdigest() != checksum.get('sha256'):
                        raise ValueError('graph_checksum_mismatch')
                    graph = json.loads(raw)
                    if (graph.get('version') == VERSION and graph.get('fingerprint') == self.fingerprint
                            and graph.get('ids') == ids and len(graph['positions']) == len(ids)
                            and np.asarray(graph['positions']).shape == (len(ids), 3)
                            and np.isfinite(np.asarray(graph['positions'], dtype=float)).all()
                            and graph.get('groups') and graph['groups'][0]['count'] == len(ids)):
                        self.graph = graph
                except (OSError, ValueError, KeyError, TypeError):
                    pass
            if self.graph is not None:
                return {'status': 'ready', 'generation': generation, 'graph': self.graph}
            if self.error and not retry:
                return {'status': 'error', 'message': '声音地图生成失败，可以重试。'}
            self.error = False
            self.folder.mkdir(parents=True, exist_ok=True)
            np.save(self.folder / 'input.npy', np.asarray(vectors, dtype=np.float32), allow_pickle=False)
            _json_write(self.folder / 'input.json', {'ids': ids, 'fingerprint': self.fingerprint})
            _json_write(self.folder / 'progress.json', {'phase': 'neighbors', 'done': 0, 'total': len(ids)})
            launcher = Path(__file__).with_name('backend_launcher.py')
            command = ([sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, str(launcher)])
            command += ['--sound-map-worker', str(self.folder)]
            flags = 0
            if os.name == 'nt':
                flags = subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS
            self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, creationflags=flags,
                env={**os.environ, 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'})
            self.started = time.monotonic()
            return {'status': 'building', 'phase': 'neighbors', 'done': 0, 'total': len(ids)}

    def close(self):
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            self.process = None
