"""Worker-only audio decoding helpers; module import itself stays lightweight."""
from contextlib import contextmanager
from pathlib import Path
import os,shutil,subprocess,tempfile,time
from resource_runtime import asset_path

def stop_process_tree(proc):
    if proc is None or proc.poll() is not None:return
    if os.name=='nt':
        subprocess.run(['taskkill','/PID',str(proc.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                       creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=8)
    else:proc.terminate()
    try:proc.wait(timeout=3)
    except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=3)

def decoder():
    root=Path(os.environ.get('KUMIKO_APP_HOME') or Path(__file__).resolve().parent)
    for path in (asset_path(root,'models/audio-tools/ffmpeg.exe'),asset_path(root,'models/stem-separation/ffmpeg.exe'),asset_path(root,'data/components/ffmpeg/ffmpeg.exe'),root/'ffmpeg/bin/ffmpeg.exe'):
        if path.is_file():return str(path)
    return shutil.which('ffmpeg')

@contextmanager
def open_audio(path,workdir,checkpoint=lambda:None,force_decoder=False,duration=None):
    """Probe MP3 tails before expensive inference; retain the normal decoded samples."""
    import soundfile as sf
    audio=None
    if not force_decoder:
        try:
            audio=sf.SoundFile(path)
            if audio.format=='MP3':
                audio.seek(max(0,len(audio)-audio.samplerate*10))
                audio.read(dtype='float32',always_2d=True)
                audio.seek(0)
        except (RuntimeError,OSError):
            if audio:audio.close()
            audio=None
    if audio is not None:
        try:yield audio
        finally:audio.close()
        return
    executable=decoder()
    if not executable:raise ValueError('音频解码失败，请准备兼容音频解码组件后重试。')
    workdir=Path(workdir);workdir.mkdir(parents=True,exist_ok=True)
    handle,name=tempfile.mkstemp(prefix='decode-',suffix='.wav',dir=workdir);os.close(handle);dest=Path(name)
    proc=None
    try:
        checkpoint()
        with tempfile.TemporaryFile() as errors:
            proc=subprocess.Popen([executable,'-nostdin','-hide_banner','-v','error','-threads','2','-i',str(path),
                '-map','0:a:0','-vn',*(['-t',str(duration)] if duration else []),'-c:a','pcm_f32le','-f','wav','-y',str(dest)],stdout=subprocess.DEVNULL,stderr=errors,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            started=time.monotonic()
            while proc.poll() is None:
                checkpoint()
                if time.monotonic()-started>180:raise ValueError('音频兼容解码超时，已有结果保留。')
                time.sleep(.1)
            checkpoint()
            if proc.returncode:raise ValueError('音频兼容解码失败，已有结果保留。')
        with sf.SoundFile(dest) as converted:yield converted
    finally:
        if proc and proc.poll() is None:stop_process_tree(proc)
        dest.unlink(missing_ok=True)

def read_audio(path,workdir,checkpoint=lambda:None,max_duration=600):
    import soundfile as sf
    def read(force):
        with open_audio(path,workdir,checkpoint,force) as audio:
            if not 5<len(audio)/audio.samplerate<=max_duration:raise ValueError('段落分析当前支持5秒至10分钟的完整歌曲，未截短处理。')
            return audio.read(dtype='float32',always_2d=True),audio.samplerate
    try:return read(False)
    except (sf.LibsndfileError,OSError):return read(True)
