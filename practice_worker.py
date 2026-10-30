"""Managed GPU practice inference. Invoked only by the unified preparation task."""
import os
for key in ('OMP_NUM_THREADS','MKL_NUM_THREADS','OPENBLAS_NUM_THREADS','NUMBA_NUM_THREADS'):
    os.environ[key] = '2'
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
from pathlib import Path
import gc
import hashlib
import json
import subprocess
import sys

def emit(**value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    job = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    assets, output = Path(job['assets']), Path(job['output'])
    manifest = json.loads((assets / 'manifest.json').read_text(encoding='utf-8'))
    if sys.version_info[:2] != tuple(manifest['python']):
        raise ValueError('当前演奏分析组件与Python版本不匹配。')
    for folder in reversed(manifest['runtime']):
        sys.path.insert(0, str(assets / folder))
    os.environ['HF_MODULES_CACHE'] = str(output / 'hf-modules')
    from stem_store import fingerprint
    from music_analysis_store import source_version
    from practice_analysis import validate
    from practice_melody_evidence import capture_game, evidence_chunk, analysis_digest, validate_evidence
    row = job['row']; source = Path(row['path'])
    digest = fingerprint(source)
    if source_version(source) != row['source']:
        raise ValueError('歌曲已变化。')
    emit(stage='checking', progress=1)
    for item in manifest['files']:
        file = (assets / item['path']).resolve()
        if not file.is_relative_to(assets.resolve()) or not file.is_file() or file.stat().st_size != item['bytes'] or fingerprint(file) != item['sha256']:
            raise ValueError('演奏分析组件校验失败，请重新准备组件。')
    encoder = Path(job['encoder']['path'])
    if fingerprint(encoder) != job['encoder']['sha256']:
        raise ValueError('音频读取组件校验失败。')
    import numpy as np
    import soundfile as sf
    import torch
    torch.set_num_threads(2); torch.set_num_interop_threads(1)
    reuse = job.get('reuse_analysis')
    minimum_mib = 3000 if reuse is not None else 3800
    if not torch.cuda.is_available() or torch.cuda.mem_get_info()[0] < minimum_mib * 1024**2:
        raise ValueError('演奏分析需要空闲显卡与足够显存，不会自动切换高负载CPU。')
    decoded = output / 'original.wav'
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    try:
        if reuse is not None:
            validate(reuse)
            if reuse.get('provenance', {}).get('source_sha256') != digest:
                raise ValueError('原分析与当前歌曲不一致，请重新准备。')
            duration = reuse['duration']
            beats, chords, keys = reuse['beats'], reuse['chords'], reuse['keys']
        else:
            decode = subprocess.run([str(encoder), '-nostdin', '-v', 'error', '-threads', '2', '-y', '-i', str(source), '-map', '0:a:0', '-t', '600.1', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', str(decoded)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
            if decode.returncode:
                sys.stderr.write(decode.stderr.decode(errors='replace'))
                raise ValueError('音频读取未完成，原有结果保留。')
            waveform, rate = sf.read(decoded, dtype='float32', always_2d=True)
            if len(waveform) / rate > 600 or not np.isfinite(waveform).all():
                raise ValueError('当前演奏分析支持10分钟内的完整歌曲，分轨和旧结果保留。')
            from transformers import AutoModel
            emit(stage='harmony', progress=5, device=torch.cuda.get_device_name())
            model = AutoModel.from_pretrained(str(assets / 'sheetsage2'), base_model_path=str(assets / 'mert2'), local_files_only=True, trust_remote_code=True, attn_implementation='sdpa', torch_dtype=torch.float32).eval().to('cuda')
            result = model.transcribe(waveform.T, sampling_rate=rate, output_dir=str(output / 'sheet'), preset='default',
                                     prompts=('timestamp','downbeat_meter','key','chord_full','melody_full'),
                                     progress=lambda p: emit(stage='harmony', progress=20) if p.get('stage')=='window' else None)
            if any(w['tokens'] >= model.max_output_seq_len for w in result['windows']):
                raise ValueError('乐谱分析超过生成上限，旧结果保留。')
            labs = result['labs']; duration = result['duration_seconds']
            def rows(name):
                return [line.split('\t') for line in labs.get(name,'').splitlines() if line.strip()]
            beats = [[float(a),int(b),int(c),int(d)] for a,b,c,d in rows('beat')]
            chords = [[float(a),float(b),c] for a,b,c in rows('chord')]
            keys = [[float(a),float(b),c] for a,b,c in rows('key')]
            del model, waveform, result
            gc.collect(); torch.cuda.empty_cache()
        emit(stage='melody', progress=65)
        sys.path.insert(0, str(assets / 'game-source'))
        from lib.config.io import load_raw_config
        from lib.config.schema import ModelConfig, InferenceConfig, ValidationConfig
        from inference.me_infer import SegmentationEstimationInferenceModel
        from inference.slicer2 import Slicer
        config = load_raw_config(assets / 'game-model/config.yaml', inherit=False)
        mc = ModelConfig.model_validate(config['model'], scope=0); ic = InferenceConfig.model_validate(config['inference'], scope=0)
        mc.check(scope_mask=0); ic.check(scope_mask=0)
        model = SegmentationEstimationInferenceModel(mc,ic)
        checkpoint = torch.load(assets / 'game-model/model.pt', map_location='cpu', weights_only=True)
        state = checkpoint.get('state_dict',{}); state.update(checkpoint.get('ema_state_dict') or {})
        model.load_state_dict(state, strict=True); model.eval().to('cuda')
        del checkpoint, state
        import librosa
        sr = model.inference_config.features.audio_sample_rate
        audio, _ = librosa.load(job['vocals'], sr=sr, mono=True)
        if abs(len(audio)/sr-duration) > .1 or not np.isfinite(audio).all():
            raise ValueError('人声与原曲时间轴不一致。')
        chunks = Slicer(sr=sr, threshold=-40., min_length=1000, min_interval=200, max_sil_kept=100).slice(audio)
        vc = ValidationConfig(d3pm_sample_t0=0.,d3pm_sample_steps=8,boundary_decoding_threshold=.2,boundary_decoding_radius=round(.02/model.timestep),note_presence_threshold=.2)
        torch.manual_seed(1729); torch.cuda.manual_seed_all(1729)
        language = job.get('melody_language', 'unspecified')
        languages = json.loads((assets / 'game-model/lang_map.json').read_text(encoding='utf-8'))
        if language != 'unspecified' and language not in languages:
            raise ValueError('当前模型不支持所选演唱语言。')
        language_id = 0 if language == 'unspecified' else languages[language]
        notes = []; evidence_chunks = []
        for index, chunk in enumerate(chunks):
            wave = torch.from_numpy(chunk['waveform']).float()[None].to('cuda'); length = wave.shape[1]/sr; offset = float(chunk['offset'])
            with torch.inference_mode(), capture_game(model) as captured:
                ds, vs, ps = model(waveform=wave,known_durations=torch.tensor([[length]],device='cuda'),language=torch.tensor([language_id],device='cuda'),t=torch.tensor(vc.d3pm_sample_ts_resolved,device='cuda'),boundary_threshold=torch.tensor(vc.boundary_decoding_threshold,device='cuda'),boundary_radius=torch.tensor(vc.boundary_decoding_radius,device='cuda'),score_threshold=torch.tensor(vc.note_presence_threshold,device='cuda'))
            ds,vs,ps = ds[0].cpu().numpy(),vs[0].cpu().numpy(),ps[0].cpu().numpy()
            if not np.isfinite(ds).all() or not np.isfinite(ps).all():
                raise ValueError('旋律输出存在无效数值。')
            evidence_chunks.append(evidence_chunk(captured,ds,vs,ps,offset,length,model.timestep))
            starts = np.minimum(np.r_[0,np.cumsum(ds)[:-1]],length)+offset
            ends = np.minimum(np.cumsum(ds),length)+offset
            notes.extend([[float(a),min(float(b),duration),float(p),1.] for a,b,p,v in zip(starts,ends,ps,vs) if v and min(b,duration)>a])
            emit(stage='melody', progress=65+30*(index+1)/max(1,len(chunks)))
        payload = dict(schema=1,duration=duration,beats=beats,chords=chords,keys=keys,notes=notes,
                       quality='experimental',melody_role='vocal',warning='分析参考：调性、拍点和旋律可能有误，五线谱仍需核对。',
                       provenance=dict(recipe=manifest['recipe'],source_sha256=digest,component_manifest_sha256=fingerprint(assets/'manifest.json'),vocal_sha256=fingerprint(Path(job['vocals'])),vocal_input=job['vocal_input'],language=language,melody_recipe='game-medium-evidence-v1',seed=1729,steps=8,boundary_threshold=.2,note_presence_threshold=.2))
        if reuse is not None:
            payload['provenance']['previous_analysis_sha256'] = analysis_digest(reuse)
            payload['provenance']['rhythm_provenance'] = reuse.get('provenance', {}).get('rhythm_provenance', reuse.get('provenance', {}))
        payload['melody_evidence'] = dict(schema=1, frame_pitch=False, boundary=True, pitch_candidates=True)
        validate(payload)
        evidence = dict(schema=1, analysis_sha256=analysis_digest(payload), chunks=evidence_chunks,
                        **{key:payload['provenance'][key] for key in ('source_sha256','vocal_sha256','component_manifest_sha256')})
        validate_evidence(evidence,payload)
        if source_version(source) != row['source'] or fingerprint(source) != digest:
            raise ValueError('处理期间歌曲已变化，结果未采用。')
        (output/'result.json').write_text(json.dumps(payload,ensure_ascii=False,allow_nan=False),encoding='utf-8')
        (output/'melody-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,allow_nan=False),encoding='utf-8')
        emit(stage='analysis_saved',progress=100)
    finally:
        decoded.unlink(missing_ok=True)

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        emit(stage='failed',message=str(exc))
        raise
