"""SongFormer audio-only engine, isolated to an explicit GPU worker.

Adapted from ASLP-lab/SongFormer (CC BY 4.0), https://github.com/ASLP-lab/SongFormer.
The parity-checked rotary SDPA adapter and BF16 recipe match the accepted validation.
No fixture names, lyrics, user annotations, network access or evaluation-cache imports.
"""
from pathlib import Path
import gc,json,math,sys,types
ROOT=Path(__file__).resolve().parent
COMPONENT=ROOT/'data/components/music-structure'
sys.path[:0]=[str(COMPONENT/'runtime'),str(COMPONENT/'upstream'),str(COMPONENT/'shared')]
import numpy as np
import soundfile as sf
import torch
from torch.nn import functional as F
from scipy.signal import resample_poly
from safetensors.torch import load_file
from music_structure import validate_payload,MAX_DURATION
from analysis_audio import read_audio


def emit(**data):print(json.dumps(data,ensure_ascii=False,allow_nan=False),flush=True)

def waveform(row,workdir=None,checkpoint=lambda:None):
    audio,sr=read_audio(row['path'],workdir or ROOT/'data/cache/analysis-audio',checkpoint,MAX_DURATION)
    g=math.gcd(sr,24000)
    wave=resample_poly(audio.mean(1),24000//g,sr//g).astype(np.float32)
    if not 5<len(wave)/24000<=MAX_DURATION:
        raise ValueError('段落分析当前支持5秒至10分钟的完整歌曲，未截短处理。')
    return torch.from_numpy(wave).unsqueeze(0)

def sdpa_forward(self,hidden_states,attention_mask=None,relative_position_embeddings=None,output_attentions=False):
    if hasattr(self,'structure_checkpoint'):self.structure_checkpoint()
    if self.training or output_attentions:
        raise ValueError('Adapter restricted to eval without attention outputs')
    if self.position_embeddings_type!='rotary' or relative_position_embeddings is None:
        raise ValueError('Only verified rotary attention supported')
    b,t,_=hidden_states.shape
    qk=self._apply_rotary_embedding(hidden_states,relative_position_embeddings)
    q=self.linear_q(qk).view(b,t,self.num_heads,self.head_size).transpose(1,2)
    k=self.linear_k(qk).view(b,t,self.num_heads,self.head_size).transpose(1,2)
    v=self.linear_v(hidden_states).view(b,t,self.num_heads,self.head_size).transpose(1,2)
    value=F.scaled_dot_product_attention(q,k,v,attn_mask=attention_mask,dropout_p=0.,is_causal=False)
    value=value.transpose(1,2).reshape(b,t,self.num_heads*self.head_size)
    return self.linear_out(value),None

def precise_forward(self,hidden_states,attention_mask=None,relative_position_embeddings=None,output_attentions=False):
    """Original FP32 attention formula, chunking queries only; all keys remain visible."""
    if self.training or output_attentions or self.position_embeddings_type!='rotary':raise ValueError('Unsupported attention mode')
    b,t,_=hidden_states.shape
    qk=self._apply_rotary_embedding(hidden_states,relative_position_embeddings)
    q=self.linear_q(qk).view(b,t,self.num_heads,self.head_size).transpose(1,2)
    k=self.linear_k(qk).view(b,t,self.num_heads,self.head_size).transpose(1,2)
    v=self.linear_v(hidden_states).view(b,t,self.num_heads,self.head_size).transpose(1,2)
    output=torch.empty_like(q)
    for start in range(0,t,128):
        if hasattr(self,'structure_checkpoint'):self.structure_checkpoint()
        scores=torch.matmul(q[:,:,start:start+128],k.transpose(-2,-1))/math.sqrt(self.head_size)
        if attention_mask is not None:scores=scores+(attention_mask if attention_mask.shape[-2]==1 else attention_mask[...,start:start+128,:])
        output[:,:,start:start+128]=torch.matmul(torch.softmax(scores,dim=-1),v)
    return self.linear_out(output.transpose(1,2).reshape(b,t,-1)),None

def attention_patch(model,mode='sdpa'):
    count=0
    for module in model.modules():
        if type(module).__name__=='Wav2Vec2ConformerSelfAttention':
            if not hasattr(module,'structure_original_forward'):module.structure_original_forward=module.forward
            module.forward=module.structure_original_forward if mode=='original' else types.MethodType(precise_forward if mode=='precise' else sdpa_forward,module)
            count+=1
    if count!=12:
        raise ValueError('Unexpected encoder attention layout')
    return count

def features(model,kind,x,checkpoint=lambda:None,chunk_frames=1024):
    # Same official frontend/normalization/conv/conformer; omit unused final
    # 8192-way pretraining classifier, which has no effect on hidden states.
    core=model.model if kind=='muq' else model
    spec=core.preprocessing(x,features=['melspec_2048'])
    spec=core.normalize(spec)
    mel=spec['melspec_2048'];length=mel.shape[-1]
    if not chunk_frames or length<=chunk_frames:hidden=core.conv(mel)
    else:
        # Two residual stride-2 layers: stride 4, receptive field 19 frames.
        # 16-frame aligned halo exceeds the radius 9; only redundant edges are cut.
        blocks=[]
        for start in range(0,length,chunk_frames):
            checkpoint();end=min(start+chunk_frames,length)
            left=max(0,start-16);right=min(length,end+16)
            block=core.conv(mel[...,left:right])
            offset=(start-left)//4;count=(end+3)//4-start//4
            blocks.append(block[:,offset:offset+count])
        hidden=torch.cat(blocks,dim=1)
    return core.conformer(hidden,output_hidden_states=True).hidden_states[10]

def parity(model,kind,sample):
    model.eval().to('cuda')
    attention_patch(model,'original')
    x=sample[:,:5*24000].to('cuda')
    with torch.inference_mode():
        reference=features(model,kind,x).float()
        attention_patch(model)
        adapted=features(model,kind,x).float()
        with torch.autocast('cuda',dtype=torch.bfloat16):
            mixed=features(model,kind,x).float()
    if not all(torch.isfinite(v).all().item() for v in (reference,adapted,mixed)):
        raise ValueError('Non-finite encoder parity output; reject cache/inference')
    absolute=float((reference-adapted).abs().max())
    cosine=float(F.cosine_similarity(reference.flatten(),mixed.flatten(),dim=0))
    relative=float(torch.linalg.vector_norm(reference-mixed)/torch.linalg.vector_norm(reference))
    fp32_relative=float(torch.linalg.vector_norm(reference-adapted)/torch.linalg.vector_norm(reference))
    result={'kind':kind,'seconds':5,'sdpa_fp32_max_abs':absolute,
            'bf16_cosine':cosine,'bf16_relative_l2':relative,'sdpa_fp32_relative_l2':fp32_relative,'layers':12}
    emit(stage='parity',**result)
    # Large feature magnitudes make an absolute-only gate scale dependent.
    # Retain a hard absolute ceiling and require tight FP32 relative agreement.
    if absolute>1e-2 or fp32_relative>1e-4 or cosine<.999 or relative>.03:
        attention_patch(model,'precise')
        with torch.inference_mode():precise=features(model,kind,x).float()
        if not torch.isfinite(precise).all():raise ValueError('模型精度检查失败，旧结果已保留。')
        error=float(torch.linalg.vector_norm(reference-precise)/torch.linalg.vector_norm(reference))
        if not math.isfinite(error) or error>1e-4:raise ValueError('模型精度检查失败，旧结果已保留。')
        result.update(precision='fp32',attention='original-query-blocks',fallback_relative_l2=error)
    else:result.update(precision='bf16',attention='sdpa')
    emit(stage='precision_mode',kind=kind,**{k:v for k,v in result.items() if k!='kind'})
    del x,reference,adapted,mixed
    return result

def encoder_model(kind):
    if kind=='muq':
        from muq import MuQ
        config=json.loads((ROOT/'models/MuQ-large-msd-iter/config.json').read_text(encoding='utf-8'))
        model=MuQ(config)
        state=load_file(str(ROOT/'models/MuQ-large-msd-iter/model.safetensors'))
    else:
        from transformers import Wav2Vec2ConformerConfig
        # Author constructor requests an HF config. Supply the exact cached
        # config locally without changing architecture or allowing networking.
        from unittest.mock import patch
        config=Wav2Vec2ConformerConfig.from_pretrained(str(COMPONENT/'wav2vec-config'),local_files_only=True)
        from musicfm.model.musicfm_25hz import MusicFM25Hz
        with patch.object(Wav2Vec2ConformerConfig,'from_pretrained',return_value=config):
            model=MusicFM25Hz(is_flash=False,stat_path=str(COMPONENT/'upstream/msd_stats.json'))
        package=torch.load(COMPONENT/'models/pretrained_msd.pt',map_location='cpu',weights_only=True)
        state={k.removeprefix('model.'):v for k,v in package['state_dict'].items()}
    model.load_state_dict(state,strict=True)
    del state
    return model.eval()

def rule_postprocessing(segments):
    # Upstream logic, unchanged (including its <1s and same-label end rules).
    result=list(segments)
    while len(result)>2 and result[1][0]-result[0][0]<1:
        result=[(result[0][0],result[1][1])]+result[2:]
    while len(result)>2 and result[-1][0]-result[-2][0]<1:
        result=result[:-2]+[result[-1]]
    while len(result)>2 and result[0][1]==result[1][1] and result[1][0]<=10:
        result=[(result[0][0],result[0][1])]+result[2:]
    while len(result)>2 and result[-2][1]==result[-3][1] and result[-1][0]-result[-2][0]<=10:
        result=result[:-2]+[result[-1]]
    return result


class ModelPool:
    """One disk load per model per job; one encoder on GPU, bounded feature batches."""
    def __init__(self,workdir):
        self.workdir=Path(workdir);self.models={};self.active=None;self.loads={};self.uploads={}
    def activate(self,kind):
        if self.active!=kind:
            if kind not in self.models:
                if kind=='head':
                    from model import Model
                    from model_config import ModelConfig
                    model=Model(ModelConfig()).eval()
                    state=load_file(str(COMPONENT/'models/SongFormer.safetensors'))
                    model.load_state_dict({k.removeprefix('ema_model.'):v for k,v in state.items() if k.startswith('ema_model.')},strict=True)
                    del state
                else:model=encoder_model(kind)
                self.models[kind]=model;self.loads[kind]=self.loads.get(kind,0)+1
                emit(stage='model_loaded',kind=kind,disk_loads=self.loads[kind])
            model=self.models[kind]
            if next(model.parameters()).device.type!='cuda':
                needed=sum(t.numel()*t.element_size() for t in list(model.parameters())+list(model.buffers()))
                reserve=1536*1024**2
                def free():return torch.cuda.mem_get_info()[0]+max(0,torch.cuda.memory_reserved()-torch.cuda.memory_allocated())
                for other,cached in self.models.items():
                    if free()>=needed+reserve:break
                    if other!=kind and next(cached.parameters()).device.type=='cuda':
                        cached.cpu();gc.collect();torch.cuda.empty_cache()
                model.to('cuda');self.uploads[kind]=self.uploads.get(kind,0)+1
                emit(stage='model_residency',kind=kind,gpu_uploads=self.uploads[kind])
            self.active=kind
        return self.models[kind]
    def encode(self,model,kind,wave,checkpoint,progress):
        duration=wave.shape[1]/24000
        for module in model.modules():
            if type(module).__name__=='Wav2Vec2ConformerSelfAttention':module.structure_checkpoint=checkpoint
        precision=parity(model,kind,wave)
        # Global FP32 states grow with song length. Do not spill to Windows shared
        # GPU memory merely to keep inactive weights resident.
        reserve=max(1536*1024**2,int(duration*(6e6 if precision['precision']=='fp32' else 3.5e6)))
        for other,cached in self.models.items():
            free=torch.cuda.mem_get_info()[0]+max(0,torch.cuda.memory_reserved()-torch.cuda.memory_allocated())
            if free>=reserve:break
            if other!=kind and next(cached.parameters()).device.type=='cuda':
                cached.cpu();gc.collect();torch.cuda.empty_cache()
                emit(stage='model_evicted',kind=other,reason='long-song-working-memory')
        if precision['precision']=='fp32':progress('precision-fallback',0,duration)
        with torch.inference_mode(),torch.autocast('cuda',dtype=torch.bfloat16,enabled=precision['precision']=='bf16'):
            full=features(model,kind,wave.to('cuda'),checkpoint).float().cpu().numpy()
            checkpoint();progress(kind,duration,duration)
            chunks=[]
            for start in range(0,wave.shape[1],30*24000):
                checkpoint();part=wave[:,start:start+30*24000]
                if part.shape[-1]<=1024:continue
                chunks.append(features(model,kind,part.to('cuda'),checkpoint).float().cpu().numpy())
                progress(kind+'-local',min(start/24000+30,duration),duration)
            short=np.concatenate(chunks,axis=1)
        if not np.isfinite(full).all() or not np.isfinite(short).all():raise ValueError('模型未能得到有效结果。')
        return short,full
    def infer(self,arrays,duration):
        from dataset.label2id import DATASET_ID_ALLOWED_LABEL_IDS
        allowed=DATASET_ID_ALLOWED_LABEL_IDS[5];model=self.activate('head')
        mask=torch.ones((1,1,128),dtype=torch.bool,device='cuda');mask[:,:,allowed]=False
        values=[arrays['musicfm'][0],arrays['muq'][0],arrays['musicfm'][1],arrays['muq'][1]]
        lengths=[v.shape[1] for v in values]
        if max(lengths)-min(lengths)>4:raise ValueError('模型特征时间未能对齐。')
        embedding=torch.from_numpy(np.concatenate([v[:,:min(lengths)] for v in values],axis=-1)).to('cuda')
        with torch.inference_mode():segments,logits=model.infer(embedding,torch.tensor([5],device='cuda'),mask,with_logits=True)
        if not torch.isfinite(logits['boundary_logits']).all() or not torch.isfinite(logits['function_logits'][:,:,allowed]).all():
            raise ValueError('模型未能得到有效结果。')
        segments=rule_postprocessing(segments)
        return validate_payload({'schema':1,'model':'SongFormer','input':'audio','duration':duration,
            'segments':[{'start':s[0],'end':min(segments[i+1][0],duration),'label':s[1]} for i,s in enumerate(segments[:-1])]})
    def process(self,rows,checkpoint,progress,failed):
        waves={};encoded={}
        for row in rows:
            checkpoint()
            try:
                wave=waveform(row,self.workdir,checkpoint)
                if not torch.isfinite(wave).all():raise ValueError('音频含有无效采样值。')
                waves[row['id']]=wave;encoded[row['id']]={}
            except InterruptedError:raise
            except Exception as exc:failed(row,exc)
        for kind in ('muq','musicfm'):
            if not waves:break
            checkpoint();model=self.activate(kind)
            for row in rows:
                rid=row['id']
                if rid not in waves:continue
                checkpoint();duration=waves[rid].shape[1]/24000
                progress(row,kind,0,duration)
                try:encoded[rid][kind]=self.encode(model,kind,waves[rid],checkpoint,lambda phase,end,total:progress(row,phase,end,total))
                except InterruptedError:raise
                except Exception as exc:
                    if isinstance(exc,torch.OutOfMemoryError):raise
                    failed(row,exc);waves.pop(rid,None);encoded.pop(rid,None)
        for row in rows:
            rid=row['id']
            if rid not in waves:continue
            checkpoint();duration=waves.pop(rid).shape[1]/24000
            progress(row,'structure',0,duration)
            try:result=self.infer(encoded.pop(rid),duration)
            except InterruptedError:raise
            except Exception as exc:
                if isinstance(exc,torch.OutOfMemoryError):raise
                failed(row,exc);continue
            yield row,result
    def close(self):
        self.models.clear();self.active=None;gc.collect();torch.cuda.empty_cache()


def analyze(path,checkpoint,progress):
    pool=ModelPool(ROOT/'data/cache/analysis-audio')
    errors=[]
    try:
        rows=[{'id':'single','path':str(path)}]
        for _,result in pool.process(rows,checkpoint,lambda row,phase,end,total:progress(phase,end,total),lambda row,exc:errors.append(exc)):
            return result
        raise errors[0] if errors else ValueError('模型未生成段落。')
    finally:pool.close()
