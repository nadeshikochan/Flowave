from pathlib import Path
import copy
import json
import os
import time
import re
import threading
from typing import Callable, Dict, List, Optional, Tuple
import torchaudio.transforms as T
import torch
from transformers import AutoModel, Wav2Vec2FeatureExtractor
from runtime_paths import APP_CONFIG_PATH, APP_HOME, DOWNLOAD_DIR, LIBRARY_DIR, MODEL_DIR
from resource_runtime import asset_path
from index_progress import report_progress

# ------------ 常量与模型 -------------
PROJECT_ROOT = Path(__file__).resolve().parent
AUDIO_DIR = None
INDEX_PATH = LIBRARY_DIR / "music_index.pt"
CONFIG_PATH = APP_CONFIG_PATH
MODEL_ID = "m-a-p/MERT-v1-330M"
LOCAL_MODEL_DIR = asset_path(APP_HOME,'models/MERT-v1-330M')
MODEL_CONFIG_DEFAULT = {
    "source": MODEL_ID,
    "local_dir": "models/MERT-v1-330M",
}
MAX_SECONDS = 120
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
MODEL_DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32

DEFAULT_CONFIG = {
    "audio_dir": "",
    "download_dir": str(DOWNLOAD_DIR),
    "similarity": {"like_min": 0.98, "like_max": 0.99, "fallback_top_n": 10},
    "dislike": {"min_sim": 0.85, "max_sim": 0.93},
    "dislike_correction": {
        "enabled": True,
        "enable_recommend_rate_fix": True,
        "rec_strength": 1.0,
        "rec_fix_min": 0.1,
        "rec_fix_max": 20.0,
        "auto_rebuild_recommend_rate": True,
        "enable_skip_rate_fix": True,
        "skip_strength": 1.0,
        "skip_fix_min": 0.33,
        "skip_fix_max": 2.0,
        "skip_smooth_k": 20,
        "daily_decay": 0.98,
        "consecutive_dislike_threshold": 0,
        "long_pause_reset_minutes": 10,
    },
    "history": {
        "allow_duplicates": False,
        "repeat_policy": "disallow",
        "no_repeat_within": 100,
    },
    "index": {"per_file_timeout": 30},  # 单曲索引超时秒数，防止个别文件卡死
    "model": MODEL_CONFIG_DEFAULT.copy(),
    "seed": {"tau": 30, "tau_pos": 20, "tau_neg": 5, "lambda_neg": 0.5},
    "online": {
        "auto_index_enabled": True,
        "auto_index_after_seconds": 60,
        "default_quality": "320k",
        "exclude_tokens": [],
    },
}

