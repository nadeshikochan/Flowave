"""Explicit, cancellable background inference. Never imported by the resident API."""
import os
for key in ('OMP_NUM_THREADS','MKL_NUM_THREADS','OPENBLAS_NUM_THREADS','NUMEXPR_NUM_THREADS'):os.environ[key]='2'
os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1';os.environ['TOKENIZERS_PARALLELISM']='false'
import sys,json,math,time,hashlib,traceback
if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8',errors='replace')
from pathlib import Path
ROOT=Path(os.environ.get('KUMIKO_APP_HOME') or Path(__file__).resolve().parent)
from resource_runtime import asset_path
# Dedicated optional component survives ordinary cache cleanup. No startup download.
sys.path.insert(0,str(asset_path(ROOT,'data/components/music-analysis/python')))

def emit(**value):print(json.dumps(value,ensure_ascii=False),flush=True)

def main(jobfile):
    import numpy as np
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly
    from analysis_features import patches
    from analysis_vocab import MOODS,top_tags
    from music_analysis_store import source_version
    import onnxruntime as ort
    from analysis_audio import open_audio
    jobfile=Path(jobfile);job=json.loads(jobfile.read_text(encoding='utf-8'));out=jobfile.parent
    def cancelled():return (out/'cancel').exists()
    def wait():
        while (out/'pause').exists() and not cancelled():time.sleep(.2)
        if cancelled():raise InterruptedError()
    torch.set_num_threads(2);torch.set_num_interop_threads(1)
    if not torch.cuda.is_available():raise RuntimeError('显卡分析环境不可用，请检查音乐分析组件；没有切换到CPU。')
    device=torch.cuda.get_device_name();emit(stage='loading',device=device)
    models=Path(job['models']);ess=models/'Essentia-tagging'
    for file in json.loads((ess/'download-manifest.json').read_text(encoding='utf-8')):
        p=ess/file['file']
        if p.stat().st_size!=file['bytes'] or hashlib.sha256(p.read_bytes()).hexdigest()!=file['sha256']:raise RuntimeError('标签模型校验失败，请重新准备分析组件。')
    options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
    options.add_session_config_entry('session.intra_op.allow_spinning','0')
    def session(p):return ort.InferenceSession(str(p),sess_options=options,providers=['CPUExecutionProvider'])
    base=session(ess/'discogs-effnet-bsdynamic-1.onnx');heads={}
    for kind in ('genre','instrument','theme'):
        name=f'mtg_jamendo_{"moodtheme" if kind=="theme" else kind}-discogs-effnet-1'
        heads[kind]=(session(ess/(name+'.onnx')),json.loads((ess/(name+'.json')).read_text())['classes'])
    from muq import MuQMuLan
    config=json.loads((models/'MuQ-MuLan-large/config.json').read_text())
    config['audio_model']['name']=str(models/'MuQ-large-msd-iter');config['text_model']['name']=str(models/'xlm-roberta-base')
    mu=MuQMuLan(config);weights=torch.load(models/'MuQ-MuLan-large/pytorch_model.bin',map_location='cpu',weights_only=True)
    mu.load_state_dict(weights,strict=True);del weights
    mu=mu.eval().to('cuda',dtype=torch.float32)
    texts=[text for _,_,cn,en in MOODS for text in [*cn,*en]]
    with torch.inference_mode():
        te=torch.cat([mu(texts=texts[i:i+4]) for i in range(0,len(texts),4)])
        te=torch.nn.functional.normalize(te,dim=-1)
    for done,row in enumerate(job['rows']):
        wait();rid=row['id'];path=Path(row['path'])
        try:
            if source_version(path)!=row['source']:raise ValueError('歌曲在处理前发生变化，请重新处理。')
            vectors=[];segments=[];audio_tail=None
            with open_audio(path,out,wait) as audio:
                sr=audio.samplerate;duration=len(audio)/sr
                if duration<2.1:raise ValueError('音频不足约2秒，暂不分析。')
                def windows():
                    nonlocal audio_tail
                    pos=0
                    while True:
                        wave=audio.read(10*sr,dtype='float32',always_2d=True).mean(axis=1)
                        if not len(wave):break
                        real=len(wave)/sr
                        if real<10:
                            if audio_tail is not None:wave=np.r_[audio_tail,wave][-10*sr:];start=max(0,duration-10)
                            else:start=0
                        else:start=pos
                        audio_tail=wave;pos+=real
                        g=math.gcd(sr,24000);wave=resample_poly(wave,24000//g,sr//g).astype(np.float32)
                        if len(wave)<240000:wave=np.pad(wave,(0,240000-len(wave)))
                        yield start,min(duration,start+10),wave[:240000]
                        if real<10:break
                for start,end,wave in windows():
                    wait()
                    if not np.isfinite(wave).all():raise ValueError('音频含有无效采样值。')
                    rms=float(np.sqrt(np.mean(wave*wave)));silent=rms<1e-5
                    vals={}
                    if not silent:
                        outs=base.run(None,{base.get_inputs()[0].name:patches(wave)})
                        embedding=next(x for x in outs if x.shape[-1]==1280)
                        for kind,(head,classes) in heads.items():
                            pred=head.run(['activations'],{head.get_inputs()[0].name:embedding})[0].mean(0)
                            if not np.isfinite(pred).all():raise ValueError('模型未能得到有效结果。')
                            vals[kind]={key:float(v) for key,v in zip(classes,pred)}
                        with torch.inference_mode():
                            emb=torch.nn.functional.normalize(mu(wavs=torch.from_numpy(wave).unsqueeze(0).to('cuda')),dim=-1)
                            scores=(emb@te.T).cpu().numpy().reshape(8,4).mean(1)
                        if not np.isfinite(scores).all():raise ValueError('模型未能得到有效结果。')
                        vectors.append(emb.cpu().numpy()[0]);vals['mood']={key:float(v) for (key,*_),v in zip(MOODS,scores)}
                        intensity=float(scores[1]-scores[0])
                    else:
                        vectors.append(np.zeros(512,dtype=np.float32));vals={k:{} for k in ('instrument','genre','mood','theme')};intensity=None
                    segments.append({'start':start,'end':end,'silent':silent,'intensity':intensity,'scores':vals,
                                     'tags':{k:top_tags(k,v,5 if k=='instrument' else 3) for k,v in vals.items()}})
                    emit(stage='analyzing',device=device,done=done,total=len(job['rows']),segment_end=end,segment_total=duration,id=rid)
            if not segments:raise ValueError('没有可分析的音频。')
            centers=np.array([(s['start']+s['end'])/2 for s in segments]);edges=np.r_[0,(centers[:-1]+centers[1:])/2,duration]
            totals={k:{} for k in ('instrument','genre','mood','theme')};weight=0
            for i,s in enumerate(segments):
                s['from']=float(edges[i]);s['to']=float(edges[i+1]);w=s['to']-s['from']
                if s['silent']:continue
                weight+=w
                for kind,values in s['scores'].items():
                    for key,value in values.items():totals[kind][key]=totals[kind].get(key,0)+value*w
            if not weight:raise ValueError('音频主要为静音，未生成标签。')
            tags={k:top_tags(k,{key:v/weight for key,v in values.items()},5 if k=='instrument' else 3) for k,values in totals.items()}
            payload={'duration':duration,'segments_count':len(segments),'tags':tags,'segments':segments,
                     'energy_status':'estimated','energy_note':'听感强弱估计；积蓄与爆发阶段尚未自动确认。','device':device,'schema':1}
            if source_version(path)!=row['source']:raise ValueError('歌曲在处理期间发生变化，旧结果已保留。')
            dest=out/(rid+'.json');tmp=dest.with_suffix('.tmp');tmp.write_text(json.dumps(payload,ensure_ascii=False,allow_nan=False),encoding='utf-8');tmp.replace(dest)
            np.save(out/(rid+'.npy'),np.array(vectors,dtype=np.float32),allow_pickle=False)
            emit(stage='result',id=rid,done=done+1,total=len(job['rows']),device=device)
        except InterruptedError:raise
        except Exception as exc:
            if 'outofmemory' in type(exc).__name__.lower() or 'out of memory' in str(exc).lower():raise
            traceback.print_exception(type(exc),exc,exc.__traceback__,file=sys.stderr)
            message=str(exc) if str(exc).startswith(('歌曲','音频','没有可分析','模型未能')) else '这首音频暂时无法分析，请检查文件是否完整。'
            emit(stage='failed',id=rid,done=done+1,total=len(job['rows']),message=message[:300],device=device)
    return 0

if __name__=='__main__':
    try:raise SystemExit(main(sys.argv[1]))
    except InterruptedError:raise SystemExit(2)
    except Exception as exc:
        if isinstance(exc,ModuleNotFoundError):message='音乐分析组件缺少运行依赖，请先准备完整组件。'
        elif 'outofmemory' in type(exc).__name__.lower() or 'out of memory' in str(exc).lower():message='显卡显存不足，请关闭其他占用显卡的任务后重试。'
        elif str(exc).startswith(('显卡分析环境不可用','标签模型校验失败')):message=str(exc)
        else:message='音乐分析组件未能正常运行，请检查组件和模型是否完整。'
        emit(stage='fatal',message=message);raise SystemExit(1)
