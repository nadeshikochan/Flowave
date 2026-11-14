"""One explicit library preparation spanning existing index, feature and map jobs."""
from copy import deepcopy
from threading import RLock
import time
import uuid


class RecommendationPreparation:
    def __init__(self, analysis, maps, graph_snapshot, worker_status, cancel_worker, prepare_consumer=None):
        self.analysis = analysis
        self.maps = maps
        self.graph_snapshot = graph_snapshot
        self.worker_status = worker_status
        self.cancel_worker = cancel_worker
        self.prepare_consumer = prepare_consumer
        self.lock = RLock()
        self.operation = None

    @property
    def running(self):
        with self.lock:
            return bool(self.operation and self.operation['running'])

    @property
    def identifier(self):
        with self.lock:
            return self.operation['id'] if self.operation else None

    @property
    def cancelled(self):
        with self.lock:
            return bool(self.operation and self.operation['cancel_requested'])

    def begin(self):
        with self.lock:
            if self.running:
                raise ValueError('已有曲库准备任务，请等待完成或先取消。')
            self.operation = dict(id=uuid.uuid4().hex, running=True, phase='sound',
                cancel_requested=False, last_started_at=time.time(), last_finished_at=None,
                last_ok=None, last_error='', stages={}, analysis_started=False, map_generation=None)
            return self.operation['id']

    def _advance(self, phase):
        with self.lock:
            if self.cancelled:
                raise InterruptedError('任务已取消，已保存的索引和分析结果保留。')
            self.operation['phase'] = phase

    def run(self, build_index, refresh_index):
        try:
            self._advance('sound')
            build_index()
            refresh_index()
            sound_progress = deepcopy(self.worker_status().get('progress', {}))
            with self.lock:
                self.operation['stages']['sound'] = sound_progress
            self._advance('features')
            # The analysis coordinator owns its worker and result transaction.
            result = self.analysis.start('missing', [], target='tags', allow_empty=True)
            with self.lock:
                self.operation['analysis_started'] = not result.get('skipped', False)
                self.operation['stages']['features'] = result
            if self.cancelled:
                self.cancel()
            while self.analysis.running and not result.get('skipped'):
                time.sleep(.2)
            self._advance('features')
            if not result.get('skipped'):
                result = self.analysis.status()
            with self.lock:
                self.operation['stages']['features'] = result
            if result.get('state') != 'completed' or result.get('failed'):
                message = result.get('message') or '部分歌曲的语义与标签尚未完成，可更新索引补齐。'
                raise ValueError('声音索引已保存，语义与标签准备未完成。' + message)
            if self.prepare_consumer:
                result = {**result, 'semantic_count':self.prepare_consumer(lambda:self.cancelled)}
                with self.lock:
                    self.operation['stages']['features'] = result

            self._advance('map')
            snapshot = self.graph_snapshot()
            if not snapshot['ids']:
                raise ValueError('没有可用于声音地图的歌曲向量。')
            with self.lock:
                self.operation['map_generation'] = snapshot['generation']
            while True:
                self._advance('map')
                result = self.maps.status(snapshot['generation'], snapshot['ids'], snapshot['vectors'])
                if self.cancelled:
                    self.maps.close(generation=snapshot['generation'])
                    self._advance('map')
                progress = {key: result[key] for key in ('status', 'phase', 'done', 'total') if key in result}
                with self.lock:
                    self.operation['stages']['map'] = progress
                if result['status'] == 'ready':
                    break
                if result['status'] != 'building':
                    raise ValueError(result.get('message') or '声音地图准备未完成，已有索引与分析保留。')
                time.sleep(.2)
            failed_sound = sound_progress.get('failed', 0)
            if failed_sound:
                raise ValueError(f'{failed_sound}首歌曲的声音向量未成功，已完成的索引与地图保留。请更新索引重试。')
            self._advance('complete')
            with self.lock:
                self.operation['last_ok'] = True
        except Exception as error:
            with self.lock:
                self.operation['last_ok'] = False
                self.operation['last_error'] = str(error)
            raise
        finally:
            with self.lock:
                self.operation['running'] = False
                self.operation['last_finished_at'] = time.time()
        return self.status()

    def cancel(self):
        with self.lock:
            active = self.running
            if active:
                self.operation['cancel_requested'] = True
                phase = self.operation['phase']
                analysis_started = self.operation['analysis_started']
                generation = self.operation['map_generation']
        if not active:
            return self.cancel_worker()
        if phase == 'sound':
            self.cancel_worker()
        elif phase == 'features' and analysis_started and self.analysis.running:
            try:
                self.analysis.control('cancel')
            except ValueError:
                if self.analysis.running:
                    raise
        elif phase == 'map' and generation:
            self.maps.close(generation=generation)
        return {'ok':True, 'running':True, 'cancel_requested':True}

    def status(self):
        with self.lock:
            current = deepcopy(self.operation)
        worker = self.worker_status()
        if current is None or (not current['running'] and (worker.get('last_started_at') or 0) > (current['last_finished_at'] or 0)):
            return worker
        phase = current['phase']
        progress = deepcopy(current['stages'].get(phase, {}))
        if phase == 'sound':
            progress = deepcopy(worker.get('progress', {})) if (worker.get('last_started_at') or 0) >= current['last_started_at'] else {'stage':'starting'}
        elif phase == 'features':
            if current['analysis_started']:
                progress = self.analysis.status()
            progress = {**progress, 'stage':'features', 'embedded':progress.get('success',0)}
        elif phase == 'map':
            progress = {**progress, 'stage':'map'}
        elif phase == 'complete':
            features = current['stages'].get('features', {})
            progress = {**features, 'stage':'complete', 'embedded':features.get('success',0)}
        if phase in ('features','complete') and progress.get('device') not in (None, '', '正在确认'):
            # The tags worker emits its verified CUDA device name after admission.
            progress['device_name'] = progress['device']
            progress['device'] = 'cuda'
        current['progress'] = progress
        current['preparation_phase'] = phase
        current['preparation_step'] = {'sound':1, 'features':2, 'map':3, 'complete':3}[phase]
        current['preparation_steps'] = 3
        return current