def _resolve_project_path(raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    return path if path.is_absolute() else APP_HOME / path


def _resolve_model_source() -> str:
    # 1) 显式环境变量优先（建议用于离线部署）
    env_dir = str(os.getenv("MERT_MODEL_DIR", "")).strip()
    if env_dir:
        env_path = _resolve_project_path(env_dir)
        if not env_path.exists():
            raise FileNotFoundError(f"MERT_MODEL_DIR 不存在: {env_dir}")
        return str(env_path.resolve())
    # 2) config.json 中配置的本地目录
    model_cfg = _read_model_config()
    local_dir = str(model_cfg.get("local_dir", "")).strip()
    if local_dir:
        local_path = asset_path(APP_HOME,local_dir) if local_dir.replace('\\','/')=='models/MERT-v1-330M' else _resolve_project_path(local_dir)
        if not local_path.exists():
            raise FileNotFoundError(f"config.model.local_dir 不存在: {local_dir}")
        return str(local_path.resolve())
    # 3) 仓库约定的本地目录
    if LOCAL_MODEL_DIR.exists():
        return str(LOCAL_MODEL_DIR.resolve())
    # 4) 回退到 HuggingFace Hub ID
    source = str(model_cfg.get("source", "")).strip() or MODEL_ID
    return source


def _read_model_config() -> Dict[str, str]:
    """只读取 config.json 中与模型加载相关的字段，避免在模块早期依赖 load_config()。"""
    cfg = dict(MODEL_CONFIG_DEFAULT)
    if not CONFIG_PATH.exists():
        return cfg
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return cfg
    model_cfg = raw.get("model") or {}
    if isinstance(model_cfg, dict):
        cfg.update({k: str(v) for k, v in model_cfg.items() if v is not None})
    return cfg


def _load_model_and_processor():
    if os.environ.get("KUMIKO_REQUIRE_CUDA") == "1" and DEVICE != "cuda":
        raise RuntimeError("显卡计算环境不可用，请检查显卡驱动与推荐组件；已停止任务，保留旧索引。")
    report_progress(stage="model")
    source = _resolve_model_source()
    local_only = Path(source).exists()
    total_t0 = time.perf_counter()
    print(f"[startup:model] begin load source={source} local_only={local_only}")

    # 无本地模型时，给出国内网络更可用的默认镜像与更长超时
    if not local_only:
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
        os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")

    try:
        model_t0 = time.perf_counter()
        mdl = AutoModel.from_pretrained(
            source,
            trust_remote_code=True,
            torch_dtype=MODEL_DTYPE,
            low_cpu_mem_usage=True,
            local_files_only=local_only,
        ).to(device=DEVICE, dtype=MODEL_DTYPE).eval()
        print(f"[startup:model] model weights loaded in {time.perf_counter() - model_t0:.3f}s")
        proc_t0 = time.perf_counter()
        proc = Wav2Vec2FeatureExtractor.from_pretrained(
            source,
            trust_remote_code=True,
            local_files_only=local_only,
        )
        print(f"[startup:model] processor loaded in {time.perf_counter() - proc_t0:.3f}s")
        print(f"[startup:model] ready in {time.perf_counter() - total_t0:.3f}s")
        return mdl, proc
    except Exception as e:
        hint = (
            "模型加载失败。可选方案：\n"
            "1) 在 config.json 里设置 model.local_dir=你的本地模型目录；\n"
            "2) 或设置环境变量 MERT_MODEL_DIR=你的本地模型目录；\n"
            "3) 或把模型放到仓库约定目录 models/MERT-v1-330M；\n"
            "4) 如果要继续走在线加载，确保可访问 HF_ENDPOINT（默认已尝试 https://hf-mirror.com）。"
        )
        raise RuntimeError(f"{hint}\n原始错误: {e}") from e


def _read_target_sr_from_model_config() -> int:
    default_sr = 24000
    try:
        source_path = Path(_resolve_model_source())
        if not source_path.exists():
            return default_sr
        for filename, key in (("preprocessor_config.json", "sampling_rate"), ("config.json", "sample_rate")):
            cfg_path = source_path / filename
            if not cfg_path.exists():
                continue
            raw = json.loads(cfg_path.read_text(encoding="utf-8"))
            value = int(raw.get(key) or 0)
            if value > 0:
                return value
    except Exception:
        pass
    return default_sr


model = None
processor = None
_model_lock = threading.RLock()
TARGET_SR = _read_target_sr_from_model_config()


def _ensure_model_and_processor():
    global model, processor, TARGET_SR
    if model is not None and processor is not None:
        return model, processor
    with _model_lock:
        if model is None or processor is None:
            model, processor = _load_model_and_processor()
            TARGET_SR = int(getattr(processor, "sampling_rate", TARGET_SR) or TARGET_SR)
    return model, processor


def is_model_loaded() -> bool:
    return model is not None and processor is not None


def release_model() -> bool:
    global model, processor
    with _model_lock:
        if model is None and processor is None:
            return False
        model = None
        processor = None
        if DEVICE == "cuda":
            torch.cuda.empty_cache()
        print("[model] released")
        return True

Index = Dict[str, Tuple[str, torch.Tensor]]

_AUDIO_EXT_RE = re.compile(r"\.(mp3|flac|wav|m4a|ogg|aac|ape|wma)$", re.IGNORECASE)
_BRACKET_QUALITY_RE = re.compile(
    r"[\[\(（【]\s*(?:\d{2,4}\s*(?:k|kbps|khz)|flac(?:\s*24bit)?|hi[-\s]?res|24bit|16bit|hq|sq|lossless|无损)\s*[\]\)）】]$",
    re.IGNORECASE,
)
_TAIL_QUALITY_RE = re.compile(
    r"(?:[-_.\s]+(?:\d{2,4}\s*(?:k|kbps)|flac(?:\s*24bit)?|hi[-\s]?res|24bit|16bit|hq|sq|lossless|无损))+$",
    re.IGNORECASE,
)


def normalize_text_key(s: str) -> str:
    return " ".join(str(s or "").strip().lower().split())


def normalize_title_key(title: str) -> str:
    t = str(title or "").strip()
    if not t:
        return ""
    t = _AUDIO_EXT_RE.sub("", t).strip()
    while True:
        nxt = _BRACKET_QUALITY_RE.sub("", t).strip()
        if nxt == t:
            break
        t = nxt
    t = _TAIL_QUALITY_RE.sub("", t).strip(" -_.")
    t = _AUDIO_EXT_RE.sub("", t).strip()
    return normalize_text_key(t)


def build_artist_title_key(artist: str, title: str) -> str:
    a = normalize_text_key(artist)
    t = normalize_title_key(title)
    if not t:
        return ""
    return f"{a} - {t}".strip()


def normalize_song_key(raw_key: str) -> str:
    text = str(raw_key or "").strip().lower()
    if not text:
        return ""
    artist, sep, title = text.partition(" - ")
    if sep:
        return build_artist_title_key(artist, title)
    return build_artist_title_key("", text)


def list_audio_files(folder: Path) -> List[Path]:
    """递归列出目录下所有常见音频文件路径。"""
    exts = {".wav", ".mp3", ".flac", ".m4a", ".ogg"}
    return [p for p in folder.rglob("*") if p.suffix.lower() in exts]


def _same_path(a: str, b: Path) -> bool:
    try:
        return Path(a).resolve(strict=False) == b.resolve(strict=False)
    except Exception:
        return str(a) == str(b)


def _pick_relocated_path(paths: List[Path], old_path: str) -> Path:
    if len(paths) == 1:
        return paths[0]
    old = Path(str(old_path or ""))
    old_name = old.name.lower()
    if old_name:
        for path in paths:
            if path.name.lower() == old_name:
                return path
    old_stem = normalize_title_key(old.stem)
    if old_stem:
        for path in paths:
            if normalize_title_key(path.stem) == old_stem:
                return path
    return sorted(paths, key=lambda p: str(p).lower())[0]


def relink_index_paths(index: "Index", audio_files: List[Path]) -> Tuple["Index", int]:
    """
    基于当前扫描到的文件列表，把索引中的旧绝对路径重定位到新位置。
    只复用已有 embedding，不做重新计算。
    """
    key_to_paths: Dict[str, List[Path]] = {}
    for path in audio_files:
        song_key = get_song_key(path)
        key_to_paths.setdefault(song_key, []).append(path)

    updated: Index = {}
    relocated = 0
    for song_key, (path_str, emb) in index.items():
        current_paths = key_to_paths.get(song_key) or []
        new_path = str(path_str)
        if current_paths and (not Path(path_str).exists()):
            picked = _pick_relocated_path(current_paths, path_str)
            new_path = str(picked)
        elif current_paths:
            for candidate in current_paths:
                if _same_path(path_str, candidate):
                    new_path = str(candidate)
                    break
        if new_path != str(path_str):
            relocated += 1
        updated[song_key] = (new_path, emb)
    return updated, relocated

def get_song_key(path: Path) -> str:
    """
    用“歌手 + 歌名”作为唯一键：
    - 优先读音频元数据（artist/title）
    - 缺失则用文件名（不含扩展名）
    键统一小写、去首尾空格，尽量避免重复计算。
    """
    artist = ""
    title = ""
    try:
        from mutagen import File as MutagenFile

        mf = MutagenFile(str(path), easy=True)
        if mf:
            arts = mf.get("artist") or mf.get("albumartist")
            if arts:
                artist = str(arts[0])
            titles = mf.get("title")
            if titles:
                title = str(titles[0])
    except Exception:
        pass
    if not title:
        title = path.stem
    return build_artist_title_key(artist, title)

def load_wave(path: Path) -> Tuple[torch.Tensor, int]:
    """
    读音频 -> 单声道 Tensor[time], 返回 (wav, sr)
    优先 soundfile；若格式不支持，再用 pydub+ffmpeg；不再走 torchaudio/torchcodec。
    """
    try:
        import soundfile as sf

        with sf.SoundFile(str(path)) as audio:
            sr = audio.samplerate
            # Retain a short filter margin before the existing post-resample crop.
            data = audio.read(frames=int((MAX_SECONDS + 1) * sr), dtype="float32", always_2d=False)
        if data.ndim == 1:
            data = data[None, :]
        else:
            data = data.T  # [C, T]
        wav = torch.as_tensor(data, dtype=torch.float32)
    except Exception:
        # soundfile 不支持的格式（如某些 mp3），尝试 pydub+ffmpeg
        try:
            from pydub import AudioSegment
            import numpy as np

            audio = AudioSegment.from_file(str(path), duration=MAX_SECONDS + 1)
            sr = audio.frame_rate
            samples = audio.get_array_of_samples()
            arr = np.array(samples).astype("float32")
            # 归一化到 [-1,1]
            max_val = float(1 << (8 * audio.sample_width - 1))
            arr = arr / max_val
            if audio.channels > 1:
                arr = arr.reshape((-1, audio.channels)).T  # [C, T]
            else:
                arr = arr[None, :]
            wav = torch.from_numpy(arr)
        except Exception as e_pd:
            raise RuntimeError(
                "音频读取失败：soundfile 和 pydub 都不支持该格式。请安装 pydub+ffmpeg，或先把文件转成 wav/flac。"
            ) from e_pd
    wav = wav.mean(dim=0)  # mono
    if sr != TARGET_SR:
        wav = T.Resample(sr, TARGET_SR)(wav)
        sr = TARGET_SR
    # 仅保留前 MAX_SECONDS，控制显存/时长
    max_len = int(MAX_SECONDS * sr)
    if wav.shape[0] > max_len:
        wav = wav[:max_len]
    return wav, sr


@torch.inference_mode()
def embed_segment(wav: torch.Tensor, sr: int) -> torch.Tensor:
    """对单个片段做特征提取并时间平均，输出 1024 维 embedding。"""
    with _model_lock:
        mdl, proc = _ensure_model_and_processor()
        report_progress(stage="inference")
        inputs = proc(wav.numpy(), sampling_rate=sr, return_tensors="pt")
        inputs = {k: v.to(DEVICE) for k, v in inputs.items()}
        with torch.amp.autocast("cuda", enabled=(DEVICE == "cuda"), dtype=torch.float16):
            out = mdl(**inputs, output_hidden_states=False)
        emb = out.last_hidden_state.squeeze(0).mean(dim=0)  # [1024]
        return emb.detach().cpu()


def build_index(
    audio_files: List[Path],
    existing: Index,
    *,
    checkpoint_path: Path = INDEX_PATH,
    stats: Dict | None = None,
    key_resolver: Optional[Callable[[Path], str]] = None,
) -> Index:
    """为列表构建/补全嵌入索引；已有则跳过。"""
    index = dict(existing)
    timeout_sec = DEFAULT_CONFIG.get("index", {}).get("per_file_timeout", 30)
    dirty = False
    reused = 0
    attempted = 0
    embedded = 0
    failures = []
    interrupted = False
    try:
        if any(str(key_resolver(path) if key_resolver else get_song_key(path)).strip() not in index for path in audio_files):
            report_progress(stage="model", done=0, total=len(audio_files), reused=0, embedded=0, failed=0)
            _ensure_model_and_processor()
        resolved_keys: set[str] = set()
        for position, path in enumerate(audio_files):
            report_progress(stage="embedding", done=position, total=len(audio_files),
                            reused=reused, embedded=embedded, failed=len(failures))
            song_key = path.stem if key_resolver else get_song_key(path)
            index_key = str(key_resolver(path) if key_resolver else song_key).strip()
            if not index_key:
                raise ValueError(f"歌曲缺少索引身份：{path}")
            if index_key in resolved_keys:
                raise ValueError(f"歌曲索引身份重复：{path}")
            resolved_keys.add(index_key)
            if index_key in index:
                reused += 1
                old_path, emb = index[index_key]
                if (not Path(old_path).exists()) and (not _same_path(old_path, path)):
                    index[index_key] = (str(path), emb)
                    dirty = True
                    print(f"[index] 路径重定位: {song_key} | {old_path} -> {path}")
                continue
            print(f"[index] 新文件: {song_key} | {path}")
            attempted += 1
            t0 = time.perf_counter()
            try:
                wav, sr = load_wave(path)
                emb = embed_segment(wav, sr)  # 整首歌一个 embedding
                index[index_key] = (str(path), emb)
                embedded += 1
                dirty = True
            except torch.cuda.OutOfMemoryError as e:
                raise RuntimeError("显存不足，已停止索引任务并保留旧索引；请关闭占用显存的程序后重试。") from e
            except Exception as e:
                print(f"[index][skip] {path} 因读取/推理失败: {e}")
                failures.append({"path": str(path), "error": str(e)})
                continue
            if time.perf_counter() - t0 > timeout_sec:
                # 当前只是慢任务告警；真正可中止的单曲超时仍需独立进程边界。
                print(f"[index][warn] {path} 处理已完成，但耗时超过参考阈值 {timeout_sec}s。")
            # 定期检查点，避免长任务未落盘
            if dirty and (len(index) % 100 == 0):
                torch.save(index, checkpoint_path)
                dirty = False
    except KeyboardInterrupt:
        # 支持 Ctrl+C 优雅退出，保存已完成部分
        print("[index] 捕获 Ctrl+C，中断扫描，保存已完成的索引...")
        interrupted = True
    if dirty:
        report_progress(stage="checkpoint")
        torch.save(index, checkpoint_path)
    report_progress(stage="embedding", done=reused + attempted, total=len(audio_files),
                    reused=reused, embedded=embedded, failed=len(failures))
    if stats is not None:
        stats.update({
            "scanned": len(audio_files),
            "reused": reused,
            "attempted": attempted,
            "embedded": embedded,
            "failed": len(failures),
            "failures": failures[:20],
            "interrupted": interrupted,
        })
    print(f"[index] 阶段检查点保存到 {checkpoint_path}，当前 {len(index)} 首歌")
    release_model()
    return index


def load_config() -> Dict:
    """
    读取 config.json，如不存在则写入默认配置。
    """
    changed = False
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = copy.deepcopy(DEFAULT_CONFIG)
            changed = True
    else:
        cfg = copy.deepcopy(DEFAULT_CONFIG)
        changed = True
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    if not isinstance(cfg, dict):
        cfg = copy.deepcopy(DEFAULT_CONFIG)
        changed = True
    # 补充缺省项
    def merge(d, default):
        nonlocal changed
        for k, v in default.items():
            if k not in d:
                d[k] = copy.deepcopy(v)
                changed = True
            elif isinstance(v, dict):
                if not isinstance(d.get(k), dict):
                    d[k] = copy.deepcopy(v)
                    changed = True
                else:
                    merge(d[k], v)
    merge(cfg, DEFAULT_CONFIG)
    if changed and CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
    return cfg


def cosine_sim(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """计算余弦相似度矩阵，a:[m,d], b:[n,d] -> [m,n]"""
    a = torch.nn.functional.normalize(a, dim=-1)
    b = torch.nn.functional.normalize(b, dim=-1)
    return a @ b.T


def recommend(query_path: Path, index: Index, config: Dict = None, history: List[str] = None) -> List[Tuple[str, float, float]]:
    """
    计算全体候选相似度，返回按相似度降序排列的候选。

    config 参数为旧调用兼容保留；推荐区间与回退策略由常驻 API 统一处理。
    """
    query_key = get_song_key(query_path)

    # 仅在索引命中时计算；缺失直接返回空，避免实时推理耗时
    if query_key not in index:
        return []
    _, q_emb = index[query_key]

    history_set = set(history or [])

    # 构造候选列表，跳过历史与自身
    candidates = [(path_str, emb) for song_key, (path_str, emb) in index.items() if song_key != query_key and path_str not in history_set]
    if not candidates:
        return []

    # 统一堆叠计算相似度
    cand_paths = [p for p, _ in candidates]
    cand_embs = torch.stack([emb for _, emb in candidates])
    q_norm = torch.nn.functional.normalize(q_emb.cpu(), dim=-1)
    cand_norm = torch.nn.functional.normalize(cand_embs.cpu(), dim=-1)
    sims = cosine_sim(q_norm.unsqueeze(0), cand_norm).squeeze(0)  # [N]

    # 返回全量候选按相似度降序
    order = torch.argsort(sims, descending=True)
    top = [(cand_paths[i], float(sims[i]), float(sims[i])) for i in order]
    return top


def load_existing_index() -> Index:
    """从磁盘加载已有的嵌入索引。"""
    if INDEX_PATH.exists():
        print(f"[load] 读取已有索引: {INDEX_PATH}")
        raw = torch.load(INDEX_PATH)
        normalized: Index = {}
        changed = False
        for k, v in raw.items():
            # 新格式：song_key -> (path, emb)
            if isinstance(v, (list, tuple)) and len(v) == 2:
                path_str, emb = v
                raw_key = str(k)
                song_key = normalize_song_key(raw_key)
                if song_key != raw_key:
                    changed = True
                if not song_key:
                    song_key = get_song_key(Path(path_str))
                    changed = True
            else:
                # 旧格式：路径字符串 -> embedding
                path_str, emb = k, v
                song_key = get_song_key(Path(k))
                changed = True
            if song_key in normalized:
                # 冲突时保留第一个，避免覆盖
                changed = True
                continue
            normalized[song_key] = (str(path_str), emb)
        if changed:
            try:
                torch.save(normalized, INDEX_PATH)
                print(f"[load] 索引键已规范化并回写: {INDEX_PATH}")
            except Exception as e:
                print(f"[load][warn] 索引规范化回写失败: {e}")
        return normalized
    return {}


def main():
    """
    主流程：
    1) 列出音乐库音频
    2) 构建/增量更新索引
    3) 以第一首歌为例做推荐并打印
    """
    if not AUDIO_DIR.exists():
        raise FileNotFoundError(f"音乐目录不存在: {AUDIO_DIR}")

    print(f"[start] 音乐目录: {AUDIO_DIR}")
    t0 = time.time()
    audio_files = list_audio_files(AUDIO_DIR)
    if not audio_files:
        raise RuntimeError(f"目录内未找到音频文件: {AUDIO_DIR}")
    print(f"[scan] 找到音频 {len(audio_files)} 首")

    existing = load_existing_index()
    print(f"[load] 已有索引歌曲数: {len(existing)}")
    index = build_index(audio_files, existing)

    query = audio_files[0]  # 示例：用第一首歌做查询
    print(f"[query] 使用查询歌曲: {query}")
    recs = recommend(query, index)

    print(f"[result] Query: {query}")
    for path_str, sim, _ in recs[:5]:
        print(f"{sim:.4f} | {path_str}")

    print(f"[done] 总耗时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
