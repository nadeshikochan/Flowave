"""One explicit preparation task; serial GPU stages and independently safe results."""
from pathlib import Path
import json
import os
import subprocess
import threading
import time
import uuid
from music_analysis_store import source_version
from stem_store import safe_id
from resource_runtime import asset_path, runtime_python, worker_command, worker_environment

class PracticeService:
    def __init__(self, root, data, snapshot, stems, store):
        self.root, self.data, self.snapshot = Path(root), Path(data), snapshot
        self.stems, self.store = stems, store
        self.lock = threading.RLock(); self.running = False; self.cancelled = False; self.proc = None; self.current = None
        self.taskfile = self.data / 'library/practice-analysis/task.json'

    def status(self):
        with self.lock:
            value = dict(self.current or {})
            if not value and self.taskfile.exists():
                try:
                    value = json.loads(self.taskfile.read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    value = {'state':'interrupted','message':'上次演奏准备状态无法读取，已保存结果保留。'}
            if not self.running and value.get('state') in ('running','cancelling'):
                value.update(state='interrupted',message='上次演奏准备已中断，可继续补齐缺失部分。')
            if self.running:
                value['elapsed'] = round(time.time()-value.get('started',time.time()),1)
            return value or {'state':'idle'}

    def save(self):
        self.taskfile.parent.mkdir(parents=True,exist_ok=True)
        temp = self.taskfile.with_suffix('.tmp')
        temp.write_text(json.dumps(self.current,ensure_ascii=False,allow_nan=False),encoding='utf-8')
        for attempt in range(4):
            try:
                temp.replace(self.taskfile); return
            except PermissionError:
                if attempt == 3: raise
                time.sleep(.04*(attempt+1))

    def component(self):
        path = asset_path(self.root, 'models/practice-analysis/manifest.json')
        try:
            manifest = json.loads(path.read_text(encoding='utf-8'))
            if manifest.get('schema') != 1 or manifest.get('recipe') != 'practice-combined-v1': raise ValueError()
            for name in ('sheetsage2/model.safetensors','mert2/model.safetensors','game-model/model.pt','game-source/inference/me_infer.py'):
                info = next(f for f in manifest['files'] if f['path']==name)
                if (path.parent/name).stat().st_size != info['bytes']: raise ValueError()
            runtime_python(self.root,'practice')
            return path.parent
        except (OSError, ValueError, KeyError, StopIteration):
            raise ValueError('演奏分析组件尚未准备完整，暂不能开始准备。')

    def track(self, rid):
        row = next(iter(self.snapshot(safe_id(rid))),None)
        if not row: raise ValueError('歌曲已不在当前曲库中。')
        detail = self.stems.track(rid)
        analysis = self.store.read(rid,row['source'])
        message = ''
        if analysis['status'] != 'ready':
            try: self.component()
            except ValueError as exc: message = str(exc)
        if detail['status'] != 'ready' and detail.get('component_message'):
            message = detail['component_message']
        if analysis['status']=='unreadable':
            message = analysis['message']
        return {**detail,'analysis':analysis,'preparation':self.status(),'preparation_message':message,
                'prepared':detail['status']=='ready' and analysis['status']=='ready'}

    def start(self, rid, force=False, melody_only=False, melody_language='unspecified'):
        with self.lock:
            if melody_language not in ('unspecified', 'ja', 'en', 'zh', 'yue'):
                raise ValueError('请选择支持的演唱语言。')
            if force and melody_only:
                raise ValueError('重新准备与更新旋律请分别操作。')
            if self.running: raise ValueError('已有演奏准备任务，请等待或先取消。')
            if self.stems.running: raise ValueError('已有分轨任务正在进行，请先等待完成。')
            row = next(iter(self.snapshot(safe_id(rid))),None)
            if not row or row['source']=='unavailable': raise ValueError('请选择曲库中可读取的本地歌曲。')
            detail = self.track(rid)
            if detail['analysis']['status']=='unreadable':
                raise ValueError('演奏分析数据库暂时不可读，请先处理存储问题，原有结果保留。')
            if melody_only and (detail['status'] != 'ready' or detail['analysis']['status'] != 'ready'):
                raise ValueError('请先准备好这首歌的分轨与演奏分析。')
            need_stems = force or detail['status'] != 'ready'
            need_analysis = melody_only or force or detail['analysis']['status'] != 'ready'
            assets = self.component() if need_analysis else None
            if need_stems or need_analysis:
                self.stems.assets() # Both inference and original-audio decoding require the managed encoder.
            self.current = dict(state='running',stage='preparing',id=rid,progress=0,started=time.time(),
                                reused_stems=not need_stems,reused_analysis=not need_analysis,message='')
            self.cancelled=False;self.running=True
            try: self.save()
            except Exception:
                self.running=False;raise
            threading.Thread(target=self._run,args=(row,need_stems,need_analysis,assets,melody_only,melody_language),daemon=True).start()
            return self.status()

    def check(self, row):
        if self.cancelled: raise InterruptedError()
        now = next(iter(self.snapshot(row['id'])),None)
        if now != row or source_version(row['path']) != row['source']:
            raise ValueError('歌曲或曲库已变化，新的分析未采用，已有结果保留。')

    def _run(self, row, need_stems, need_analysis, assets, melody_only=False, melody_language='unspecified'):
        temporary = None; folder = None
        try:
            self.check(row)
            if need_stems:
                self.stems.start(row['id'],keep_analysis_input=need_analysis)
                while True:
                    if self.cancelled:
                        self.stems.cancel()
                    status = self.stems.status()
                    with self.lock:
                        self.current.update(stage=status.get('stage','separating'),progress=round(float(status.get('progress',0))*.55,1),device=status.get('device',''))
                    if not self.stems.running:
                        if status.get('state') != 'completed':
                            if self.cancelled: raise InterruptedError()
                            raise ValueError(status.get('message') or '音轨未完成，已保存结果保留。')
                        if need_analysis:
                            saved=self.stems.store.get(row['id'])
                            if saved:
                                temporary=self.stems.store.root/row['id']/saved['generation']/'practice-vocals.wav'
                        break
                    time.sleep(.15)
            self.check(row)
            if need_analysis:
                stem = self.stems.store.get(row['id'])
                if not stem or stem['source'] != row['source']:
                    raise ValueError('缺少与当前歌曲对应的人声音轨。')
                private = self.stems.store.root / row['id'] / stem['generation'] / 'practice-vocals.wav'
                if need_stems and private.is_file():
                    temporary = private; vocal = private; vocal_input = 'pre-encode-float-six-stem'
                else:
                    vocal = self.stems.media(row['id'],stem['generation'],'vocals'); vocal_input = 'reused-opus-six-stem'
                folder = self.data / 'cache/practice-jobs' / uuid.uuid4().hex
                folder.mkdir(parents=True)
                sfolder, smanifest, _ = self.stems.assets()
                job = dict(row=row,assets=str(assets),output=str(folder),vocals=str(vocal),vocal_input=vocal_input,
                           melody_language=melody_language,
                           encoder=dict(path=str(sfolder/smanifest['encoder']['name']),sha256=smanifest['encoder']['sha256']))
                if melody_only:
                    previous = self.store.read(row['id'],row['source'])
                    if previous['status'] != 'ready':
                        raise ValueError('原演奏分析已变化，请刷新后重试。')
                    job['reuse_analysis'] = previous['analysis']
                (folder/'job.json').write_text(json.dumps(job,ensure_ascii=False),encoding='utf-8')
                self.run_worker(folder)
                self.check(row)
                payload = json.loads((folder/'result.json').read_text(encoding='utf-8'))
                evidence_path = folder/'melody-evidence.json'
                evidence = json.loads(evidence_path.read_text(encoding='utf-8')) if evidence_path.exists() else None
                with self.lock:
                    self.check(row)
                    if evidence is None:
                        self.store.publish(row['id'],row['source'],payload)
                    else:
                        self.store.publish(row['id'],row['source'],payload,evidence=evidence)
            with self.lock:
                self.check(row)
                self.current.update(state='completed',stage='ready',progress=100,message='演奏已准备好。')
        except InterruptedError:
            with self.lock: self.current.update(state='cancelled',message='已取消，已保存的分轨与分析保留。')
        except Exception as exc:
            with self.lock: self.current.update(state='failed',message=str(exc))
        finally:
            for owned in [temporary, folder/'original.wav' if folder else None]:
                if owned:
                    for attempt in range(4):
                        try:
                            owned.unlink(missing_ok=True);break
                        except OSError:
                            if attempt==3:self.current['cleanup_pending']=True
                            else:time.sleep(.05*(attempt+1))
            with self.lock:
                self.running=False;self.proc=None;self.current['finished']=time.time()
                try: self.save()
                except OSError: pass

    def run_worker(self, folder):
        flags=(getattr(subprocess,'CREATE_NO_WINDOW',0)|getattr(subprocess,'BELOW_NORMAL_PRIORITY_CLASS',0)) if os.name=='nt' else 0
        with (folder/'worker.log').open('w',encoding='utf-8') as log:
            proc = subprocess.Popen(worker_command(self.root,'practice','practice_worker.py',folder/'job.json'),cwd=self.root,
                                    creationflags=flags,stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf-8',errors='replace',env=worker_environment(self.root))
            try:
                with self.lock:
                    self.proc=proc
                    if self.cancelled: self.stems._terminate(proc)
                for line in proc.stdout:
                    log.write(line);log.flush()
                    try: event=json.loads(line)
                    except ValueError: continue
                    with self.lock:
                        if not self.cancelled:
                            self.current.update(stage=event.get('stage','harmony'),progress=round(55+.44*float(event.get('progress',0)),1))
                            for field in ('message','device'):
                                if field in event: self.current[field]=event[field]
                code=proc.wait()
                if self.cancelled: raise InterruptedError()
                if code: raise ValueError(self.current.get('message') or '演奏分析未完成，分轨及旧分析保留。')
            finally:
                if proc.poll() is None:
                    self.stems._terminate(proc)
                    proc.wait(timeout=20)

    def cancel(self):
        with self.lock:
            if self.running:
                self.cancelled=True;self.current['state']='cancelling'
                if self.stems.running: self.stems.cancel()
                if self.proc and self.proc.poll() is None: self.stems._terminate(self.proc)
                try: self.save()
                except OSError: pass
            return self.status()

    def melody_versions(self, rid):
        row = next(iter(self.snapshot(safe_id(rid))), None)
        if not row:
            raise ValueError('歌曲已不在当前曲库中。')
        return self.store.versions(rid,row['source'])

    def review_melody(self, rid, mode):
        # Compatibility for an older renderer: it may still request raw notes.
        # Failed chromatic candidates remain offline research only.
        if mode != 'off':
            raise ValueError('这轮旋律复核未通过试听，已暂停使用。原始分析保留。')
        with self.lock:
            row = next(iter(self.snapshot(safe_id(rid))),None)
            if not row:
                raise ValueError('歌曲已不在当前曲库中。')
            current = self.store.read(rid,row['source'])
            if current['status'] != 'ready':
                raise ValueError('请先准备这首歌的演奏分析。')
            return {**current,'review':{'mode':'off','changed':0}}

    def restore_melody_version(self, rid, digest, expected_digest):
        with self.lock:
            if self.running or self.stems.running:
                raise ValueError('请等待演奏准备完成后再切换版本。')
            row = next(iter(self.snapshot(safe_id(rid))), None)
            if not row or row['source'] == 'unavailable':
                raise ValueError('歌曲暂不可用。')
            self.store.restore_version(rid,row['source'],digest,expected_digest)
            return {'status':'ready'}

    def library(self):
        live = {r['id']:r for r in self.snapshot()}
        rows = {r['id']:r for r in self.stems.library()['rows']}
        for item in self.store.catalog():
            row = live.get(item['id'])
            value = rows.setdefault(item['id'],dict(id=item['id'],title=Path(row['path']).stem if row else '已移出曲库的歌曲',available=bool(row),bytes=0,count=0,updated=item['updated']))
            value['analysis'] = True;value['bytes'] += item['bytes'];value['updated']=max(value['updated'],item['updated'])
        return {'rows':sorted(rows.values(),key=lambda r:r['updated'],reverse=True)}

    def delete(self, rid):
        with self.lock:
            rid=safe_id(rid)
            if self.running and self.current['id']==rid: raise ValueError('请先取消这首歌的演奏准备。')
            if any(r['id']==rid for r in self.stems.library()['rows']): self.stems.delete(rid)
            self.store.forget(rid)
            return {'ok':True}

    def close(self):
        self.cancel()
