"""Bounded, lossless PCM pages of existing stems. No model or persistent output."""
import math
import subprocess
import threading
from pathlib import Path

from analysis_audio import decoder
from stem_store import fingerprint

PAGE_SECONDS = 20
_decoders = threading.BoundedSemaphore(2)


def playback_decoder(service):
    try:
        folder, manifest, _ = service.assets()
    except ValueError:
        return decoder()
    encoder = manifest.get('encoder', {})
    name = encoder.get('name', '')
    if not name or Path(name).name != name:
        raise ValueError('音频解码组件配置无效。')
    path = folder / name
    try:
        stat = path.stat()
        key = (str(path), stat.st_size, stat.st_mtime_ns, encoder.get('sha256'))
        with service.lock:
            verified = service.verified_files.get(key)
        if verified is None:
            verified = fingerprint(path) == encoder.get('sha256')
            with service.lock:
                service.verified_files[key] = verified
        if not verified:
            raise ValueError('音频解码组件校验失败。')
        return str(path)
    except OSError as exc:
        raise ValueError('音频解码组件缺失或无法读取。') from exc


def read_page(service, rid, generation, name, page, sample_rate):
    if page < 0 or not 8000 <= sample_rate <= 192000:
        raise ValueError('音轨分段参数无效。')
    path = service.media(rid, generation, name)
    saved = service.store.get(rid)
    if not saved or saved['generation'] != generation:
        raise ValueError('分轨已更新，请重新载入。')
    duration = saved['samples'] / saved['sample_rate']
    start = page * PAGE_SECONDS
    if start >= duration:
        raise ValueError('音轨分段超出歌曲范围。')
    executable = playback_decoder(service)
    if not executable:
        raise ValueError('长曲伴奏需要音频解码组件，请准备 FFmpeg 后重试。')
    frames = min(PAGE_SECONDS * sample_rate, math.ceil(duration * sample_rate) - start * sample_rate)
    # Decode one second of context before the requested page so resampler state
    # has settled at its boundary; do not restart a filter on the audible seam.
    seek = max(0, start - 1)
    skip = (start - seek) * sample_rate
    if not _decoders.acquire(timeout=15):
        raise ValueError('音轨读取繁忙，请稍后重试。')
    try:
        result = subprocess.run([
            executable, '-nostdin', '-hide_banner', '-v', 'error', '-threads', '1',
            '-ss', str(seek), '-i', str(path), '-map', '0:a:0', '-vn',
            '-af', f'aresample={sample_rate},atrim=start_sample={skip}:end_sample={skip + frames},asetpts=PTS-STARTPTS',
            '-t', str(PAGE_SECONDS), '-ac', '2', '-ar', str(sample_rate),
            '-threads', '1', '-filter_threads', '1', '-f', 'f32le', 'pipe:1',
        ], capture_output=True, timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode or len(result.stdout) % 8 or abs(len(result.stdout) // 8 - frames) > 2:
            raise ValueError('分轨分段读取失败，已保存的音轨保留。')
        # Resampling may round the final frame differently by one sample.
        return result.stdout[:frames * 8].ljust(frames * 8, b'\0')
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError('分轨读取失败或超时，已保存的音轨保留。') from exc
    finally:
        _decoders.release()
