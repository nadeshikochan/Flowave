"""Explicit single-track GPU jobs; immutable output generations and safe reuse."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from music_analysis_store import source_version
from stem_store import StemStore, safe_id, fingerprint, NAMES
from resource_runtime import asset_path, runtime_python, worker_command, worker_environment


class StemService:
    def __init__(self, root, data, snapshot):
        self.root, self.data, self.snapshot = Path(root), Path(data), snapshot
        self.store = StemStore(self.data / 'library/stems')
        self.lock = threading.RLock()
        self.running = False
        self.proc = None
        self.current = None
        self.cancelled = False
        self.verified_files = {}

    def assets(self):
        folder = asset_path(self.root, 'models/stem-separation')
        try:
            manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
            for model in manifest['models']:
                if model.get('default'):
                    for key in ('weights', 'config'):
                        item = model[key]
                        # Only basename asset names, never executable paths from job requests.
                        if Path(item['name']).name != item['name'] or not (folder / item['name']).is_file():
                            raise ValueError('分轨模型不完整，请准备分轨组件。')
                    return folder, manifest, model
        except (OSError, KeyError, ValueError):
            raise ValueError('分轨组件尚未准备好，请先准备分轨模型与编码组件。')
        raise ValueError('尚未选定分轨模型。')

    def status(self):
        with self.lock:
            value = dict(self.current or self.store.task())
            if not self.running and value.get('state') in ('running', 'cancelling'):
                value.update(state='interrupted', message='上次分离已中断，可重新开始；已完成结果保留。')
            if self.running:
                value['elapsed'] = round(time.time() - value.get('started', time.time()), 1)
            return value

    def track(self, rid):
        rows = self.snapshot(safe_id(rid))
        if not rows:
            raise ValueError('歌曲不在当前音乐库中。')
        row = rows[0]
        saved = self.store.get(rid)
        result = {'id': rid, 'status': 'missing', 'task': self.status(), 'mix': self.store.mix(rid), 'usage': self.store.usage()}
        try:
            _, _, model = self.assets()
            result['model'] = {'label': model['label'], 'stems': model['stems'], 'note': model.get('note', '')}
        except ValueError as exc:
            result['component_message'] = str(exc)
            model = None
        if saved:
            valid = saved['source'] == row['source'] and row['source'] != 'unavailable'
            if model:
                valid = valid and saved['recipe'] == model['recipe']
            try:
                for name in saved['stems']:
                    self.store.file(saved, name)
            except ValueError:
                valid = False
            result.update(saved, status='ready' if valid else 'outdated')
            result['stored_bytes'] = self.store.track_usage(rid)
        return result

    def validate(self, rid):
        """Lightweight final handoff check; never enumerate storage or read mixes/tasks."""
        rows = self.snapshot(safe_id(rid))
        saved = self.store.get(rid)
        if not saved:
            return {'id': rid, 'status': 'missing'}
        valid = bool(rows and rows[0]['source'] != 'unavailable' and saved['source'] == rows[0]['source'])
        try:
            _, _, model = self.assets()
        except ValueError:
            model = None
        if model:
            valid = valid and saved['recipe'] == model['recipe']
        if valid:
            try:
                for name in saved['stems']:
                    self.store.file(saved, name)
            except ValueError:
                valid = False
        return {'id': rid, 'status': 'ready' if valid else 'outdated', 'generation': saved['generation'],
                'source': saved['source'], 'recipe': saved['recipe']}

    def library(self):
        live = {row['id']: row for row in self.snapshot()}
        rows = []
        for item in self.store.all():
            row = live.get(item['id'])
            rows.append({'id': item['id'], 'title': Path(row['path']).stem if row else item.get('title', '已移出曲库的歌曲'),
                         'available': bool(row), 'bytes': self.store.track_usage(item['id']),
                         'count': len(item['stems']), 'updated': item['updated']})
        known = {row['id'] for row in rows}
        if self.store.root.is_dir():
            for folder in self.store.root.iterdir():
                if not folder.is_dir() or folder.name in known:
                    continue
                try:
                    safe_id(folder.name)
                except ValueError:
                    continue
                # Interrupted jobs can leave large temporary files without a published DB row.
                if not any(folder.glob('*/job.json')) and not any(folder.glob('*/manifest.json')):
                    continue
                row = live.get(folder.name)
                rows.append({'id': folder.name, 'title': Path(row['path']).stem if row else '未完成的分轨',
                             'available': bool(row), 'bytes': self.store.track_usage(folder.name),
                             'count': 0, 'updated': folder.stat().st_mtime})
        return {'rows': sorted(rows, key=lambda row: row['updated'], reverse=True), 'usage': self.store.usage()}

    def start(self, rid, keep_analysis_input=False):
        with self.lock:
            if self.running:
                raise ValueError('已有分轨任务正在进行。')
            row = next(iter(self.snapshot(safe_id(rid))), None)
            if not row or row['source'] == 'unavailable':
                raise ValueError('请先选择音乐库中可读取的本地歌曲。')
            folder, manifest, model = self.assets()
            python = runtime_python(self.root, 'practice')
            if not python.is_file():
                raise ValueError('当前分轨组件尚未安装，无法开始分离。')
            generation = uuid.uuid4().hex
            jobdir = self.store.root / rid / generation
            jobdir.mkdir(parents=True)
            if shutil.disk_usage(jobdir).free < 2 * 1024**3:
                raise ValueError('分离需要至少2GB可用临时空间，请清理磁盘后重试。')
            job = {'row': row, 'generation': generation, 'output': str(jobdir), 'assets': str(folder), 'model': model,
                   'runtime': manifest['runtime'], 'encoder': manifest['encoder'], 'keep_analysis_input': bool(keep_analysis_input)}
            (jobdir / 'job.json').write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            self.current = {'state': 'running', 'stage': 'preparing', 'id': rid, 'started': time.time(), 'progress': 0}
            self.cancelled = False
            self.store.task(self.current)
            self.running = True
            threading.Thread(target=self._run, args=(python, job, jobdir), daemon=True).start()
            return self.status()

    def cancel(self):
        with self.lock:
            if self.running:
                self.cancelled = True
                self.current['state'] = 'cancelling'
                self.store.task(self.current)
                if self.proc and self.proc.poll() is None:
                    self._terminate(self.proc)
            return self.status()

    @staticmethod
    def _terminate(proc):
        # Windows venv launchers and the encoder can create descendants. Terminate
        # only the tree rooted at this owned Popen, never other GPU applications.
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        else:
            proc.terminate()

    def _run(self, python, job, folder):
        success = False
        try:
            flags = (getattr(subprocess, 'CREATE_NO_WINDOW', 0) | getattr(subprocess, 'BELOW_NORMAL_PRIORITY_CLASS', 0)) if os.name == 'nt' else 0
            env = worker_environment(self.root)
            with (folder / 'worker.log').open('w', encoding='utf-8') as log:
                proc = subprocess.Popen(worker_command(self.root, 'practice', 'stem_worker.py', folder / 'job.json'), cwd=self.root,
                                        env=env, creationflags=flags, stdout=subprocess.PIPE, stderr=log,
                                        text=True, encoding='utf-8', errors='replace')
                with self.lock:
                    self.proc = proc
                    if self.cancelled:
                        self._terminate(proc)
                for line in proc.stdout:
                    log.write(line)
                    log.flush()
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    with self.lock:
                        if not self.cancelled:
                            for key in ('stage', 'progress', 'device', 'message'):
                                if key in event:
                                    self.current[key] = event[key]
                code = proc.wait()
            with self.lock:
                if self.cancelled:
                    raise InterruptedError()
                if code:
                    raise ValueError(self.current.get('message') or '分离未完成，请重试；原有结果保留。')
                payload = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
                now = next(iter(self.snapshot(job['row']['id'])), None)
                if not now or now != job['row'] or source_version(now['path']) != now['source']:
                    raise ValueError('歌曲或音乐库已变化，此次结果未发布，请重新分离。')
                if payload['id'] != now['id'] or payload['source'] != now['source'] or payload['generation'] != job['generation']:
                    raise ValueError('分轨结果与任务身份不一致，已拒绝发布。')
                if set(payload['stems']) != set(job['model']['stems']):
                    raise ValueError('分轨数量与模型不一致。')
                for name, info in payload['stems'].items():
                    if fingerprint(self.store.file(payload, name)) != info['sha256']:
                        raise ValueError('分轨文件校验失败。')
                previous = self.store.get(now['id'])
                self.store.publish(now['id'], payload)
                success = True
                self.current.update(state='completed', stage='saved', progress=100)
                # Old generations are retained until explicit per-song cleanup; never remove files being played.
                if previous:
                    self.current['message'] = '新分轨已保存。旧版本将在清理本曲分轨时一并移除。'
        except InterruptedError:
            with self.lock:
                self.current.update(state='cancelled', message='已取消，已完成的旧结果保留。')
        except Exception as exc:
            with self.lock:
                self.current.update(state='failed', message=str(exc))
        finally:
            with self.lock:
                self.running = False
                self.proc = None
                self.current['finished'] = time.time()
                self.store.task(self.current)
            if not success:
                # This exact directory was created for this job; no source files live here.
                shutil.rmtree(folder, ignore_errors=True)

    def delete(self, rid):
        with self.lock:
            rid = safe_id(rid)
            if self.running and self.current['id'] == rid:
                raise ValueError('请先取消这首歌曲的分离任务。')
            target = (self.store.root / rid).resolve()
            if target.parent != self.store.root.resolve():
                raise ValueError('分轨目录无效。')
            if not self.store.get(rid) and not (any(target.glob('*/job.json')) or any(target.glob('*/manifest.json'))):
                raise ValueError('没有这首歌曲已保存或未完成的分轨。')
            # Rename first, so Windows file-in-use failures leave metadata intact.
            moved = None
            if target.exists():
                moved = target.with_name('deleted-' + uuid.uuid4().hex)
                target.rename(moved)
            if moved:
                try:
                    shutil.rmtree(moved)
                except OSError:
                    moved.rename(target)
                    raise
            self.store.forget(rid)
            return {'ok': True, 'usage': self.store.usage()}

    def media(self, rid, generation, name):
        # Media reads need identity/version checks, not UI mix/task data, global
        # storage totals or stat calls for every sibling stem on each request.
        rows = self.snapshot(safe_id(rid))
        payload = self.store.get(rid)
        if (not rows or not payload or rows[0]['source'] == 'unavailable'
                or payload['source'] != rows[0]['source'] or payload.get('generation') != generation):
            raise ValueError('分轨已更新或失效，请重新载入。')
        try:
            _, _, model = self.assets()
        except ValueError:
            model = None
        if model and payload['recipe'] != model['recipe']:
            raise ValueError('分轨已更新或失效，请重新载入。')
        path = self.store.file(payload, name)
        stat = path.stat()
        key = (str(path), stat.st_size, stat.st_mtime_ns, payload['stems'][name]['sha256'])
        with self.lock:
            verified = self.verified_files.get(key)
        if verified is None:
            verified = fingerprint(path) == payload['stems'][name]['sha256']
            with self.lock:
                if len(self.verified_files) >= 256:
                    self.verified_files.clear()
                self.verified_files[key] = verified
        if not verified:
            raise ValueError('分轨文件校验失败，请重新分离。')
        return path

    def close(self):
        self.cancel()
