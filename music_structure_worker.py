"""Explicit structure job process; the resident service never imports inference."""
import os
for key in ('OMP_NUM_THREADS','MKL_NUM_THREADS','OPENBLAS_NUM_THREADS','NUMEXPR_NUM_THREADS'):os.environ[key]='2'
os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
import hashlib,json,sys,time,traceback
from pathlib import Path
ROOT=Path(__file__).resolve().parent
if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8',errors='replace')
def emit(**event):print(json.dumps(event,ensure_ascii=False,allow_nan=False),flush=True)

def same_source(row):
    from music_analysis_store import source_version
    try:return source_version(row['path'])==row['source']
    except OSError:return False

def main(jobfile):
    from music_structure import availability,component_path,recipe_version
    from music_analysis_store import source_version
    jobfile=Path(jobfile);job=json.loads(jobfile.read_text(encoding='utf-8'));out=jobfile.parent
    def checkpoint():
        while (out/'pause').exists() and not (out/'cancel').exists():time.sleep(.2)
        if (out/'cancel').exists():raise InterruptedError()
    checkpoint()
    ready=availability(ROOT)
    if not ready['available']:raise ValueError(ready['message'])
    if job['recipe']!=recipe_version(ROOT):raise ValueError('段落分析组件已变化，请重新开始任务。')
    emit(stage='loading',phase='checking',device='正在确认')
    manifest=json.loads((component_path(ROOT)/'manifest.json').read_text(encoding='utf-8'))
    for file in manifest['files']:
        checkpoint();path=ROOT/file['file']
        with path.open('rb') as handle:digest=hashlib.file_digest(handle,'sha256').hexdigest()
        if digest!=file['sha256']:raise ValueError('段落分析组件校验失败，请重新准备组件。')
    from music_structure_engine import ModelPool
    import torch
    import soundfile as sf
    torch.set_num_threads(2);torch.set_num_interop_threads(1);torch.backends.cudnn.benchmark=False
    if not torch.cuda.is_available():raise ValueError('显卡分析环境不可用，没有切换到CPU。')
    device=torch.cuda.get_device_name()
    if not torch.cuda.is_bf16_supported():raise ValueError('当前显卡不支持段落分析所需的计算精度。')
    if torch.cuda.mem_get_info()[0]<2000*1024**2:raise ValueError('显卡显存不足，请等待其他显卡任务完成。')
    def batches():
        batch=[];duration=0
        for row in job['rows']:
            checkpoint()
            try:seconds=sf.info(row['path']).duration
            except (RuntimeError,OSError):seconds=600
            # Four feature streams at 25Hz: ~400KiB per audio second.
            # <=600s total per batch bounds feature memory near 240MiB.
            if batch and (len(batch)>=4 or duration+seconds>600):yield batch;batch=[];duration=0
            batch.append(row);duration+=seconds
        if batch:yield batch
    def failed(row,exc):
        traceback.print_exception(type(exc),exc,exc.__traceback__,file=sys.stderr)
        message=str(exc) if isinstance(exc,ValueError) and str(exc).startswith(('歌曲','段落','音频','模型')) else '这首歌曲的段落暂时无法分析，已有结果保留。'
        code='unsupported_duration' if '完整歌曲' in message else 'decode' if '解码' in message else 'precision' if '精度' in message else 'analysis'
        emit(stage='failed',id=row['id'],message=message[:300],code=code,device=device)
    def progress(row,phase,end,total):
        emit(stage='analyzing',id=row['id'],phase=phase,device=device,segment_end=end,segment_total=total)
    torch.cuda.reset_peak_memory_stats()
    pool=ModelPool(out)
    try:
        for batch in batches():
            valid=[]
            for row in batch:
                if not same_source(row):failed(row,ValueError('歌曲在处理前发生变化或无法读取，旧结果已保留。'))
                else:valid.append(row)
            for row,result in pool.process(valid,checkpoint,progress,failed):
                checkpoint();rid=row['id']
                if not same_source(row):
                    failed(row,ValueError('歌曲在处理期间发生变化或无法读取，旧结果已保留。'));continue
                dest=out/(rid+'.json');tmp=dest.with_suffix('.tmp')
                tmp.write_text(json.dumps(result,ensure_ascii=False,allow_nan=False),encoding='utf-8');tmp.replace(dest)
                emit(stage='result',id=rid,device=device)
    finally:
        emit(stage='runtime_summary',disk_loads=pool.loads,gpu_uploads=pool.uploads,peak_gpu_bytes=torch.cuda.max_memory_allocated())
        pool.close()
    return 0

if __name__=='__main__':
    try:raise SystemExit(main(sys.argv[1]))
    except InterruptedError:raise SystemExit(2)
    except Exception as exc:
        if 'outofmemory' in type(exc).__name__.lower() or 'out of memory' in str(exc).lower():message='显卡显存不足，请关闭其他显卡任务后重试。'
        elif isinstance(exc,ValueError):message=str(exc)[:300]
        else:message='段落分析组件未能运行，请检查组件与显卡环境。'
        emit(stage='fatal',message=message);raise SystemExit(1)
