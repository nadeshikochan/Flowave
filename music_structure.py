"""Lightweight structure contract and persistence. Safe in the resident API."""
import hashlib,json,math,time
from pathlib import Path
from music_analysis_store import AnalysisStore

LABELS={'intro':'前奏','verse':'主歌','pre-chorus':'预副歌','chorus':'副歌',
        'bridge':'桥段','inst':'器乐段','outro':'尾奏','silence':'静默区间'}
RECIPE_ID='songformer-validation-2bf16'
MAX_DURATION=600
_availability_cache={}
_recipe_cache={}

def component_path(root):return Path(root)/'data/components/music-structure'

def recipe_version(root):
    root=Path(root)
    paths=[root/name for name in ('music_structure.py','analysis_audio.py','music_structure_engine.py','music_structure_worker.py')]+[component_path(root)/'manifest.json']
    signature=tuple((p.stat().st_size,p.stat().st_mtime_ns) for p in paths)
    cached=_recipe_cache.get(str(root))
    if cached and cached[0]==signature:return cached[1]
    digest=hashlib.sha256(RECIPE_ID.encode())
    for path in paths:digest.update(path.read_bytes())
    result=digest.hexdigest();_recipe_cache[str(root)]=(signature,result)
    return result

def availability(root):
    component=component_path(root)
    try:
        stat=(component/'manifest.json').stat();key=(str(component),stat.st_mtime_ns,stat.st_size)
        cached=_availability_cache.get(key)
        if cached and time.monotonic()-cached[0]<10:return dict(cached[1])
        manifest=json.loads((component/'manifest.json').read_text(encoding='utf-8'))
        if manifest.get('recipe')!=RECIPE_ID:raise ValueError()
        for row in manifest['files']:
            path=Path(root)/row['file']
            if not path.is_file() or path.stat().st_size!=row['bytes']:raise ValueError()
        if not manifest['files']:raise ValueError()
        result={'available':True,'message':'','max_duration':MAX_DURATION}
        _availability_cache.clear();_availability_cache[key]=(time.monotonic(),result)
        return dict(result)
    except (OSError,ValueError,KeyError,TypeError):
        return {'available':False,'message':'段落分析组件尚未准备完整，请先准备可选分析组件。','max_duration':MAX_DURATION}

def validate_payload(payload):
    if payload.get('schema')!=1 or payload.get('model')!='SongFormer' or payload.get('input')!='audio':
        raise ValueError('段落结果格式不受支持。')
    duration=payload.get('duration')
    if isinstance(duration,bool) or not isinstance(duration,(float,int)) or not math.isfinite(duration) or not 5<duration<=MAX_DURATION:
        raise ValueError('段落结果时长无效。')
    segments=payload.get('segments')
    if not isinstance(segments,list) or not 0<len(segments)<=2000:raise ValueError('段落结果为空或过多。')
    previous=0.
    for segment in segments:
        if not isinstance(segment,dict) or segment.get('label') not in LABELS:raise ValueError('段落名称无效。')
        start,end=segment.get('start'),segment.get('end')
        if any(isinstance(t,bool) or not isinstance(t,(int,float)) or not math.isfinite(t) for t in (start,end)):
            raise ValueError('段落时间无效。')
        if abs(start-previous)>1e-5 or not start<end<=duration:raise ValueError('段落时间不连续或超过歌曲范围。')
        previous=end
    if duration-previous>.13:raise ValueError('段落结果未覆盖整首歌曲。')
    # Only the supported, bounded presentation contract crosses into the API.
    return {'schema':1,'model':'SongFormer','input':'audio','duration':float(duration),
            'segments_count':len(segments),'segments':[{'start':float(s['start']),'end':float(s['end']),'label':s['label']} for s in segments]}

class StructureStore(AnalysisStore):
    def project(self,payload):return dict(payload)
    def summary(self,payload):return {k:payload[k] for k in ('duration','segments_count','model')}
    def publish(self,rid,source,recipe,payload,vectors=None):
        super().publish(rid,source,recipe,validate_payload(payload),None)
