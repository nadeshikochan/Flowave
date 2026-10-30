"""GPU separation plus gapless Opus export. Only launched for an explicit job."""
import os
for _key in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS'):
    os.environ[_key] = '2'
from pathlib import Path
import gc
import hashlib
import json
import math
import subprocess
import sys
import time
from stem_store import fingerprint


def emit(**event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    job = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    assets = Path(job['assets'])
    output = Path(job['output'])
    model = job['model']
    runtime = assets / job['runtime']['directory']
    sys.path.insert(0, str(runtime))
    import numpy as np
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly
    from pymss import MSSeparator
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    if not torch.cuda.is_available():
        raise ValueError('未检测到可用显卡，不会自动改用高负载CPU分离。')
    if torch.cuda.mem_get_info()[0] < 2300 * 1024**2:
        raise ValueError('当前空闲显存不足，请关闭其他显卡任务后重试。')
    torch.cuda.reset_peak_memory_stats()
    for field in ('weights', 'config'):
        if fingerprint(assets / model[field]['name']) != model[field]['sha256']:
            raise ValueError('分轨模型校验失败，请重新准备组件。')
    encoder = assets / job['encoder']['name']
    if fingerprint(encoder) != job['encoder']['sha256']:
        raise ValueError('音频编码组件校验失败。')
    source = Path(job['row']['path'])
    source_hash = fingerprint(source)
    from music_analysis_store import source_version
    if source_version(source) != job['row']['source']:
        raise ValueError('歌曲已变化，请重新开始分离。')
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0
    def run(args):
        result = subprocess.run([str(encoder), '-nostdin', '-v', 'error', '-threads', '2', *args], creationflags=flags,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise ValueError('音频编码或解码失败，请查看本次分轨日志。')
        return result.stdout
    emit(stage='decoding', progress=1, device=torch.cuda.get_device_name())
    decoded = output / 'input.wav'
    run(['-y', '-i', str(source), '-t', '1201', '-map', '0:a:0', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', str(decoded)])
    mix, sr = sf.read(decoded, dtype='float32', always_2d=True)
    if sr != 44100 or mix.shape[1] != 2 or not np.isfinite(mix).all():
        raise ValueError('歌曲解码结果无效。')
    # Bound decoded frontend memory before producing multiple full-song stems.
    duration = len(mix) / sr
    if duration > 1200:
        raise ValueError('当前版本支持20分钟以内的歌曲分离，原曲仍可正常播放。')
    last = [0.0]
    def progress(done, total, message):
        if time.monotonic() - last[0] > 1 or done >= total:
            emit(stage='separating', progress=round(5 + 72 * done / max(1, total), 1))
            last[0] = time.monotonic()
    emit(stage='loading', progress=3)
    separator = MSSeparator(model_type=model['kind'], model_path=str(assets / model['weights']['name']),
                            config_path=str(assets / model['config']['name']), device='cuda', use_tta=False,
                            store_dirs=str(output), progress_callback=progress,
                            inference_params={'batch_size': 1, 'normalize': False})
    torch.backends.cudnn.benchmark = False
    tick = time.perf_counter()
    signals = separator.separate(mix.T, pbar=False)
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - tick
    signals = {str(k).lower(): v for k, v in signals.items()}
    if set(signals) != set(model['stems']):
        raise ValueError('模型输出的音轨种类与配置不一致。')
    for name, signal in signals.items():
        if signal.shape != mix.shape or not np.isfinite(signal).all():
            raise ValueError('音轨长度、通道或数值无效：' + name)
    # One gain for the entire family, including the summed reference; preserve balance.
    peak = max(float(np.max(np.abs(v))) for v in signals.values())
    summed = sum(signals.values())
    peak = max(peak, float(np.max(np.abs(summed))))
    gain = min(1.0, .88 / max(peak, 1e-8))
    del summed, separator
    gc.collect()
    torch.cuda.empty_cache()
    if job.get('keep_analysis_input'):
        # Private intermediate for the next stage; never part of persistent playback media.
        sf.write(output / 'practice-vocals.wav', signals['vocals'] * gain, 44100, subtype='FLOAT')
    stems = {}
    samples48 = round(len(mix) * 48000 / 44100)
    for index, name in enumerate(model['stems']):
        emit(stage='encoding', progress=round(78 + 19 * index / len(signals), 1))
        temporary = output / (name + '.wav')
        sf.write(temporary, signals[name] * gain, 44100, subtype='FLOAT')
        target = output / (name + '.opus')
        run(['-y', '-i', str(temporary), '-ar', '48000', '-ac', '2', '-c:a', 'libopus', '-b:a', '160k',
             '-vbr', 'on', '-application', 'audio', '-frame_duration', '20', str(target)])
        # Decode the actual container to validate pre-skip/end trimming and finite samples.
        check = output / (name + '.check.f32')
        run(['-y', '-i', str(target), '-ar', '48000', '-ac', '2', '-f', 'f32le', str(check)])
        count = check.stat().st_size // 8
        if abs(count - samples48) > 1:
            raise ValueError('编码后的音轨时长不一致，未发布结果。')
        values = np.memmap(check, dtype='<f4', mode='r')
        if not np.isfinite(values).all():
            raise ValueError('编码后的音轨包含无效采样。')
        del values
        check.unlink()
        temporary.unlink()
        stems[name] = {'bytes': target.stat().st_size, 'sha256': fingerprint(target), 'samples': count}
    decoded.unlink()
    if source_version(source) != job['row']['source'] or fingerprint(source) != source_hash:
        raise ValueError('分离期间歌曲已变化，本次结果未采用。')
    manifest = {'id': job['row']['id'], 'title': source.stem, 'generation': job['generation'], 'source': job['row']['source'],
                'source_sha256': source_hash, 'recipe': model['recipe'], 'model_label': model['label'],
                'model_weights_sha256': model['weights']['sha256'], 'model_config_sha256': model['config']['sha256'],
                'sample_rate': 48000, 'channels': 2, 'samples': min(s['samples'] for s in stems.values()),
                'duration': duration, 'common_gain': gain, 'codec': 'opus', 'bitrate': 160000,
                'stems': stems, 'separation_seconds': round(elapsed, 2),
                'peak_allocated_MB': round(torch.cuda.max_memory_allocated() / 1e6, 1), 'updated': time.time()}
    partial = output / 'manifest.partial.json'
    partial.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    partial.replace(output / 'manifest.json')
    emit(stage='saved', progress=100)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        emit(stage='failed', message=str(exc))
        raise
