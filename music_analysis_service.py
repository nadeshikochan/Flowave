"""Resident lightweight coordinator: explicit jobs, restart recovery and atomic publication."""
import json,os,sqlite3,subprocess,sys,threading,time,uuid
from pathlib import Path
from music_analysis_store import AnalysisStore,source_version,recipe_version
from music_structure import StructureStore,recipe_version as structure_recipe,availability as structure_availability
from analysis_audio import stop_process_tree
from resource_runtime import asset_path, runtime_python, worker_command, worker_environment

class MusicAnalysisService:
    def __init__(self,root,data,snapshot):
        self.root=Path(root);self.data=Path(data);self.snapshot=snapshot
        self.store=AnalysisStore(self.data/'library/track-analysis/results.sqlite3')
        self.structure_store=StructureStore(self.data/'library/track-analysis/structure.sqlite3')
        self.lock=threading.RLock();self.running=False;self.proc=None;self.folder=None;self.state=None
    def _previous(self):
        tags=self.store.task()
        try:structure=self.structure_store.task()
        except (sqlite3.DatabaseError,OSError,ValueError):structure={'state':'idle'}
        return max((tags,structure),key=lambda t:t.get('started',0))
    def _store(self,target):return self.structure_store if target=='structure' else self.store
    def _recipe(self,target):return structure_recipe(self.root) if target=='structure' else recipe_version(self.root)
    def check_resources(self,target='tags'):
        python=runtime_python(self.root,'analysis')
        for name in (() if target=='structure' else ('Essentia-tagging/discogs-effnet-bsdynamic-1.onnx','MuQ-MuLan-large/pytorch_model.bin','MuQ-large-msd-iter/model.safetensors','xlm-roberta-base/model.safetensors')):
            if not asset_path(self.root,'models/'+name).is_file():raise ValueError('推荐与标签计算资源不完整，请在插件与模型中完成安装。')
        return python
    def pending_for(self, resource_ids, target='tags'):
        """Read-only dependency check; never starts or resumes model work."""
        with self.lock:
            state=self.state or {}
            return bool(self.running and state.get('target','tags')==target
                and set(resource_ids).intersection(state.get('pending',[])))
    def status(self):
        with self.lock:
            state=dict(self.state or self._previous())
            if not self.running and state.get('state') in ('running','paused','cancelling'):
                state['state']='interrupted';state['message']='上次处理已中断，可以继续未完成歌曲。'
            if not self.running and state.get('state')=='completed':
                if state.get('pending') or state.get('done',0)<state.get('total',0):
                    state['state']='interrupted';state['message']='上次处理未全部完成，可以继续未完成歌曲。'
                elif state.get('failed',0):
                    state['state']='failed';state['message']='部分歌曲分析失败，已保存成功结果，可以重试失败歌曲。'
            return {**{k:v for k,v in state.items() if k not in ('pending',)},'remaining':len(state.get('pending',[]))}
    def _save(self):self._store(self.state.get('target','tags')).task(self.state)
    def catalog(self):
        current=self.snapshot();stored=self.store.catalog();result=[]
        capability=structure_availability(self.root)
        structure_error=False
        try:structures=self.structure_store.catalog()
        except (sqlite3.DatabaseError,OSError,ValueError):
            structure_error=True;structures={};capability={**capability,'available':False,'message':'段落数据库暂时无法读取，原有数据保留。'}
        try:sr=structure_recipe(self.root)
        except OSError:sr='unavailable'
        try:recipe=recipe_version(self.root)
        except OSError:recipe='unavailable'
        tag_recipes=self.store.accepted_recipes(recipe,root=self.root)
        try:structure_recipes=self.structure_store.accepted_recipes(sr,root=self.root,target='structure')
        except (sqlite3.DatabaseError,OSError,ValueError):structure_recipes={sr}
        for row in current:
            saved=stored.get(row['id']);valid=bool(saved and saved['source']==row['source'] and saved['recipe'] in tag_recipes)
            structure=structures.get(row['id']);structure_valid=bool(structure and structure['source']==row['source'] and structure['recipe'] in structure_recipes and capability['available'])
            result.append({'id':row['id'],'path':row['path'],'status':'ready' if valid else 'outdated' if saved else 'missing',
                           'tags':saved['tags'] if saved else {},'updated':saved.get('updated') if saved else None,
                           'structure_status':'unavailable' if structure_error else 'ready' if structure_valid else 'outdated' if structure else 'missing'})
        return {'rows':result,'task':self.status(),'storage':'音乐分析数据库','recipe':recipe,'structure':capability}
    def track(self,rid):
        row=next(iter(self.snapshot(rid)),None)
        if row is None:raise ValueError('歌曲不在当前音乐库中。')
        result=self.store.get(rid)
        try:structure=self.structure_store.get(rid)
        except (sqlite3.DatabaseError,OSError,ValueError):
            structure={'status':'unavailable','segments':[],'message':'段落数据暂时无法读取，原有数据保留。'}
        if structure and structure.get('status')!='unavailable':
            try:valid_structure=structure['source']==row['source'] and structure['recipe'] in self.structure_store.accepted_recipes(structure_recipe(self.root),root=self.root,target='structure')
            except OSError:valid_structure=False
            structure={**structure,'status':'ready' if valid_structure else 'outdated'}
        if not result:return {'status':'missing','id':rid,'structure':structure}
        try:valid=result['source']==row['source'] and result['recipe'] in self.store.accepted_recipes(recipe_version(self.root),root=self.root)
        except OSError:valid=False
        return {'status':'ready' if valid else 'outdated','id':rid,**result,'structure':structure}
    def start(self,mode,ids,target='tags',*,allow_empty=False):
        with self.lock:
            if self.running:raise ValueError('已有音乐处理任务，请等待完成或先取消。')
            if mode not in ('all','missing','selected','resume','retry'):raise ValueError('不支持的音乐处理操作。')
            previous=self.state or self._previous()
            if mode in ('resume','retry'):target=previous.get('target','tags')
            if target not in ('tags','structure'):raise ValueError('不支持的音乐处理类型。')
            if target=='structure':
                capability=structure_availability(self.root)
                if not capability['available']:raise ValueError(capability['message'])
            if target=='tags':self.store.preserve_recipe_compatibility(self.root)
            recipe=self._recipe(target);current=self.snapshot();stored=self._store(target).catalog()
            if mode=='resume':ids=previous.get('pending',[])
            if mode=='retry':ids=[r['id'] for r in previous.get('failures',[])]
            wanted=set(ids)
            label='段落' if target=='structure' else '标签'
            if mode in ('selected','resume','retry') and not wanted:
                raise ValueError('请先选择歌曲。' if mode=='selected' else f'上次{label}任务没有未完成歌曲。' if mode=='resume' else f'上次{label}任务没有失败歌曲。')
            rows=[r for r in current if (mode in ('all','missing') or r['id'] in wanted)]
            if mode=='missing':
                accepted=self._store(target).accepted_recipes(recipe,root=self.root,target=target)
                rows=[r for r in rows if not (stored.get(r['id'],{}).get('source')==r['source'] and stored.get(r['id'],{}).get('recipe') in accepted)]
            if not rows:
                if allow_empty and mode=='missing' and current:
                    return {'state':'completed','target':target,'total':0,'done':0,'success':0,'failed':0,'reused':len(current),'skipped':True}
                raise ValueError(f'当前曲库的{label}均已有有效结果，无需补充处理。' if mode=='missing' and current else '待处理歌曲已不在当前曲库，请重新读取曲库。' if wanted else '当前曲库没有歌曲。')
            # Continuing pending work must not discard failures from the same task.
            row_ids={r['id'] for r in rows};current_ids={r['id'] for r in current}
            carried_failures={f['id']:f for f in previous.get('failures',[])
                              if f.get('id') in current_ids and f['id'] not in row_ids} if mode=='resume' else {}
            python=self.check_resources(target)
            self.folder=self.data/'cache/analysis-jobs'/uuid.uuid4().hex;self.folder.mkdir(parents=True)
            manifest={'rows':rows,'models':str(asset_path(self.root,'models/MuQ-MuLan-large').parent),'recipe':recipe,'target':target}
            (self.folder/'job.json').write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf-8')
            self.state={'state':'running','stage':'preparing','total':len(rows)+len(carried_failures),'done':len(carried_failures),'success':0,'failed':len(carried_failures),'failures':list(carried_failures.values()),
                        'reused':len(current)-len(rows) if mode=='missing' else 0,
                        'pending':[r['id'] for r in rows],'started':time.time(),'finished':None,'device':'正在确认','message':'','target':target}
            self._save();self.running=True
            threading.Thread(target=self._run,args=(python,manifest,self.folder),daemon=True).start()
            return self.status()
    def control(self,action):
        with self.lock:
            if not self.running:raise ValueError('当前没有正在处理的任务。')
            marker=self.folder/('cancel' if action=='cancel' else 'pause')
            if action=='resume':marker.unlink(missing_ok=True);self.state['state']='running'
            else:marker.touch();self.state['state']='cancelling' if action=='cancel' else 'paused'
            self._save()
            if action=='cancel':threading.Thread(target=self._cancel_later,args=(self.folder,),daemon=True).start()
            return self.status()
    def _cancel_later(self,folder):
        time.sleep(2)
        with self.lock:
            proc=self.proc if self.running and self.folder==folder else None
        if proc and proc.poll() is None:stop_process_tree(proc)
    def _run(self,python,manifest,folder):
        failed_fatal=False
        try:
            flags=(getattr(subprocess,'CREATE_NO_WINDOW',0)|getattr(subprocess,'BELOW_NORMAL_PRIORITY_CLASS',0)) if os.name=='nt' else 0
            env=worker_environment(self.root);env['KUMIKO_DATA_DIR']=str(self.data)
            with (folder/'worker.log').open('w',encoding='utf-8') as log:
                script='music_structure_worker.py' if manifest['target']=='structure' else 'music_analysis_worker.py'
                proc=subprocess.Popen(worker_command(self.root,'analysis',script,folder/'job.json'),cwd=str(self.root),env=env,
                                      stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf-8',errors='replace',creationflags=flags)
                with self.lock:self.proc=proc
                byid={r['id']:r for r in manifest['rows']}
                for line in proc.stdout:
                    log.write(line);log.flush()
                    try:event=json.loads(line)
                    except ValueError:continue
                    if not isinstance(event,dict):continue
                    with self.lock:
                        stage=event.get('stage');rid=event.get('id')
                        if stage not in ('loading','analyzing','result','failed','fatal'):continue
                        if stage in ('result','failed') and (rid not in byid or rid not in self.state['pending']):continue
                        if stage in ('result','failed') and self.state['state']=='cancelling':continue
                        self.state['stage']=stage
                        if rid:self.state['current_id']=rid
                        if event.get('device'):self.state['device']=event['device']
                        if event.get('phase'):self.state['phase']=event['phase']
                        for k in ('segment_end','segment_total'):self.state[k]=event.get(k,0)
                        if stage=='result' and self.state['state']!='cancelling':
                            row=byid[rid];now=next(iter(self.snapshot(rid)),None)
                            if now and now['source']==row['source'] and now['path']==row['path'] and now.get('scope')==row.get('scope') and source_version(row['path'])==row['source']:
                                payload=json.loads((folder/(rid+'.json')).read_text(encoding='utf-8'))
                                if self._recipe(manifest['target'])!=manifest['recipe']:raise ValueError('分析组件在处理期间变化。')
                                vectors=None if manifest['target']=='structure' else (folder/(rid+'.npy')).read_bytes()
                                self._store(manifest['target']).publish(rid,row['source'],manifest['recipe'],payload,vectors)
                                self.state['success']+=1
                                # Staged duplicates are ours; the committed DB now owns the result.
                                for suffix in ('.json','.npy'):
                                    try:(folder/(rid+suffix)).unlink()
                                    except OSError:pass
                            else:stage='failed';event['message']='曲库或歌曲已变化，旧结果已保留。'
                        if stage=='failed':
                            self.state['failed']+=1;self.state['failures'].append({'id':rid,'message':event.get('message','这首歌曲暂时无法处理。'),'code':event.get('code','analysis')})
                        if stage in ('result','failed'):
                            self.state['pending']=[x for x in self.state['pending'] if x!=rid];self.state['done']+=1
                        if stage=='fatal':failed_fatal=True;self.state['message']=event.get('message','分析组件无法继续处理，请检查组件是否完整。')
                        self._save()
                code=proc.wait()
                with self.lock:
                    self.state['state']='cancelled' if (folder/'cancel').exists() else 'failed' if code or failed_fatal or self.state['pending'] or self.state['done']!=self.state['total'] or self.state['failed'] else 'completed'
                    if self.state['state']=='failed' and not self.state['message']:self.state['message']='处理意外中断，已保存完成的结果，可以继续。'
                    if self.state['state']=='failed' and not self.state['pending'] and self.state['failed'] and not (code or failed_fatal):
                        self.state['message']='部分歌曲分析失败，已保存成功结果，可以重试失败歌曲。'
        except Exception:
            with self.lock:self.state['state']='failed';self.state['message']='音乐处理未能完成，已有结果保留，可以继续。'
        finally:
            with self.lock:
                if self.proc and self.proc.poll() is None:stop_process_tree(self.proc)
                for temporary in folder.glob('decode-*.wav'):
                    try:temporary.unlink()
                    except OSError:pass
                self.proc=None;self.running=False;self.state['finished']=time.time();self._save()
                if self.state.get('success'):
                    try:self._store(self.state.get('target','tags')).backup()
                    except Exception:self.state['message']='结果已保存，备份暂时未完成。';self._save()
    def close(self):
        with self.lock:
            if self.running:
                (self.folder/'cancel').touch()
                if self.proc and self.proc.poll() is None:stop_process_tree(self.proc)
