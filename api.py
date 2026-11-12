"""
Electron 桌面播放器使用的本机 FastAPI 服务。

服务只监听 loopback，负责配置、曲库扫描、轻量索引读取、推荐查询和索引
worker 管理。常驻进程不得导入 PyTorch/MERT；重型计算由 index_worker.py
子进程完成。

启动命令（单 worker，避免重复加载模型）：
  python -m uvicorn api:app --host 127.0.0.1 --port 29613 --workers 1
端口改 --port 即可。
"""
import threading
import time
import subprocess
import sys
import os
import signal
import copy
from pathlib import Path
from typing import Dict, Optional, List, Any, Literal, Tuple
import json
import uuid
import hashlib
import secrets
from collections import deque
from contextlib import asynccontextmanager

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.responses import JSONResponse
from feature_policy import startup_selection, route_module
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import numpy as np

import vector_store
from music_library_roots import configured_roots, normalize_roots, roots_key, scan_roots, contains as root_contains
from lazy_service import DeferredService
from resource_runtime import worker_command, runtime_python, source_path, worker_environment
from listening_trace_service import ListeningTraceService
from listening_trace_store import TraceConflict
import sqlite3
from seed_semantic import SeedSemanticVerifier, SeedSemanticError
import recommendation_engine
import similar_tracks
from music_analysis_store import source_version as analysis_source_version
from audio_payload_fingerprint import is_audio_payload_identity
from tag_commit_reconciler import TagCommitIdentityReconciler, TagCommitIdentityRequest
from tag_edit_service import TagEditService
from track_identity import TrackIdentityError, TrackIdentityRegistry, TrackObservation, normalize_resource_path
from music_keys import (
    build_artist_title_key,
    get_song_key,
    is_online_token,
    list_audio_files,
    normalize_title_key,
)
from runtime_paths import (
    APP_CONFIG_PATH,
    APP_HOME,
    CONFIG_DIR,
    DATA_DIR,
    DOWNLOAD_DIR,
    LIBRARY_DIR,
    LOG_DIR,
    LEGACY_LOCAL_INDEX_PATH,
    LEGACY_ONLINE_INDEX_PATH,
    LOCAL_EMBEDDINGS_PATH,
    LOCAL_TRACKS_PATH,
    MODEL_DIR,
    LISTENING_HISTORY_DIR,
    ONLINE_EMBEDDINGS_PATH,
    ONLINE_EMBEDDINGS_META_PATH,
    PROJECT_ROOT,
    SEED_PATH,
    TRACK_IDENTITIES_PATH,
    TAG_COMMIT_JOURNAL_PATH,
    ensure_runtime_dirs,
    migrate_legacy_files,
    legacy_import_allowed,
    runtime_paths_payload,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    startup_event()
    try:
        yield
    finally:
        shutdown_event()


app = FastAPI(title="Flowave Local API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["kumiko-app://renderer"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)
RECOMMENDATION_RATE_PATH = LIBRARY_DIR / "recommendation_rate.json"
FEATURE_SELECTION = startup_selection(CONFIG_DIR / 'features.json')


@app.middleware('http')
async def official_module_admission(request, call_next):
    module = route_module(request.url.path)
    if request.method != 'OPTIONS' and module and not FEATURE_SELECTION['enabled'][module]:
        # Saved analysis remains consumable by recommendation without enabling
        # the analysis UI or generator. Internal model readers are unchanged.
        readable_result = request.method == 'GET' and request.url.path == '/analysis/track' and FEATURE_SELECTION['enabled']['recommendation']
        if not readable_result:
            return JSONResponse(status_code=403, content={'detail':{'code':'FEATURE_DISABLED','module':module,'message':'此功能已停用，可在设置的功能选装中启用，下次启动生效。'}})
    return await call_next(request)

LISTENING_HISTORY_PATH = LISTENING_HISTORY_DIR / "listening_history.json"
def _create_sound_map_service():
    from sound_map import SoundMapService
    return SoundMapService(DATA_DIR / 'cache' / 'sound-map')


SOUND_MAP_SERVICE = DeferredService(_create_sound_map_service)
LISTENING_TRACE_SERVICE = ListeningTraceService(LIBRARY_DIR / "listening-traces")
STARTUP_SYNC_STATE_PATH = CONFIG_DIR / "startup_sync_state.json"


class ListeningTraceRequest(BaseModel):
    action: Literal['begin', 'prepare', 'routes', 'route', 'attempt', 'export', 'rebuild']
    migrationId: str
    legacyJson: Optional[str] = None
    watermarks: Optional[Dict[str, int]] = None
    previousId: Optional[str] = None
    traceId: Optional[str] = None
    attemptId: Optional[str] = None
    limit: int = 100
    beforeOrder: Optional[int] = None


@app.post('/listening-traces/view')
def listening_trace_view(req: ListeningTraceRequest):
    """Explicit, managed projection work. No startup scan or model dependency."""
    try:
        service = LISTENING_TRACE_SERVICE
        if req.action == 'begin':
            return service.begin(req.migrationId, req.legacyJson, req.watermarks)
        if req.action == 'prepare':
            return service.prepare(req.migrationId)
        if req.action == 'routes':
            return service.routes(req.migrationId, req.limit, req.beforeOrder)
        if req.action == 'route':
            return service.route(req.migrationId, req.traceId)
        if req.action == 'attempt':
            return service.attempt(req.migrationId, req.attemptId)
        if req.action == 'export':
            return service.export(req.migrationId)
        return service.rebuild(req.previousId, req.migrationId)
    except (TraceConflict, ValueError, TypeError) as exc:
        raise HTTPException(409, detail={'code': 'TRACE_CONFLICT', 'message': str(exc)}) from exc
    except (sqlite3.DatabaseError, OSError) as exc:
        raise HTTPException(503, detail={'code': 'TRACE_VIEW_UNAVAILABLE', 'message': '轨迹视图暂时无法读取，原始记录保留'}) from exc

def _resolve_package_path_or_default(raw: str, default: Path) -> Path:
    value = str(raw or "").strip()
    if not value:
        return default
    candidate = Path(value).expanduser().resolve()
    try:
        candidate.relative_to(APP_HOME)
        return candidate
    except ValueError:
        return default
# 全局状态，所有请求共享（简单理解为“全局变量”）
state_lock = threading.Lock()
WORKER_STATUS = {
    "running": False,
    "cancel_requested": False,
    "command": "",
    "last_ok": None,
    "last_error": "",
    "last_result": {},
    "last_started_at": 0.0,
    "last_finished_at": 0.0,
    "progress": {},
}
ACTIVE_WORKER_PROCESS: Optional[subprocess.Popen] = None
WORKER_PROCESS_LOCK = threading.Lock()


DEFAULT_CONFIG = {
    "audio_dir": "",
    "download_dir": str(DOWNLOAD_DIR),
    "similarity": {"like_min": 0.98, "like_max": 0.99, "fallback_top_n": 10},
    "recommendation": dict(recommendation_engine.DEFAULTS),
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
    "index": {"per_file_timeout": 30},
    "model": {"source": "m-a-p/MERT-v1-330M", "local_dir": "models/MERT-v1-330M"},
    "seed": {"tau": 30, "tau_pos": 20, "tau_neg": 5, "lambda_neg": 0.5},
    "online": {
        "auto_index_enabled": True,
        "auto_index_after_seconds": 60,
        "default_quality": "320k",
        "exclude_tokens": [],
    },
}

SERVICE_ID = "kumiko-music-local"
SERVICE_PROTOCOL_VERSION = 1


def _merge_defaults(cfg: Dict[str, Any], defaults: Dict[str, Any]) -> bool:
    changed = False
    for key, value in defaults.items():
        if key not in cfg:
            cfg[key] = copy.deepcopy(value)
            changed = True
        elif isinstance(value, dict):
            if not isinstance(cfg.get(key), dict):
                cfg[key] = copy.deepcopy(value)
                changed = True
            else:
                changed = _merge_defaults(cfg[key], value) or changed
    return changed


def _write_config_file(cfg: Dict[str, Any]) -> None:
    APP_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = APP_CONFIG_PATH.with_name(f"{APP_CONFIG_PATH.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(APP_CONFIG_PATH)


def load_config() -> Dict[str, Any]:
    ensure_runtime_dirs()
    changed = False
    if APP_CONFIG_PATH.exists():
        try:
            cfg = json.loads(APP_CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            cfg = copy.deepcopy(DEFAULT_CONFIG)
            changed = True
    else:
        cfg = copy.deepcopy(DEFAULT_CONFIG)
        changed = True
    if not isinstance(cfg, dict):
        cfg = copy.deepcopy(DEFAULT_CONFIG)
        changed = True
    changed = _merge_defaults(cfg, DEFAULT_CONFIG) or changed
    resolved_download_dir = str(_resolve_package_path_or_default(str(cfg.get("download_dir", "")), DOWNLOAD_DIR))
    if cfg.get("download_dir") != resolved_download_dir:
        cfg["download_dir"] = resolved_download_dir
        changed = True
    if changed:
        _write_config_file(cfg)
    return cfg


def _run_worker(args: List[str]) -> Dict[str, Any]:
    global ACTIVE_WORKER_PROCESS
    script = source_path(APP_HOME, "index_worker.py")
    exe_candidates = [
        APP_HOME / "backend" / "index-worker.exe",
        APP_HOME / "backend" / "index-worker" / "index-worker.exe",
    ]
    exe = next((item for item in exe_candidates if item.exists()), exe_candidates[0])
    index_python = PROJECT_ROOT / ".venv-index" / "Scripts" / "python.exe"
    ready = index_python.parent.parent / ".gpu-ready"
    use_gpu_environment = not getattr(sys, "frozen", False) and index_python.is_file() and ready.is_file()
    managed_python = runtime_python(APP_HOME, "recommendation", required=False)
    if managed_python and managed_python != index_python:
        cmd = worker_command(APP_HOME, "recommendation", "index_worker.py", *args)
        use_gpu_environment = True
    elif use_gpu_environment:
        cmd = [str(index_python), str(script), *args]
    elif exe.exists():
        cmd = [str(exe), *args]
    elif getattr(sys, "frozen", False):
        raise RuntimeError("推荐组件尚未安装，请到“设置 > 高级维护”点击“安装推荐组件”")
    else:
        cmd = [sys.executable, str(script), *args]
    with WORKER_PROCESS_LOCK:
        if MUSIC_ANALYSIS_SERVICE.running or STEM_SERVICE.running or PRACTICE_SERVICE.running:
            raise RuntimeError("音乐分析或分轨正在使用显卡，请先取消该任务再更新推荐索引")
        if ACTIVE_WORKER_PROCESS is not None:
            raise RuntimeError("已有索引任务正在运行，请等待完成或先取消")
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
        if os.name == "nt":
            creationflags |= getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
        proc = subprocess.Popen(
            cmd,
            cwd=str(APP_HOME),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            env={**worker_environment(APP_HOME), "KUMIKO_APP_HOME": str(APP_HOME), "PYTHONUNBUFFERED": "1",
                 "PYTHONIOENCODING": "utf-8", "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2",
                 "OPENBLAS_NUM_THREADS": "2", "TOKENIZERS_PARALLELISM": "false",
                 "KUMIKO_REQUIRE_CUDA": "1" if use_gpu_environment else "0"},
            creationflags=creationflags,
        )
        ACTIVE_WORKER_PROCESS = proc
        with state_lock:
            WORKER_STATUS.update({
                "running": True,
                "cancel_requested": False,
                "command": " ".join(args),
                "last_started_at": time.time(),
                "last_error": "",
                "last_ok": None,
                "progress": {"stage": "starting", "done": 0, "total": 0},
            })
    try:
        tail = deque(maxlen=30)
        payload = {}
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("FLOWAVE_PROGRESS "):
                try:
                    progress = json.loads(line[len("FLOWAVE_PROGRESS "):])
                    if isinstance(progress, dict):
                        with state_lock:
                            WORKER_STATUS["progress"] = progress
                except (ValueError, TypeError):
                    pass
                continue
            tail.append(line)
            try:
                candidate = json.loads(line)
                if isinstance(candidate, dict) and "ok" in candidate:
                    payload = candidate
            except (ValueError, TypeError):
                pass
        proc.wait()
        if proc.returncode != 0 or not payload.get("ok", False):
            with state_lock:
                cancelled = bool(WORKER_STATUS.get("cancel_requested"))
            if cancelled:
                raise RuntimeError("索引任务已取消，旧索引保持不变")
            raise RuntimeError(payload.get("error") or "\n".join(tail) or f"worker failed: {proc.returncode}")
        with state_lock:
            WORKER_STATUS.update({
                "running": False,
                "cancel_requested": False,
                "last_ok": True,
                "last_result": payload,
                "last_finished_at": time.time(),
            })
        return payload
    except Exception as exc:
        with state_lock:
            WORKER_STATUS.update({
                "running": False,
                "last_ok": False,
                "last_error": str(exc)[-8000:],
                "last_finished_at": time.time(),
            })
            failure = dict(WORKER_STATUS)
        try:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            temporary = LOG_DIR / "index-worker-error.json.tmp"
            temporary.write_text(json.dumps(failure, ensure_ascii=False), encoding="utf-8")
            temporary.replace(LOG_DIR / "index-worker-error.json")
        except OSError as log_error:
            print(f"[index] error log could not be saved: {log_error}", file=sys.stderr)
        raise
    finally:
        if proc.stdout:
            proc.stdout.close()
        with WORKER_PROCESS_LOCK:
            if ACTIVE_WORKER_PROCESS is proc:
                ACTIVE_WORKER_PROCESS = None


def _cancel_active_worker() -> Dict[str, Any]:
    with WORKER_PROCESS_LOCK:
        proc = ACTIVE_WORKER_PROCESS
        if proc is None or proc.poll() is not None:
            return {"ok": True, "running": False, "cancel_requested": False}
        with state_lock:
            WORKER_STATUS["cancel_requested"] = True
        try:
            if os.name == "nt" and hasattr(signal, "CTRL_BREAK_EVENT"):
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                proc.send_signal(signal.SIGINT)
        except Exception as exc:
            with state_lock:
                WORKER_STATUS["last_error"] = f"取消请求发送失败: {exc}"
            raise RuntimeError(f"取消索引任务失败: {exc}") from exc
        return {"ok": True, "running": True, "cancel_requested": True}


_migration_state = migrate_legacy_files()
_initial_config = load_config()
track_identity_registry = TrackIdentityRegistry(TRACK_IDENTITIES_PATH)
tag_commit_reconciler = TagCommitIdentityReconciler(
    TAG_COMMIT_JOURNAL_PATH,
    identity_registry=track_identity_registry,
    load_records=vector_store.load_local_records,
    save_records=vector_store.save_local_records,
)
state = {
    "audio_dir": Path(_initial_config.get("audio_dir") or ""),  # 当前使用的音乐目录
    "index": {},                         # 缓存的 embedding 索引：path -> emb（避免重复算）
    "resource_index": {},                # resource_id -> LocalVectorRecord；V3 推荐主索引
    "config": _initial_config,           # 当前配置（从 config.json 读）
    "audio_files": [],                   # 已索引的文件列表
    "path_key_cache": {},                # 本地路径 -> song_key，避免热路径重复读标签
    "local_track_map": {},               # 当前 audio_dir 中可用的本地 song_key -> path
    "local_path_to_key": {},             # 当前 audio_dir 中可用的本地 path -> song_key
    "local_path_to_resource": {},        # 当前 audio_dir 中可用的本地 path -> resource_id
    "local_resource_map": {},            # 当前 audio_dir 中可用的 resource_id -> path
    "local_song_key_to_resources": {},   # 当前 song_key -> resource_id 列表（允许重复标签）
    "track_identities_by_path": {},      # 当前路径 -> 持久 resource identity
    "track_identity_status": track_identity_registry.status(),
    "tag_commit_reconcile_status": {"status": "idle", "error": ""},
    "local_index_cache": {               # 本地推荐热路径缓存
        "keys": [],
        "paths": [],
        "norm_embs": None,
        "key_to_idx": {},
        "index_view": {},
    },
    "online_index": {},                  # 在线 embedding 索引：token -> (token, emb)
    "online_catalog": {},                # 在线元数据目录
    "startup_sync_in_progress": False,   # 后台启动同步是否进行中
    "startup_sync_ready": False,         # 本地目录扫描与缓存是否已完成一次真实同步
    "startup_sync_error": "",            # 后台启动同步最近一次错误
    "library_refresh_generation": 0,     # 手动刷新只允许最后一代扫描结果提交
    "library_refresh_in_progress": False,
    "library_refresh_error": "",
    "recommendation_rate": {},            # 普通推荐流中心化倾向：path -> raw/norm
    "recommendation_rate_meta": {         # 推荐率文件状态与重建进度
        "status": "missing",
        "updatedAt": 0.0,
        "last_error": "",
        "progress": {"done": 0, "total": 0},
        "summary": {},
        "signature": {},
    },
    "recommendation_rate_rebuild_running": False,
}
# 记录缺失日志的节流，避免控制台刷屏
_missing_log_ts = {}


def _ensure_online_config(cfg: Dict[str, Any]):
    cfg["audio_dirs"] = configured_roots(cfg)
    cfg["audio_dir"] = next(iter(cfg["audio_dirs"]), "")
    online = cfg.setdefault("online", {})
    online.setdefault("auto_index_enabled", True)
    online.setdefault("auto_index_after_seconds", 60)
    online.setdefault("default_quality", "320k")
    online.setdefault("exclude_tokens", [])
    return cfg


def _refresh_local_audio_files_locked(scan_dir: Optional[Path] = None):
    roots = configured_roots(state['config'])
    if not roots:
        if state.get('resource_index'):
            _seed_local_view_from_index_locked()
            _rebuild_local_index_cache_from_existing_map_locked()
        return
    # Do not publish a partial scan when one of the configured roots is offline.
    files = scan_roots(roots, list_audio_files)
    state['audio_files'] = files
    current_paths = {str(p) for p in files}
    state['path_key_cache'] = {p:k for p,k in state['path_key_cache'].items() if p in current_paths}


def _scan_dir_identity(path: Path | str) -> str:
    """生成只用于比较的目录身份，避免同一路径的大小写或相对写法误判。"""
    try:
        return os.path.normcase(str(Path(path).expanduser().resolve(strict=False)))
    except Exception:
        return os.path.normcase(os.path.abspath(str(path)))


def _scan_local_audio_snapshot(scan_dir: Path, known_keys: Optional[Dict[str, str]] = None) -> tuple[List[Path], Dict[str, str]]:
    """
    在不持有全局锁时建立一次完整曲库快照。
    song key 同步预取，提交阶段不再长时间解析整库标签。
    """
    files = scan_roots(scan_dir if isinstance(scan_dir, (list, tuple)) else [scan_dir], list_audio_files)
    cached = known_keys or {}
    path_key_cache: Dict[str, str] = {}
    for path in files:
        path_str = str(path)
        song_key = cached.get(path_str) or get_song_key(path)
        if song_key:
            path_key_cache[path_str] = song_key
    return files, path_key_cache


def _build_track_identity_observations_locked() -> List[TrackObservation]:
    key_counts: Dict[str, int] = {}
    for path in state["audio_files"]:
        song_key = str(state["path_key_cache"].get(str(path)) or "")
        if song_key:
            key_counts[song_key] = key_counts.get(song_key, 0) + 1
    records_by_path = _resource_records_by_path_locked()
    records_by_song_key: Dict[str, List[vector_store.LocalVectorRecord]] = {}
    for record in (state.get("resource_index") or {}).values():
        if record.song_key:
            records_by_song_key.setdefault(record.song_key, []).append(record)
    observations: List[TrackObservation] = []
    for path in state["audio_files"]:
        path_str = str(path)
        song_key = str(state["path_key_cache"].get(path_str) or "")
        try:
            stat = Path(path).stat()
            size = int(stat.st_size)
            mtime_ns = int(stat.st_mtime_ns)
        except OSError:
            size = 0
            mtime_ns = 0
        identity = (state.get("track_identities_by_path") or {}).get(path_str) or {}
        record = (state.get("resource_index") or {}).get(str(identity.get("resource_id") or ""))
        if record is None:
            exact = records_by_path.get(normalize_resource_path(path_str)) or []
            record = exact[0] if len(exact) == 1 else None
        if (
            record is None
            and not str(identity.get("resource_id") or "")
            and song_key
            and key_counts.get(song_key) == 1
        ):
            key_records = records_by_song_key.get(song_key) or []
            record = key_records[0] if len(key_records) == 1 else None
        fingerprint = ""
        identity_stat_matches = bool(
            identity
            and int(identity.get("size") or 0) == size
            and int(identity.get("mtime_ns") or 0) == mtime_ns
        )
        identity_resource_id = str(identity.get("resource_id") or "")
        if (
            record is not None
            and identity_stat_matches
            and identity_resource_id
            and identity_resource_id == str(record.resource_id or "")
            and is_audio_payload_identity(record.content_fingerprint)
        ):
            fingerprint = str(record.content_fingerprint)
        if (
            not fingerprint
            and identity_stat_matches
            and is_audio_payload_identity(identity.get("content_fingerprint"))
        ):
            fingerprint = str(identity.get("content_fingerprint"))
        observations.append(TrackObservation(
            path=path_str,
            song_key=song_key,
            size=size,
            mtime_ns=mtime_ns,
            content_fingerprint=fingerprint,
        ))
    return observations


def _path_relative_to_root(path: str | Path, root: str | Path) -> str:
    try:
        # 历史盘符可能已经离线。路径迁移证据只需词法比较，禁止 resolve 探测设备。
        return str(Path(os.path.abspath(str(path))).relative_to(Path(os.path.abspath(str(root))))).casefold()
    except (OSError, ValueError):
        return ""


def _build_root_relocation_hints_locked(
    target_root: str | Path,
    audio_files: List[Path],
    *,
    previous_root: str | Path | None = None,
) -> Dict[str, str]:
    """
    为整座曲库搬家恢复稳定身份。

    只接受“旧曲库根下的相对路径，在新曲库根下仍完全一致”的记录；旧记录
    已保存文件大小时还必须与新文件一致。显式切换目录可直接使用原曲库根；
    对已经被旧版本错误切换过的数据，仅在绝大多数旧记录都能按相对路径对应时
    才从身份表推断旧根，避免把另一座结构相似的小曲库误认成原曲库。
    """
    target_root_path = Path(target_root).resolve(strict=False)
    snapshot = track_identity_registry.snapshot()
    identity_entries = list((snapshot.get("tracks") or {}).values())
    external_entries = [
        entry
        for entry in identity_entries
        if str(entry.get("resource_id") or "")
        and str(entry.get("current_path") or "")
        and not _path_relative_to_root(str(entry.get("current_path") or ""), target_root_path)
    ]
    if not external_entries:
        return {}

    next_by_relative: Dict[str, List[str]] = {}
    next_sizes: Dict[str, int] = {}
    for path in audio_files:
        path_str = str(path)
        relative = _path_relative_to_root(path, target_root_path)
        if not relative:
            continue
        next_by_relative.setdefault(relative, []).append(path_str)
        try:
            next_sizes[path_str] = int(path.stat().st_size)
        except OSError:
            next_sizes[path_str] = 0

    if not next_by_relative:
        return {}

    roots: List[tuple[Path, bool]] = []
    if previous_root:
        previous_root_path = Path(os.path.abspath(str(previous_root)))
        if _scan_dir_identity(previous_root_path) != _scan_dir_identity(target_root_path):
            roots.append((previous_root_path, True))

    external_paths = [str(entry.get("current_path") or "") for entry in external_entries]
    inferred_counts: Dict[str, int] = {}
    target_leaf = target_root_path.name.casefold()
    for raw_path in external_paths:
        for parent in Path(raw_path).parents:
            if parent.name.casefold() == target_leaf:
                key = _scan_dir_identity(parent)
                inferred_counts[key] = inferred_counts.get(key, 0) + 1
                break
    for raw_root, count in sorted(inferred_counts.items(), key=lambda item: item[1], reverse=True):
        if count < 2:
            continue
        inferred_root = Path(os.path.abspath(raw_root))
        if (
            _scan_dir_identity(inferred_root) != _scan_dir_identity(target_root_path)
            and all(_scan_dir_identity(inferred_root) != _scan_dir_identity(root) for root, _ in roots)
        ):
            roots.append((inferred_root, False))

    external_paths_by_anchor: Dict[str, List[str]] = {}
    for raw_path in external_paths:
        external_paths_by_anchor.setdefault(Path(raw_path).anchor.casefold(), []).append(raw_path)
    for anchor_paths in external_paths_by_anchor.values():
        if len(anchor_paths) < 2:
            continue
        try:
            inferred_root = Path(os.path.commonpath(anchor_paths))
            if inferred_root.suffix:
                inferred_root = inferred_root.parent
            if (
                inferred_root != Path(inferred_root.anchor)
                and _scan_dir_identity(inferred_root) != _scan_dir_identity(target_root_path)
                and all(_scan_dir_identity(inferred_root) != _scan_dir_identity(root) for root, _ in roots)
            ):
                roots.append((inferred_root, False))
        except (OSError, ValueError):
            pass

    for source_root, explicit in roots:
        old_by_relative: Dict[str, List[Dict[str, Any]]] = {}
        for entry in external_entries:
            relative = _path_relative_to_root(str(entry.get("current_path") or ""), source_root)
            if relative:
                old_by_relative.setdefault(relative, []).append(entry)

        matches: List[tuple[str, Dict[str, Any]]] = []
        for relative, old_entries in old_by_relative.items():
            new_paths = next_by_relative.get(relative) or []
            if len(old_entries) != 1 or len(new_paths) != 1:
                continue
            old_entry = old_entries[0]
            new_path = new_paths[0]
            old_size = int(old_entry.get("size") or 0)
            new_size = int(next_sizes.get(new_path) or 0)
            if old_size and new_size and old_size != new_size:
                continue
            matches.append((new_path, old_entry))

        if not matches:
            continue
        if not explicit:
            old_coverage = len(matches) / max(1, len(old_by_relative))
            target_coverage = len(matches) / max(1, len(next_by_relative))
            if len(matches) < 2 or old_coverage < 0.8 or target_coverage < 0.8:
                continue
        return {
            new_path: str(old_entry.get("resource_id") or "")
            for new_path, old_entry in matches
        }
    return {}


def _reconcile_track_identities_locked(
    *,
    allow_song_key_relocation: bool = True,
    relocation_resource_ids: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    if str((state.get("tag_commit_reconcile_status") or {}).get("status") or "") == "conflict":
        snapshot = track_identity_registry.snapshot()
        state["track_identities_by_path"] = {
            str(entry.get("current_path") or ""): entry
            for entry in (snapshot.get("tracks") or {}).values()
            if str(entry.get("current_path") or "") and not bool(entry.get("missing"))
        }
        state["track_identity_status"] = {
            **track_identity_registry.status(),
            "write_blocked": True,
            "reason": "存在未解决的标签提交对账冲突",
        }
        return {"ok": False, "created": 0, "restored": 0, "relocations": []}
    try:
        result = track_identity_registry.reconcile(
            _build_track_identity_observations_locked(),
            allow_song_key_relocation=allow_song_key_relocation,
            relocation_resource_ids=relocation_resource_ids,
        )
        state["track_identities_by_path"] = result.by_path
        state["track_identity_status"] = track_identity_registry.status()
        return {
            "ok": True,
            "created": result.created,
            "restored": result.restored,
            "relocations": result.relocations,
        }
    except TrackIdentityError as exc:
        state["track_identity_status"] = track_identity_registry.status()
        print(f"[track-identity][warn] {exc}")
        return {"ok": False, "created": 0, "restored": 0, "relocations": []}


def _current_local_track_map_locked() -> Dict[str, str]:
    """
    返回当前 audio_dir 中实际可用的本地曲目：song_key -> path。
    同 key 多文件时保留首次扫描结果。
    """
    track_map: Dict[str, str] = {}
    path_to_key: Dict[str, str] = {}
    for path in state["audio_files"]:
        path_str = str(path)
        song_key = state["path_key_cache"].get(path_str)
        if not song_key:
            song_key = get_song_key(Path(path))
            state["path_key_cache"][path_str] = song_key
        if song_key and song_key not in track_map:
            track_map[song_key] = path_str
        if song_key:
            path_to_key[path_str] = song_key
    state["local_track_map"] = track_map
    state["local_path_to_key"] = path_to_key
    return track_map


def _refresh_compat_index_from_resources_locked() -> None:
    """为尚未迁移的 song-key 消费者保留只读兼容视图。"""
    compat: Dict[str, Any] = {}
    for record in (state.get("resource_index") or {}).values():
        if record.song_key and record.song_key not in compat:
            compat[record.song_key] = (record.path, record.embedding)
    state["index"] = compat


def _load_local_resource_index_locked() -> None:
    state["resource_index"] = vector_store.load_local_records()
    _refresh_compat_index_from_resources_locked()


def _reconcile_committed_tag_identity_locked(request: TagCommitIdentityRequest) -> Dict[str, Any]:
    """标签文件已提交后的内部前滚入口；不暴露 HTTP 写入能力。"""
    try:
        result = tag_commit_reconciler.reconcile(request)
        state["path_key_cache"][str(request.path)] = str(request.next_song_key)
        _load_local_resource_index_locked()
        snapshot = track_identity_registry.snapshot()
        state["track_identities_by_path"] = {
            str(entry.get("current_path") or ""): entry
            for entry in (snapshot.get("tracks") or {}).values()
            if str(entry.get("current_path") or "") and not bool(entry.get("missing"))
        }
        state["track_identity_status"] = track_identity_registry.status()
        _rebuild_local_index_cache_locked()
        state["tag_commit_reconcile_status"] = {"status": "ready", "error": ""}
        return result
    except Exception as error:
        state["tag_commit_reconcile_status"] = {
            "status": "conflict",
            "error": str(error),
        }
        raise


class _TagEditIdentityBridge:
    def reconcile(self, request):
        return _reconcile_committed_tag_identity_locked(request)


TAG_EDIT_SERVICE = TagEditService(LIBRARY_DIR / "tag-transactions", _TagEditIdentityBridge())


def _resource_records_by_path_locked() -> Dict[str, List[vector_store.LocalVectorRecord]]:
    records_by_path: Dict[str, List[vector_store.LocalVectorRecord]] = {}
    for record in (state.get("resource_index") or {}).values():
        path_key = normalize_resource_path(record.path)
        if path_key:
            records_by_path.setdefault(path_key, []).append(record)
    return records_by_path


def _relink_resource_records_locked(*, allow_song_key_fallback: bool = True) -> int:
    """按稳定身份更新 V3 路径和 song key；无法消歧的旧记录保持原样。"""
    records = state.get("resource_index") or {}
    # V3 resource_index 是唯一可写主索引。state["index"] 只是由它生成的只读
    # song-key 兼容视图，禁止在主索引为空时反向恢复，避免重复 song key 丢行后再发布。

    identities_by_path = state.get("track_identities_by_path") or {}
    identities_by_id = {
        str(entry.get("resource_id") or ""): entry
        for entry in identities_by_path.values()
        if str(entry.get("resource_id") or "")
    }
    identities_by_song_key: Dict[str, List[Dict[str, Any]]] = {}
    for entry in identities_by_path.values():
        song_key = str(entry.get("current_song_key") or "")
        if song_key:
            identities_by_song_key.setdefault(song_key, []).append(entry)

    updated: vector_store.LocalVectorRecords = {}
    relocated = 0
    for mapping_key, record in records.items():
        identity = identities_by_id.get(str(record.resource_id or ""))
        if identity is None:
            exact = identities_by_path.get(record.path)
            if exact is None:
                normalized = normalize_resource_path(record.path)
                exact_matches = [
                    entry
                    for path, entry in identities_by_path.items()
                    if normalize_resource_path(path) == normalized
                ]
                exact = exact_matches[0] if len(exact_matches) == 1 else None
            identity = exact
        if (
            identity is None
            and allow_song_key_fallback
            and not str(record.resource_id or "")
            and record.song_key
        ):
            key_matches = identities_by_song_key.get(record.song_key) or []
            if len(key_matches) == 1:
                identity = key_matches[0]
        if identity is None:
            updated[mapping_key] = record
            continue

        resource_id = str(identity.get("resource_id") or "")
        next_path = str(identity.get("current_path") or record.path)
        next_song_key = str(identity.get("current_song_key") or record.song_key)
        if resource_id in updated:
            updated[mapping_key] = record
            continue
        if normalize_resource_path(next_path) != normalize_resource_path(record.path):
            relocated += 1
        updated[resource_id] = vector_store.LocalVectorRecord(
            resource_id=resource_id,
            song_key=next_song_key,
            path=next_path,
            embedding=np.asarray(record.embedding, dtype=np.float32),
            content_fingerprint=(
                str(record.content_fingerprint or "")
                if is_audio_payload_identity(record.content_fingerprint)
                else ""
            ),
        )

    changed = (
        set(updated) != set(records)
        or any(
            mapping_key not in records
            or normalize_resource_path(record.path) != normalize_resource_path(records[mapping_key].path)
            or record.song_key != records[mapping_key].song_key
            or str(record.content_fingerprint or "")
            != str(records[mapping_key].content_fingerprint or "")
            or records[mapping_key].legacy
            for mapping_key, record in updated.items()
        )
    )
    state["resource_index"] = updated
    _refresh_compat_index_from_resources_locked()
    can_publish = all(
        mapping_key == record.resource_id and bool(record.resource_id)
        for mapping_key, record in updated.items()
    ) and str((state.get("tag_commit_reconcile_status") or {}).get("status") or "") != "conflict"
    if changed and can_publish:
        vector_store.save_local_records(updated)
    return relocated


def _rebuild_local_index_cache_locked():
    """重建本地推荐热路径缓存，避免每次 recommend 都重新拼装候选矩阵。"""
    _current_local_track_map_locked()
    keys: List[str] = []
    paths: List[str] = []
    embs: List[np.ndarray] = []
    index_view: Dict[str, Any] = {}
    resource_map: Dict[str, str] = {}
    path_to_resource: Dict[str, str] = {}
    song_key_to_resources: Dict[str, List[str]] = {}
    recording_groups = {}
    records_by_path = _resource_records_by_path_locked()
    for path in state["audio_files"]:
        path_str = str(path)
        identity = (state.get("track_identities_by_path") or {}).get(path_str) or {}
        resource_id = str(identity.get("resource_id") or "")
        record = (state.get("resource_index") or {}).get(resource_id)
        if record is None:
            exact = records_by_path.get(normalize_resource_path(path_str)) or []
            record = exact[0] if len(exact) == 1 else None
            if record is not None:
                resource_id = str(record.resource_id or resource_id)
        if record is None or not resource_id or resource_id in index_view:
            continue
        song_key = str(state["path_key_cache"].get(path_str) or record.song_key or "")
        keys.append(resource_id)
        paths.append(path_str)
        if FEATURE_SELECTION['enabled']['recommendation']:
            embs.append(_normalize_vec(record.embedding))
        index_view[resource_id] = (path_str, record.embedding)
        resource_map[resource_id] = path_str
        path_to_resource[path_str] = resource_id
        fingerprint=str(getattr(record,'content_fingerprint','') or '')
        if is_audio_payload_identity(fingerprint):recording_groups[resource_id]=fingerprint
        if song_key:
            song_key_to_resources.setdefault(song_key, []).append(resource_id)
    state["local_resource_map"] = resource_map
    state["local_path_to_resource"] = path_to_resource
    state["local_song_key_to_resources"] = song_key_to_resources
    state["local_index_cache"] = {
        "generation": uuid.uuid4().hex,
        "keys": keys,
        "paths": paths,
        "norm_embs": np.stack(embs).astype(np.float32) if embs else None,
        "key_to_idx": {resource_id: idx for idx, resource_id in enumerate(keys)},
        "index_view": index_view,
        "recording_groups": recording_groups,
    }


def _normalize_vec(emb: Any) -> np.ndarray:
    arr = np.asarray(emb, dtype=np.float32)
    norm = float(np.linalg.norm(arr))
    if norm <= 0:
        return arr
    return arr / norm


def _clamp_float(value: Any, fallback: float, min_value: float, max_value: float) -> float:
    try:
        n = float(value)
    except Exception:
        n = float(fallback)
    if not np.isfinite(n):
        n = float(fallback)
    return max(float(min_value), min(float(max_value), n))


def _dislike_correction_config(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    base = json.loads(json.dumps(DEFAULT_CONFIG.get("dislike_correction") or {}))
    src = (cfg or state.get("config") or {}).get("dislike_correction") or {}
    if isinstance(src, dict):
        base.update(src)
    base["enabled"] = bool(base.get("enabled", True))
    base["enable_recommend_rate_fix"] = bool(base.get("enable_recommend_rate_fix", True))
    base["enable_skip_rate_fix"] = bool(base.get("enable_skip_rate_fix", True))
    base["auto_rebuild_recommend_rate"] = bool(base.get("auto_rebuild_recommend_rate", True))
    base["rec_strength"] = _clamp_float(base.get("rec_strength"), 1.0, 0.0, 5.0)
    base["rec_fix_min"] = _clamp_float(base.get("rec_fix_min"), 0.1, 0.01, 10.0)
    base["rec_fix_max"] = _clamp_float(base.get("rec_fix_max"), 20.0, 0.01, 20.0)
    if base["rec_fix_min"] > base["rec_fix_max"]:
        base["rec_fix_min"], base["rec_fix_max"] = base["rec_fix_max"], base["rec_fix_min"]
    base["skip_strength"] = _clamp_float(base.get("skip_strength"), 1.0, 0.0, 5.0)
    base["skip_fix_min"] = _clamp_float(base.get("skip_fix_min"), 0.33, 0.01, 10.0)
    base["skip_fix_max"] = _clamp_float(base.get("skip_fix_max"), 2.0, 0.01, 20.0)
    if base["skip_fix_min"] > base["skip_fix_max"]:
        base["skip_fix_min"], base["skip_fix_max"] = base["skip_fix_max"], base["skip_fix_min"]
    base["skip_smooth_k"] = _clamp_float(base.get("skip_smooth_k"), 20.0, 0.0, 10000.0)
    base["daily_decay"] = _clamp_float(base.get("daily_decay"), 0.98, 0.0, 1.0)
    base["consecutive_dislike_threshold"] = int(_clamp_float(base.get("consecutive_dislike_threshold"), 0, 0, 20))
    base["long_pause_reset_minutes"] = _clamp_float(base.get("long_pause_reset_minutes"), 10.0, 0.0, 1440.0)
    return base


def _recommendation_rate_signature_locked(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = cfg or state["config"]
    cache = state.get("local_index_cache") or {}
    h = hashlib.sha1()
    for key, path in zip(cache.get("keys") or [], cache.get("paths") or []):
        h.update(str(key).encode("utf-8", "surrogatepass"))
        h.update(b"\0")
        h.update(str(path).encode("utf-8", "surrogatepass"))
        h.update(b"\n")
    sim = cfg.get("similarity") or {}
    return {
        "version": 1,
        "scope": "local",
        "trackCount": len(cache.get("paths") or []),
        "indexFingerprint": h.hexdigest(),
        "localTracks": _file_stamp(LOCAL_TRACKS_PATH),
        "localEmbeddings": _file_stamp(LOCAL_EMBEDDINGS_PATH),
        "likeMin": float(sim.get("like_min", 0.0)),
        "likeMax": float(sim.get("like_max", 1.0)),
        "likeProbabilityPolicy": "harmonic-rank-v1",
    }


def _load_recommendation_rate_file() -> Dict[str, Any]:
    try:
        data = json.loads(RECOMMENDATION_RATE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _apply_recommendation_rate_payload_locked(payload: Dict[str, Any], status: Optional[str] = None) -> None:
    tracks = payload.get("tracks") if isinstance(payload, dict) else {}
    if not isinstance(tracks, dict):
        tracks = {}
    state["recommendation_rate"] = tracks
    meta = state["recommendation_rate_meta"]
    meta["status"] = status or str(payload.get("status") or ("ready" if tracks else "missing"))
    meta["updatedAt"] = float(payload.get("updatedAt") or 0)
    meta["last_error"] = str(payload.get("last_error") or "")
    meta["summary"] = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    meta["signature"] = payload.get("signature") if isinstance(payload.get("signature"), dict) else {}
    meta["progress"] = payload.get("progress") if isinstance(payload.get("progress"), dict) else {"done": 0, "total": 0}


def _load_recommendation_rate_locked() -> None:
    payload = _load_recommendation_rate_file()
    if not payload:
        _apply_recommendation_rate_payload_locked({}, "missing")
        return
    current_sig = _recommendation_rate_signature_locked()
    status = "ready" if payload.get("signature") == current_sig else "stale"
    _apply_recommendation_rate_payload_locked(payload, status)


def _save_recommendation_rate_payload(payload: Dict[str, Any]) -> None:
    ensure_runtime_dirs()
    RECOMMENDATION_RATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = RECOMMENDATION_RATE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(RECOMMENDATION_RATE_PATH)


def _mark_recommendation_rate_stale_locked(reason: str = "") -> None:
    meta = state["recommendation_rate_meta"]
    if meta.get("status") != "rebuilding":
        meta["status"] = "stale" if state.get("recommendation_rate") else "missing"
    if reason:
        meta["last_error"] = reason


def _maybe_start_recommendation_rate_rebuild(reason: str = "", force: bool = False) -> bool:
    if not FEATURE_SELECTION['enabled']['recommendation']:
        return False
    with state_lock:
        cfg = _ensure_online_config(state["config"])
        corr = _dislike_correction_config(cfg)
        if not force and not corr.get("auto_rebuild_recommend_rate", True):
            _mark_recommendation_rate_stale_locked(reason)
            return False
        if state.get("recommendation_rate_rebuild_running"):
            return False
        state["recommendation_rate_rebuild_running"] = True
        state["recommendation_rate_meta"].update({
            "status": "rebuilding",
            "last_error": "",
            "progress": {"done": 0, "total": len((state.get("local_index_cache") or {}).get("paths") or [])},
        })

    def worker():
        try:
            payload = _build_recommendation_rate_payload()
            _save_recommendation_rate_payload(payload)
            with state_lock:
                _apply_recommendation_rate_payload_locked(payload, "ready")
                state["recommendation_rate_rebuild_running"] = False
        except Exception as exc:
            with state_lock:
                state["recommendation_rate_rebuild_running"] = False
                state["recommendation_rate_meta"]["status"] = "failed"
                state["recommendation_rate_meta"]["last_error"] = str(exc)
            print(f"[recommend-rate][error] {exc}")

    threading.Thread(target=worker, name="recommend-rate-rebuild", daemon=True).start()
    print(f"[recommend-rate] rebuild started reason={reason or '-'}")
    return True


def _build_recommendation_rate_payload() -> Dict[str, Any]:
    # Uniform-origin, history-free harmonic baseline; not empirical exposure or
    # a stationary distribution. Rolling support is contextual, so it is absent here.
    with state_lock:
        cache = state.get("local_index_cache") or {}
        paths = list(cache.get("paths") or [])
        keys = list(cache.get("keys") or [])
        norm_embs = cache.get("norm_embs")
        cfg = json.loads(json.dumps(state["config"]))
        signature = _recommendation_rate_signature_locked(cfg)
    if norm_embs is None or not paths:
        return {
            "version": 1,
            "updatedAt": time.time(),
            "status": "ready",
            "signature": signature,
            "summary": {"averageRawRate": 0.0, "zeroRateCount": 0, "maxNorm": 1.0, "minNonZeroNorm": 1.0},
            "tracks": {},
        }
    sim = cfg.get("similarity") or {}
    like_min = float(sim.get("like_min", 0.0))
    like_max = float(sim.get("like_max", 1.0))
    mat = np.asarray(norm_embs, dtype=np.float32)
    n = int(mat.shape[0])
    raw = np.zeros((n,), dtype=np.float64)
    ranks = 1.0 / (np.arange(n, dtype=np.float64) + 1.0)
    for i in range(n):
        sims = mat @ mat[i]
        mask = np.ones(n, dtype=bool)
        mask[i] = False
        idx = np.nonzero(mask & (sims >= like_min) & (sims <= like_max))[0]
        if idx.size:
            idx = idx[np.argsort(-sims[idx])]
            weights = ranks[:idx.size]
            raw[idx] += weights / float(weights.sum())
        else:
            fallback = np.nonzero(mask)[0]
            if fallback.size:
                best = fallback[int(np.argmax(sims[fallback]))]
                raw[best] += 1.0
        if i % 50 == 0 or i == n - 1:
            with state_lock:
                state["recommendation_rate_meta"]["progress"] = {"done": i + 1, "total": n}
    avg = float(raw.mean()) if n else 0.0
    nonzero = raw[raw > 0]
    tracks = {}
    for i, path in enumerate(paths):
        norm = float(raw[i] / avg) if avg > 0 else 1.0
        tracks[str(path)] = {
            "songKey": str(keys[i] if i < len(keys) else ""),
            "rawRate": float(raw[i]),
            "normRate": norm,
        }
    return {
        "version": 1,
        "updatedAt": time.time(),
        "status": "ready",
        "signature": signature,
        "summary": {
            "averageRawRate": avg,
            "zeroRateCount": int(np.sum(raw <= 0)),
            "maxNorm": float(raw.max() / avg) if avg > 0 and n else 1.0,
            "minNonZeroNorm": float(nonzero.min() / avg) if avg > 0 and nonzero.size else 1.0,
        },
        "tracks": tracks,
    }


def _load_listening_history_for_skip_fix() -> Dict[str, Any]:
    try:
        data = json.loads(LISTENING_HISTORY_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _skip_behavior_for_path(history: Dict[str, Any], path: str) -> Dict[str, Any]:
    tracks = history.get("tracks") if isinstance(history.get("tracks"), dict) else {}
    item = tracks.get(path) if isinstance(tracks, dict) else None
    if not isinstance(item, dict):
        return {}
    behavior = item.get("recommendationBehavior")
    return behavior if isinstance(behavior, dict) else {}


def _recommend_rate_fix_for_path(path: str, corr: Dict[str, Any], rate_tracks=None) -> Dict[str, float]:
    if not corr.get("enabled", True) or not corr.get("enable_recommend_rate_fix", True):
        return {"raw": 0.0, "norm": 1.0, "fix": 1.0}
    item = (rate_tracks if rate_tracks is not None else state.get("recommendation_rate") or {}).get(path)
    if not isinstance(item, dict):
        return {"raw": 0.0, "norm": 1.0, "fix": 1.0}
    raw = _clamp_float(item.get("rawRate"), 0.0, 0.0, 1e18)
    norm = _clamp_float(item.get("normRate"), 1.0, 0.0, 1e18)
    if raw <= 0 or norm <= 0:
        fix = float(corr.get("rec_fix_max", 20.0))
    else:
        fix = 1.0 / (norm ** float(corr.get("rec_strength", 1.0)))
        fix = _clamp_float(fix, 1.0, float(corr.get("rec_fix_min", 0.1)), float(corr.get("rec_fix_max", 20.0)))
    return {"raw": raw, "norm": norm if norm > 0 else 0.0, "fix": fix}


def _skip_rate_fix_for_path(path: str, corr: Dict[str, Any], history: Dict[str, Any]) -> Dict[str, float]:
    if not corr.get("enabled", True) or not corr.get("enable_skip_rate_fix", True):
        return {"rate": 0.0, "norm": 1.0, "fix": 1.0, "opportunities": 0.0, "skips": 0.0}
    summary = history.get("recommendationBehaviorSummary") if isinstance(history.get("recommendationBehaviorSummary"), dict) else {}
    global_rate = _clamp_float(summary.get("globalSkipRate"), 0.0, 0.0, 1.0)
    total_opps = _clamp_float(summary.get("totalSkipOpportunityCount"), 0.0, 0.0, 1e18)
    if global_rate <= 0 or total_opps <= 0:
        return {"rate": 0.0, "norm": 1.0, "fix": 1.0, "opportunities": 0.0, "skips": 0.0}
    behavior = _skip_behavior_for_path(history, path)
    opps = _clamp_float(behavior.get("skipOpportunityCount"), 0.0, 0.0, 1e18)
    skips = _clamp_float(behavior.get("dislikeChainSkipCount"), 0.0, 0.0, 1e18)
    smooth_k = _clamp_float(corr.get("skip_smooth_k"), 20.0, 0.0, 10000.0)
    rate = (skips + global_rate * smooth_k) / (opps + smooth_k) if (opps + smooth_k) > 0 else global_rate
    norm = rate / global_rate if global_rate > 0 else 1.0
    fix = 1.0 / (norm ** float(corr.get("skip_strength", 1.0))) if norm > 0 else float(corr.get("skip_fix_max", 2.0))
    fix = _clamp_float(fix, 1.0, float(corr.get("skip_fix_min", 0.33)), float(corr.get("skip_fix_max", 2.0)))
    return {"rate": float(rate), "norm": float(norm), "fix": float(fix), "opportunities": opps, "skips": skips}


def _weighted_dislike_pool(pool: List[tuple], corr: Dict[str, Any], history: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Optional[tuple], Dict[str, Any]]:
    weighted: List[Dict[str, Any]] = []
    total = 0.0
    with state_lock:
        rate_status = str((state.get("recommendation_rate_meta") or {}).get("status") or "missing")
        skip_updated_at = float((history.get("recommendationBehaviorSummary") or {}).get("updatedAt") or 0)
        for p, s1, s2 in pool:
            rec = _recommend_rate_fix_for_path(str(p), corr)
            skip = _skip_rate_fix_for_path(str(p), corr, history)
            weight = max(0.0, float(rec["fix"]) * float(skip["fix"]))
            total += weight
            weighted.append({
                "path": p,
                "sim": s1,
                "sim_secondary": s2,
                "rec_rate": rec["raw"],
                "rec_norm": rec["norm"],
                "rec_fix": rec["fix"],
                "skip_rate": skip["rate"],
                "skip_norm": skip["norm"],
                "skip_fix": skip["fix"],
                "skip_opportunities": skip["opportunities"],
                "skip_count": skip["skips"],
                "weight": weight,
                "probability": 0.0,
                "selected": False,
                "excluded_reason": "",
            })
    if not weighted:
        return weighted, None, {
            "enabled": bool(corr.get("enabled", True)),
            "fallbackLevel": "empty",
            "totalWeight": 0.0,
            "selectedPath": "",
            "recommendRateStatus": rate_status,
            "skipRateUpdatedAt": skip_updated_at,
        }
    selected_idx = 0
    fallback = "weighted"
    if total > 0 and np.isfinite(total):
        cursor = float(secrets.randbelow(10_000_000)) / 10_000_000.0 * total
        for idx, item in enumerate(weighted):
            cursor -= float(item["weight"])
            if cursor <= 0:
                selected_idx = idx
                break
        for item in weighted:
            item["probability"] = float(item["weight"]) / total if total > 0 else 0.0
    else:
        fallback = "uniform"
        selected_idx = secrets.randbelow(len(weighted))
        prob = 1.0 / len(weighted)
        for item in weighted:
            item["weight"] = 1.0
            item["probability"] = prob
        total = float(len(weighted))
    weighted[selected_idx]["selected"] = True
    selected = pool[selected_idx]
    return weighted, selected, {
        "enabled": bool(corr.get("enabled", True)),
        "fallbackLevel": fallback,
        "totalWeight": float(total),
        "selectedPath": str(selected[0]),
        "recommendRateStatus": rate_status,
        "skipRateUpdatedAt": skip_updated_at,
    }


def _file_stamp(path: Path) -> Dict[str, Any]:
    try:
        st = path.stat()
        return {"mtime_ns": int(st.st_mtime_ns), "size": int(st.st_size)}
    except Exception:
        return {"mtime_ns": 0, "size": 0}


def _startup_sync_signature(scan_dir: Path, audio_files: List[Path], roots=None) -> Dict[str, Any]:
    h = hashlib.sha1()
    for path in sorted((str(p) for p in audio_files), key=str.lower):
        try:
            st = Path(path).stat()
            h.update(path.encode("utf-8", "surrogatepass"))
            h.update(b"\0")
            h.update(str(int(st.st_mtime_ns)).encode("ascii"))
            h.update(b":")
            h.update(str(int(st.st_size)).encode("ascii"))
            h.update(b"\n")
        except Exception:
            h.update(path.encode("utf-8", "surrogatepass"))
            h.update(b"\0missing\n")
    return {
        "version": 1,
        "audio_dir": str(scan_dir),
        "audio_dirs": normalize_roots(roots) if roots is not None else configured_roots(state["config"]),
        "count": len(audio_files),
        "files_hash": h.hexdigest(),
        "local_tracks": _file_stamp(LOCAL_TRACKS_PATH),
        "local_embeddings": _file_stamp(LOCAL_EMBEDDINGS_PATH),
    }


def _load_startup_sync_state() -> Dict[str, Any]:
    try:
        data = json.loads(STARTUP_SYNC_STATE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_startup_sync_state(signature: Dict[str, Any]) -> None:
    try:
        ensure_runtime_dirs()
        STARTUP_SYNC_STATE_PATH.write_text(json.dumps(signature, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:
        print(f"[startup][warn] save sync state failed: {exc}")


def _rebuild_local_index_cache_from_existing_map_locked():
    """目录签名未变化时复用已知映射，仍以 resource_id 构建热缓存。"""
    _rebuild_local_index_cache_locked()


def _sync_local_view_locked(
    scan_dir: Optional[Path] = None,
    relink_index: bool = False,
    trace_label: str = "",
    skip_heavy_if_unchanged: bool = False,
) -> int:
    """
    统一刷新当前本地曲库视图。
    - 仅刷新目录可见曲目与缓存
    - 或额外按 song_key 重定位索引中的旧路径
    """
    raw_dir = str(scan_dir or state["config"].get("audio_dir") or state["audio_dir"] or "").strip()
    if not raw_dir:
        state["audio_files"] = []
        state["local_track_map"] = {}
        state["local_path_to_key"] = {}
        state["local_path_to_resource"] = {}
        state["local_resource_map"] = {}
        state["local_song_key_to_resources"] = {}
        _rebuild_local_index_cache_locked()
        _load_recommendation_rate_locked()
        return 0
    target_dir = Path(raw_dir)
    scan_t0 = time.perf_counter()
    _refresh_local_audio_files_locked(target_dir)
    relocation_resource_ids = _build_root_relocation_hints_locked(
        target_dir,
        state["audio_files"],
    ) if len(configured_roots(state["config"])) == 1 else {}
    if trace_label:
        print(f"[{trace_label}] scan_dir {time.perf_counter() - scan_t0:.3f}s count={len(state['audio_files'])}")
    signature = None
    if skip_heavy_if_unchanged:
        sig_t0 = time.perf_counter()
        signature = _startup_sync_signature(target_dir, state["audio_files"])
        previous = _load_startup_sync_state()
        if previous == signature:
            cache_t0 = time.perf_counter()
            _reconcile_track_identities_locked(
                relocation_resource_ids=relocation_resource_ids,
            )
            relocated = _relink_resource_records_locked() if relink_index else 0
            _rebuild_local_index_cache_from_existing_map_locked()
            state["startup_sync_ready"] = True
            if trace_label:
                cache_size = len(state["local_index_cache"].get("paths") or [])
                print(f"[{trace_label}] unchanged skip relink_index/rebuild_keys sig={time.perf_counter() - sig_t0:.3f}s cache={time.perf_counter() - cache_t0:.3f}s count={cache_size}")
            _load_recommendation_rate_locked()
            if state["recommendation_rate_meta"].get("status") in {"missing", "stale"}:
                threading.Thread(target=lambda: _maybe_start_recommendation_rate_rebuild("startup-unchanged"), daemon=True).start()
            return relocated
    relocated = 0
    cache_t0 = time.perf_counter()
    _reconcile_track_identities_locked(
        relocation_resource_ids=relocation_resource_ids,
    )
    if relink_index and state["audio_files"]:
        relink_t0 = time.perf_counter()
        relocated = _relink_resource_records_locked()
        if relocated:
            print(f"[index] relocated existing paths: {relocated}")
        if trace_label:
            print(f"[{trace_label}] relink_index {time.perf_counter() - relink_t0:.3f}s relocated={relocated}")
    _rebuild_local_index_cache_locked()
    if trace_label:
        cache_size = len(state["local_index_cache"].get("paths") or [])
        print(f"[{trace_label}] rebuild_cache {time.perf_counter() - cache_t0:.3f}s count={cache_size}")
    _load_recommendation_rate_locked()
    if state["recommendation_rate_meta"].get("status") in {"missing", "stale"}:
        threading.Thread(target=lambda: _maybe_start_recommendation_rate_rebuild(trace_label or "local-view"), daemon=True).start()
    if skip_heavy_if_unchanged and signature is not None:
        _save_startup_sync_state(signature)
    return relocated


def _seed_local_view_from_index_locked():
    """
    基于已加载索引快速建立一个可用的本地视图，不扫描磁盘。
    用于启动早期先让前端尽快拿到曲目列表与基本映射。
    """
    audio_files = []
    track_map: Dict[str, str] = {}
    path_to_key: Dict[str, str] = {}
    for record in (state.get("resource_index") or {}).values():
        song_key = record.song_key
        path_str = record.path
        if not path_str or not any(root_contains(root, path_str) for root in configured_roots(state["config"])):
            continue
        audio_files.append(path_str)
        path_to_key[path_str] = song_key
        if song_key and song_key not in track_map:
            track_map[song_key] = path_str
    state["audio_files"] = audio_files
    state["local_track_map"] = track_map
    state["local_path_to_key"] = path_to_key
    state["local_path_to_resource"] = {}
    state["local_resource_map"] = {}
    state["local_song_key_to_resources"] = {}
    state["local_index_cache"] = {
        "keys": [],
        "paths": [],
        "norm_embs": None,
        "key_to_idx": {},
        "index_view": {},
    }


def _start_deferred_startup_sync(scan_dir: Path):
    with state_lock:
        if state["startup_sync_in_progress"]:
            return
        state["startup_sync_in_progress"] = True
        state["startup_sync_error"] = ""

    def worker():
        total_t0 = time.perf_counter()
        print("[startup] deferred local sync begin")
        try:
            with state_lock:
                relocated = _sync_local_view_locked(
                    scan_dir,
                    relink_index=True,
                    trace_label="startup:deferred",
                    skip_heavy_if_unchanged=True,
                )
                state["startup_sync_ready"] = True
            print(
                f"[startup] deferred sync done relocated={relocated} "
                f"total={time.perf_counter() - total_t0:.3f}s"
            )
        except Exception as exc:
            with state_lock:
                state["startup_sync_error"] = str(exc)
            print(f"[startup][warn] deferred local sync failed: {exc}")
        finally:
            with state_lock:
                state["startup_sync_in_progress"] = False

    threading.Thread(target=worker, name="startup-local-sync", daemon=True).start()


def _merge_indexes(local_index: Dict[str, Any], online_index: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(local_index)
    merged.update(online_index)
    return merged

def _artist_title_key(artist: Any, title: Any) -> str:
    return build_artist_title_key(str(artist or ""), str(title or ""))


def _recommend_from_index(
    query_key: str,
    index: Dict[str, Any],
    history: List[str],
    local_track_map: Optional[Dict[str, str]] = None,
) -> List[tuple]:
    if query_key not in index:
        return []
    _, q_emb = index[query_key]
    history_set = set(history or [])
    current_local = local_track_map or {}
    candidates = []
    for k, (path_str, emb) in index.items():
        if k == query_key:
            continue
        if is_online_token(path_str):
            resolved_path = path_str
        elif k in current_local:
            resolved_path = current_local[k]
        else:
            continue
        if resolved_path in history_set:
            continue
        candidates.append((resolved_path, emb))
    if not candidates:
        return []
    cand_paths = [p for p, _ in candidates]
    cand_norm = np.stack([_normalize_vec(emb) for _, emb in candidates]).astype(np.float32)
    q_norm = _normalize_vec(q_emb)
    sims = cand_norm @ q_norm
    order = np.argsort(-sims)
    return [(cand_paths[int(i)], float(sims[int(i)]), float(sims[int(i)])) for i in order]


def _recommend_from_local_cache(query_key: str, history: List[str]) -> List[tuple]:
    cache = state["local_index_cache"]
    key_to_idx = cache.get("key_to_idx") or {}
    norm_embs = cache.get("norm_embs")
    if query_key not in key_to_idx or norm_embs is None:
        return []

    query_idx = key_to_idx[query_key]
    q_norm = norm_embs[query_idx]
    sims = norm_embs @ q_norm

    history_set = set(history or [])
    mask = np.ones(len(cache["paths"]), dtype=bool)
    mask[query_idx] = False
    if history_set:
        history_mask = [path not in history_set for path in cache["paths"]]
        mask &= np.asarray(history_mask, dtype=bool)
    if not bool(np.any(mask)):
        return []

    valid_idx = np.nonzero(mask)[0]
    valid_sims = sims[valid_idx]
    order = valid_idx[np.argsort(-valid_sims)]
    paths = cache["paths"]
    return [(paths[int(i)], float(sims[int(i)]), float(sims[int(i)])) for i in order.tolist()]


def _should_relax_recommend_history(body: "RecommendRequest", like_pool: List[tuple]) -> bool:
    return body.history_fallback == "relax" and bool(body.history) and not like_pool


def _find_index_key_by_path(index: Dict[str, Any], target_path: str) -> str:
    tp = str(target_path or "").strip()
    if not tp:
        return ""
    for k, (path_str, _) in index.items():
        if str(path_str) == tp:
            return k
    return ""


def _resolve_recommend_query_key(
    track_path_raw: str,
    is_online: bool,
    merged_index: Dict[str, Any],
    local_index: Dict[str, Any],
    catalog: Dict[str, Any],
    local_path_to_resource: Optional[Dict[str, str]] = None,
    local_song_key_to_resources: Optional[Dict[str, List[str]]] = None,
) -> str:
    # 直接命中
    direct = track_path_raw if is_online else str((local_path_to_resource or {}).get(track_path_raw) or "")
    if direct in merged_index:
        return direct
    if not is_online:
        return direct

    # 在线 token 未命中时，尝试通过 catalog 的 duplicate_of / artist+title 反查本地索引键
    item = catalog.get(track_path_raw) or {}
    duplicate_of = str(item.get("duplicate_of", "")).strip()
    if duplicate_of:
        if is_online_token(duplicate_of):
            if duplicate_of in merged_index:
                return duplicate_of
        else:
            resource_id = str((local_path_to_resource or {}).get(duplicate_of) or "")
            if resource_id in local_index:
                return resource_id
            k2 = _find_index_key_by_path(local_index, duplicate_of)
            if k2:
                return k2
    dedupe_key = _artist_title_key(item.get("artist", ""), item.get("name", ""))
    resource_ids = (local_song_key_to_resources or {}).get(dedupe_key) or []
    if len(resource_ids) == 1 and resource_ids[0] in local_index:
        return resource_ids[0]
    return direct


def save_config(cfg: Dict):
    """把配置写回 config.json，方便下次启动沿用。"""
    _write_config_file(cfg)


# ---------- 复合种子工具函数 ----------
def _load_seeds() -> List[Dict[str, Any]]:
    if SEED_PATH.exists():
        try:
            seeds = json.loads(SEED_PATH.read_text(encoding="utf-8"))
            # 兼容旧数据：补充负种子列表
            for s in seeds:
                s.setdefault("neg_track_paths", [])
                s.setdefault("seed_track_paths", s.get("pos_track_paths", s.get("seed_track_paths", [])))
            return seeds
        except Exception:
            return []
    return []


def _save_seeds(seeds: List[Dict[str, Any]]):
    SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SEED_PATH.with_name(f"{SEED_PATH.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(seeds, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(SEED_PATH)


def _unique_map_put(mapping: Dict[str, Optional[str]], key: str, value: str):
    if not key:
        return
    if key in mapping and mapping[key] != value:
        mapping[key] = None
    else:
        mapping[key] = value


def _seed_path_relocator(index: Dict[str, Any], local_track_map: Dict[str, str]):
    """
    复合种子保存的是播放路径；移动曲库后旧路径会失效。
    这里按 song_key、旧索引路径和标题兜底映射到当前 audio_dir 中的真实路径。
    """
    local_map = dict(local_track_map or {})
    current_paths = {str(p) for p in local_map.values() if p}
    old_path_to_current: Dict[str, str] = {}
    title_to_current: Dict[str, Optional[str]] = {}

    for song_key, current_path in local_map.items():
        current_path = str(current_path or "")
        if not song_key or not current_path:
            continue
        item = index.get(song_key)
        if item:
            old_path = str(item[0] or "")
            if old_path:
                old_path_to_current[old_path] = current_path
        old_path_to_current[current_path] = current_path
        _, _, title_part = str(song_key or "").partition(" - ")
        _unique_map_put(title_to_current, normalize_title_key(title_part), current_path)
        _unique_map_put(title_to_current, normalize_title_key(Path(current_path).stem), current_path)

    def resolve(path: Any) -> str:
        raw = str(path or "").strip()
        if not raw or is_online_token(raw):
            return raw
        if raw in current_paths:
            return raw
        hit = old_path_to_current.get(raw)
        if hit:
            return hit
        key = get_song_key(Path(raw))
        hit = local_map.get(key)
        if hit:
            return hit
        _, _, title_part = str(key or "").partition(" - ")
        for title in (title_part, Path(raw).stem):
            mapped = title_to_current.get(normalize_title_key(title))
            if mapped:
                return mapped
        return raw

    return resolve


def _relink_seed_paths_locked(seed: Dict[str, Any], index: Optional[Dict[str, Any]] = None, local_track_map: Optional[Dict[str, str]] = None) -> int:
    if not seed:
        return 0
    idx = index if index is not None else state.get("index", {})
    current_local = local_track_map if local_track_map is not None else (state.get("local_track_map") or _current_local_track_map_locked())
    resolve = _seed_path_relocator(idx or {}, current_local or {})
    changed = 0

    def relink_list(field: str):
        nonlocal changed
        values = seed.get(field)
        if not isinstance(values, list):
            return
        next_values = []
        seen = set()
        for value in values:
            resolved = resolve(value)
            if resolved != value:
                changed += 1
            if resolved and resolved not in seen:
                next_values.append(resolved)
                seen.add(resolved)
        if next_values != values:
            seed[field] = next_values

    relink_list("seed_track_paths")
    relink_list("pos_track_paths")
    relink_list("neg_track_paths")

    recs = seed.get("rec_cache")
    if isinstance(recs, list):
        for item in recs:
            if not isinstance(item, dict):
                continue
            raw = item.get("path")
            resolved = resolve(raw)
            if resolved != raw:
                item["path"] = resolved
                changed += 1
    return changed


def _relink_seeds_paths_locked(seeds: List[Dict[str, Any]], index: Optional[Dict[str, Any]] = None, local_track_map: Optional[Dict[str, str]] = None) -> int:
    return sum(_relink_seed_paths_locked(seed, index=index, local_track_map=local_track_map) for seed in seeds or [])


def _find_seed(seeds: List[Dict[str, Any]], seed_id: str) -> Optional[Dict[str, Any]]:
    for s in seeds:
        if s.get("id") == seed_id:
            return s
    return None


def _compute_seed_recs(
    seed: Dict[str, Any],
    index: Dict[str, Any],
    cfg: Optional[Dict[str, Any]] = None,
    local_track_map: Optional[Dict[str, str]] = None,
    local_path_to_resource: Optional[Dict[str, str]] = None,
    local_resource_map: Optional[Dict[str, str]] = None,
    semantic_verifier=None,
) -> List[Dict[str, Any]]:
    # 正负种子
    seed_tracks = seed.get("seed_track_paths") or seed.get("pos_track_paths") or []
    neg_tracks = seed.get("neg_track_paths", [])
    if not seed_tracks:
        return []
    seed_cfg = (cfg or {}).get("seed", {}) if cfg else {}
    tau_pos = float(seed_cfg.get("tau_pos", seed_cfg.get("tau", 20.0)))
    tau_neg = float(seed_cfg.get("tau_neg", seed_cfg.get("tau", 5.0)))
    tau_pos = max(1.0, tau_pos)
    tau_neg = max(1.0, tau_neg)
    lambda_neg = float(seed_cfg.get("lambda_neg", 1.0))
    lambda_neg = max(0.0, lambda_neg)
    path_to_resource = local_path_to_resource or {}

    def resolve_index_key(track_ref: Any) -> str:
        raw = str(track_ref or "")
        if is_online_token(raw):
            return raw
        resource_id = str(path_to_resource.get(raw) or "")
        if resource_id and resource_id in index:
            return resource_id
        # 只为历史复合种子和旧测试数据保留 song-key 读取兼容。
        legacy_key = get_song_key(Path(raw))
        return legacy_key if legacy_key in index else ""

    explicitly_negative_keys = {resolve_index_key(p) for p in neg_tracks}
    explicitly_negative_keys.discard("")
    seed_embs = []
    seed_refs = []
    seed_keys = []
    positive_keys = set()
    for p in seed_tracks:
        k = resolve_index_key(p)
        if k in index and k not in positive_keys and k not in explicitly_negative_keys:
            _, emb = index[k]
            if np.all(np.isfinite(emb)) and np.linalg.norm(emb) > 0:
                seed_embs.append(emb)
                seed_refs.append(str(p))
                seed_keys.append(k)
                positive_keys.add(k)
    seed["rec_diagnostics"] = {"policy_version": 2, "valid_positive": len(seed_embs),
                               "missing_positive": sum(resolve_index_key(p) not in index for p in set(seed_tracks)),
                               "conflicting_positive": sum(resolve_index_key(p) in explicitly_negative_keys for p in set(seed_tracks))}
    if not seed_embs:
        return []
    neg_embs = []
    negative_keys = set()
    for p in neg_tracks:
        k = resolve_index_key(p)
        if k in index and k not in negative_keys:
            _, emb = index[k]
            if np.all(np.isfinite(emb)) and np.linalg.norm(emb) > 0:
                neg_embs.append(emb)
                negative_keys.add(k)
    # 候选全集（不排除种子本身）
    cand_paths = []
    cand_embs = []
    cand_keys = []
    current_local = local_track_map or {}
    current_resources = local_resource_map or {}
    for index_key, (path_str, emb) in index.items():
        if not np.all(np.isfinite(emb)) or np.linalg.norm(emb) == 0:
            continue
        if is_online_token(path_str):
            cand_paths.append(path_str)
            cand_embs.append(emb)
            cand_keys.append(index_key)
            continue
        if index_key in current_resources:
            cand_paths.append(current_resources[index_key])
            cand_embs.append(emb)
            cand_keys.append(index_key)
        elif index_key in current_local:
            cand_paths.append(current_local[index_key])
            cand_embs.append(emb)
            cand_keys.append(index_key)
    if not cand_embs:
        return []
    cand_tensor = np.stack([_normalize_vec(e) for e in cand_embs]).astype(np.float32)  # [N, D]

    # 计算每个种子与所有候选的相似度矩阵 [S, N]
    seed_tensor = np.stack([_normalize_vec(e) for e in seed_embs]).astype(np.float32)  # [S, D]
    sims_matrix = seed_tensor @ cand_tensor.T  # [S, N]

    # 基于排名的衰减：排名越前，权重越大；避免平均导致四不像
    # decay = exp(-rank / tau)
    scores = np.zeros(cand_tensor.shape[0], dtype=np.float32)
    best_sim = np.full((cand_tensor.shape[0],), -1.0, dtype=np.float32)
    # Admission is independent of requested length and accumulated direction score.
    # Use the user's existing continuity floor, never silently relax it to fill k.
    floor = float(seed_cfg.get("min_similarity", ((cfg or {}).get("similarity") or {}).get("like_min", .975)))
    if not np.isfinite(floor) or not 0 <= floor <= 1:
        floor = .975
    admitted = np.zeros(cand_tensor.shape[0], dtype=bool)
    support_count = np.zeros(cand_tensor.shape[0], dtype=int)
    support_rows = []
    rank_limit = max(1, int(np.ceil(3 * tau_pos)))
    for row in sims_matrix:
        # rank: 0 是最高
        sorted_idx = np.argsort(-row, kind="stable")
        ranks = np.empty_like(sorted_idx)
        ranks[sorted_idx] = np.arange(len(row))
        decay = np.exp(-ranks.astype(np.float32) / tau_pos)
        scores += row * decay
        best_sim = np.maximum(best_sim, row)
        support = (row >= floor) & (ranks <= rank_limit)
        admitted |= support
        support_count += support
        support_rows.append(support)

    # 负向种子扣分
    negative_penalty = np.zeros_like(scores)
    negative_best = np.full_like(scores, -1)
    if neg_embs:
        neg_tensor = np.stack([_normalize_vec(e) for e in neg_embs]).astype(np.float32)
        neg_sims_matrix = neg_tensor @ cand_tensor.T  # [Nneg, N]
        for row in neg_sims_matrix:
            sorted_idx = np.argsort(-row, kind="stable")
            ranks = np.empty_like(sorted_idx)
            ranks[sorted_idx] = np.arange(len(row))
            decay = np.exp(-ranks.astype(np.float32) / tau_neg)
            # Similarity support keeps a dense negative neighbourhood meaningful;
            # max aggregation prevents duplicate negative examples multiplying it.
            similarity_support = np.clip((row - floor) / max(1 - floor, 1e-6), 0, 1)
            negative_penalty = np.maximum(negative_penalty, row * np.maximum(decay, similarity_support))
            negative_best = np.maximum(negative_best, row)
    scores -= lambda_neg * negative_penalty

    explicit_negative = np.array([key in negative_keys for key in cand_keys])
    # A positive example remains a valid branch even near a negative direction;
    # explicitly assigning the SAME recording to negative always takes precedence.
    positive_example = np.array([key in positive_keys for key in cand_keys])
    admitted |= positive_example
    negative_conflict = (negative_best >= floor) & (negative_best >= best_sim + .005) & ~positive_example
    admitted &= ~explicit_negative & ~negative_conflict

    # Direction score only; this is neither a probability nor a [0, 1] guarantee.
    scores = scores / len(seed_embs)
    k = max(1, int(seed.get("k", 50)))
    verification = {}
    if semantic_verifier is not None:
        pool = np.flatnonzero(admitted)
        keep, details, diagnostics, snapshot = semantic_verifier.review(
            list(zip(seed_keys, seed_refs)), [(cand_keys[i], cand_paths[i]) for i in pool],
            np.stack(support_rows)[:, pool], positive_example[pool])
        admitted[pool] = keep
        verification = {int(i): detail for i, detail in zip(pool, details)}
        seed["rec_diagnostics"].update(diagnostics)
        seed["_semantic_snapshot"] = snapshot
    eligible = np.flatnonzero(admitted)
    top_indices = eligible[np.argsort(-scores[eligible], kind="stable")[:k]].tolist()
    seed["rec_diagnostics"].update({"total_candidates": len(cand_paths), "eligible": len(eligible),
        "returned": len(top_indices), "requested": k, "min_similarity": floor,
        "rank_limit": rank_limit, "valid_negative": len(negative_keys),
        "explicit_negative": int(explicit_negative.sum()), "negative_conflicts": int(negative_conflict.sum())})
    recs = []
    for idx in top_indices:
        recs.append({"path": cand_paths[idx], "sim": float(scores[idx]), "best_sim": float(best_sim[idx]),
                     "support_seed": seed_refs[int(np.argmax(sims_matrix[:, idx]))],
                     "support_count": int(support_count[idx]), "negative_similarity": float(negative_best[idx]),
                     "admission_version": 2, **verification.get(idx, {})})
    return _order_seed_sequence(recs, cand_tensor[top_indices], cfg or {})


def _order_seed_sequence(recs: List[Dict[str, Any]], vectors: np.ndarray, cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Keep the candidate set/direction scores; plan only the listening order.

    Rolling recent support and bounded two-step lookahead within safe segments.
    Disconnected branches remain selectable, never become an automatic jump.
    No fixed session anchor, full-library pair matrix or inserted filler song.
    """
    if not recs:
        return []
    mat = np.asarray(vectors, dtype=np.float32)
    floor = float((cfg.get("seed") or {}).get("min_similarity", (cfg.get("similarity") or {}).get("like_min", .975)))
    if not np.isfinite(floor) or not 0 <= floor <= 1:
        floor = .975
    remaining = set(range(1, len(recs)))
    order = [0]
    segment = 0
    segment_start = 0
    details = [{"local_similarity": None, "recent_similarity": None, "weak_link": False, "segment": 0}]
    while remaining:
        # Scan all remaining rows for bridges; only the 12-row lookahead is dense.
        # A rank horizon can miss a safe bridge and falsely split a large list.
        available = np.array(sorted(remaining), dtype=int)
        local = mat[available] @ mat[order[-1]]
        safe = local >= floor
        if not np.any(safe):
            nxt = int(available[0])
            segment += 1
            segment_start = len(order)
            details.append({"local_similarity": None, "recent_similarity": None, "weak_link": False, "segment": segment})
            order.append(nxt)
            remaining.remove(nxt)
            continue
        available = available[safe]
        local = local[safe]
        recent_ids = order[max(segment_start, len(order) - 4):-1]
        recent = _recent_support(mat[available], mat[recent_ids]) if recent_ids else local
        bonus = .015 * np.clip((recent - (floor - .025)) / .025, 0, 1) if recent_ids else np.zeros_like(local)
        preliminary = local + bonus
        shortlist = np.argsort(-preliminary, kind="stable")[:12]
        future = local[shortlist].copy()
        if len(remaining) > 1:
            future_ids = np.array(sorted(remaining), dtype=int)
            next_sims = mat[available[shortlist]] @ mat[future_ids].T
            next_sims[available[shortlist, None] == future_ids[None, :]] = -np.inf
            future = np.max(next_sims, axis=1)
        # Future connectivity breaks near ties; it cannot justify a large local jump.
        value = preliminary[shortlist] + .08 * np.clip(future - local[shortlist], -.03, .03)
        selected = int(shortlist[int(np.argmax(value))])
        nxt = int(available[selected])
        details.append({"local_similarity": float(local[selected]), "recent_similarity": float(recent[selected]), "weak_link": False, "segment": segment})
        order.append(nxt)
        remaining.remove(nxt)
    result = [{**recs[idx], "sequence_order": position, "sequence_version": 2, **details[position]} for position, idx in enumerate(order)]
    for group in range(segment + 1):
        positions = [pos for pos, item in enumerate(result) if item["segment"] == group]
        wrap = float(mat[order[positions[-1]]] @ mat[order[positions[0]]])
        for pos in positions:
            result[pos]["wrap_safe"] = bool(wrap >= floor)
            result[pos]["wrap_similarity"] = wrap
    return result


def _recent_support(candidates: np.ndarray, recent: np.ndarray) -> np.ndarray:
    """Oldest→newest rolling window; recent rows have greater influence."""
    weights = np.power(.7, np.arange(len(recent) - 1, -1, -1, dtype=np.float32))
    weights /= weights.sum()
    return (candidates @ recent.T) @ weights


def _continuity_rewards(pool: List[tuple], recent_paths: List[str], index: Dict[str, Any], path_to_resource: Dict[str, str], cfg: Dict[str, Any], current: str) -> Dict[str, Dict[str, float]]:
    recent = []
    seen = {current}
    for path in reversed(recent_paths[-12:]):
        if path in seen:
            continue
        seen.add(path)
        key = path if is_online_token(path) else path_to_resource.get(path, "")
        if key in index:
            recent.append(_normalize_vec(index[key][1]))
        if len(recent) == 3:
            break
    if not recent or not pool:
        return {}
    candidates, positions = [], []
    for path, _, _ in pool:
        key = path if is_online_token(path) else path_to_resource.get(path, "")
        if key in index:
            candidates.append(_normalize_vec(index[key][1])); positions.append(path)
    if not candidates:
        return {}
    support = _recent_support(np.stack(candidates), np.stack(recent[::-1]))
    floor = float((cfg.get("similarity") or {}).get("like_min", .975))
    rewards = 1 + .25 * np.clip((support - (floor - .025)) / .025, 0, 1)
    return {path: {"continuity_reward": float(reward), "recent_similarity": float(sim)} for path, reward, sim in zip(positions, rewards, support)}


class ConfigUpdate(BaseModel):
    """定义 /config 接口可接收的字段（都是可选的部分更新）。"""
    similarity: Optional[Dict] = None
    dislike: Optional[Dict] = None
    dislike_correction: Optional[Dict] = None
    history: Optional[Dict] = None
    seed: Optional[Dict] = None  # 复合种子相关参数：tau_pos/tau_neg/lambda_neg
    model: Optional[Dict] = None
    online: Optional[Dict] = None
    audio_dir: Optional[str] = None
    audio_dirs: Optional[List[str]] = None
    download_dir: Optional[str] = None


class RecommendRequest(BaseModel):
    """定义 /recommend 请求体：歌曲路径、播放历史。"""
    track_path: str
    history: Optional[List[str]] = None  # 可选，最近听过的歌曲路径，用于去重
    history_fallback: Literal["relax", "strict"] = "relax"
    return_all_ranked: bool = False      # 是否返回全量排序列表（用于排行页）
    ranking_only: bool = False          # Read-only similarity browse: no feedback weighting/random draw.
    scope: Literal["local", "all"] = "local"
    recent_paths: Optional[List[str]] = None  # Rolling support only; never a fixed origin.
    intent: Literal["legacy", "continue", "recover", "change"] = "legacy"
    context_paths: List[str] = []
    excluded_paths: List[str] = []
    protected_paths: List[str] = []
    blocked_paths: List[str] = []
    session_context: Optional[dict] = None
    unavailable_paths: List[str] = []
    adjacent_floor: Optional[float] = None
    include_lower_adjacent: bool = False


class IndexRequest(BaseModel):
    """定义 /index 请求体：可选目录、是否覆盖重建。"""
    folder: Optional[str] = None  # 若提供则覆盖默认 AUDIO_DIR
    overwrite: bool = False       # 是否覆盖已有 .pt
    meta_only: bool = False       # 仅重建元数据，不重算向量


class TracksRescanRequest(BaseModel):
    """可选的新音乐目录；扫描成功后才提交目录与曲库。"""
    audio_dir: Optional[str] = None
    audio_dirs: Optional[List[str]] = None


class SeedUpsertRequest(BaseModel):
    id: Optional[str] = None
    name: str
    k: int = 50


class SeedTracksRequest(BaseModel):
    action: str  # add / remove
    tracks: List[str]
    target: Optional[str] = "pos"  # pos / neg


class SeedRefreshRequest(BaseModel):
    k: Optional[int] = None


class OnlineIndexRequest(BaseModel):
    token: str
    stream_url: str
    meta: Optional[Dict[str, Any]] = None
    acquire: Optional[Dict[str, Any]] = None


class OnlineExcludeRequest(BaseModel):
    token: str
    excluded: bool = True


class PathsUpdate(BaseModel):
    data_dir: Optional[str] = None
    model_dir: Optional[str] = None
    download_dir: Optional[str] = None


class RecommendationRateRebuildRequest(BaseModel):
    force: bool = True


def startup_event():
    # 服务启动时，仅加载已有索引；不自动扫描/补算
    total_t0 = time.perf_counter()
    need_legacy_migrate = legacy_import_allowed() and (
        ((not LOCAL_TRACKS_PATH.exists() or not LOCAL_EMBEDDINGS_PATH.exists()) and LEGACY_LOCAL_INDEX_PATH.exists())
        or ((not ONLINE_EMBEDDINGS_META_PATH.exists() or not ONLINE_EMBEDDINGS_PATH.exists()) and LEGACY_ONLINE_INDEX_PATH.exists())
    )
    if need_legacy_migrate:
        try:
            print("[startup] migrate legacy .pt index via worker")
            _run_worker(["migrate"])
        except Exception as exc:
            print(f"[startup][warn] legacy index migrate failed: {exc}")
    with state_lock:
        raw_scan_dir = str(state["config"].get("audio_dir") or state["audio_dir"] or "").strip()
        scan_dir = Path(raw_scan_dir) if raw_scan_dir else None
        state["audio_dir"] = scan_dir
        state["config"] = _ensure_online_config(state["config"])
        state["startup_sync_ready"] = False
        state["startup_sync_error"] = ""
        try:
            recovered_tag_commit = tag_commit_reconciler.recover_pending()
            TAG_EDIT_SERVICE.pipeline.recover_pending()
            state["tag_commit_reconcile_status"] = {
                "status": "recovered" if recovered_tag_commit else "idle",
                "error": "",
            }
            if recovered_tag_commit:
                print("[startup] recovered committed tag identity")
        except Exception as exc:
            state["tag_commit_reconcile_status"] = {
                "status": "conflict",
                "error": str(exc),
            }
            print(f"[startup][warn] committed tag identity recovery blocked: {exc}")
        if LOCAL_TRACKS_PATH.exists() and LOCAL_EMBEDDINGS_PATH.exists():
            step_t0 = time.perf_counter()
            _load_local_resource_index_locked()
            print(f"[startup] index load {time.perf_counter() - step_t0:.3f}s count={len(state['resource_index'])}")
            step_t0 = time.perf_counter()
            _seed_local_view_from_index_locked()
            _reconcile_track_identities_locked()
            print(f"[startup] provisional local view {time.perf_counter() - step_t0:.3f}s count={len(state['audio_files'])}")
        else:
            state["index"] = {}
            state["resource_index"] = {}
            state["audio_files"] = []
            state["local_track_map"] = {}
            state["local_path_to_key"] = {}
            state["local_path_to_resource"] = {}
            state["local_resource_map"] = {}
            state["local_song_key_to_resources"] = {}
        step_t0 = time.perf_counter()
        state["online_index"] = vector_store.load_online_index()
        print(f"[startup] online index load {time.perf_counter() - step_t0:.3f}s count={len(state['online_index'])}")
        step_t0 = time.perf_counter()
        state["online_catalog"] = vector_store.load_online_catalog()
        print(f"[startup] online catalog load {time.perf_counter() - step_t0:.3f}s count={len(state['online_catalog'])}")
    if scan_dir:
        _start_deferred_startup_sync(scan_dir)
    print(f"[startup] ready for requests in {time.perf_counter() - total_t0:.3f}s")


def shutdown_event():
    PRACTICE_SERVICE.close()
    MUSIC_ANALYSIS_SERVICE.close()
    STEM_SERVICE.close()
    try:
        SOUND_MAP_SERVICE.close()
    except (OSError, subprocess.SubprocessError):
        print("[shutdown][warn] sound map worker cleanup failed")
    try:
        _cancel_active_worker()
    except Exception as exc:
        print(f"[shutdown][warn] cancel worker failed: {exc}")


@app.get("/config")
def get_config():
    """返回当前配置（包含 audio_dir）。"""
    with state_lock:
        state["config"] = _ensure_online_config(state["config"])
        return copy.deepcopy(state["config"])


@app.post("/config")
def update_config(cfg: ConfigUpdate):
    """更新配置：只覆盖传入字段，并写回 config.json。"""
    should_rebuild_rate = False
    with state_lock:
        cfg_dict = _ensure_online_config(state["config"])
        old_roots = configured_roots(cfg_dict)
        requested = cfg.audio_dirs if cfg.audio_dirs is not None else ([cfg.audio_dir] if cfg.audio_dir is not None else old_roots)
        if roots_key(requested) != roots_key(old_roots):
            raise HTTPException(status_code=409, detail="请使用音乐库载入操作更改文件夹")
        old_similarity = json.dumps(cfg_dict.get("similarity") or {}, sort_keys=True, ensure_ascii=False)
        # 深度更新，只覆盖传入的字段
        for k, v in cfg.dict(exclude_none=True).items():
            if isinstance(v, dict):
                cfg_dict.setdefault(k, {}).update(v)
            else:
                cfg_dict[k] = v
        cfg_dict["download_dir"] = str(_resolve_package_path_or_default(str(cfg_dict.get("download_dir", "")), DOWNLOAD_DIR))
        cfg_dict["audio_dirs"] = old_roots
        cfg_dict["audio_dir"] = next(iter(old_roots), "")
        new_audio_dir = str(cfg_dict.get("audio_dir") or "").strip()
        new_similarity = json.dumps(cfg_dict.get("similarity") or {}, sort_keys=True, ensure_ascii=False)
        # 音乐目录切换统一由 /tracks/rescan 在锁外扫描并原子提交。
        if new_audio_dir:
            state["audio_dir"] = Path(new_audio_dir)
        if new_similarity != old_similarity:
            _mark_recommendation_rate_stale_locked("similarity-config-changed")
            should_rebuild_rate = True
        state["config"] = cfg_dict
        save_config(cfg_dict)
        resp = {"ok": True, "config": copy.deepcopy(cfg_dict)}
    if should_rebuild_rate:
        _maybe_start_recommendation_rate_rebuild("config-changed")
    return resp


@app.get("/paths")
def get_paths():
    with state_lock:
        cfg = _ensure_online_config(state["config"])
        download_dir = _resolve_package_path_or_default(str(cfg.get("download_dir", "")), DOWNLOAD_DIR)
        payload = runtime_paths_payload()
        payload.update({
            "audio_dir": str(cfg.get("audio_dir", "")),
            "audio_dirs": configured_roots(cfg),
            "download_dir": str(download_dir),
            "configured_model_dir": str((cfg.get("model") or {}).get("local_dir", "")),
        })
        return payload


@app.post("/paths")
def update_paths(req: PathsUpdate):
    with state_lock:
        cfg = _ensure_online_config(state["config"])
        if req.model_dir is not None:
            cfg.setdefault("model", {})["local_dir"] = str(req.model_dir).strip()
        if req.download_dir is not None:
            cfg["download_dir"] = str(_resolve_package_path_or_default(str(req.download_dir), DOWNLOAD_DIR))
        state["config"] = cfg
        save_config(cfg)
        download_dir = _resolve_package_path_or_default(str(cfg.get("download_dir", "")), DOWNLOAD_DIR)
        payload = runtime_paths_payload()
        payload.update({
            "audio_dir": str(cfg.get("audio_dir", "")),
            "audio_dirs": configured_roots(cfg),
            "download_dir": str(download_dir),
            "configured_model_dir": str((cfg.get("model") or {}).get("local_dir", "")),
        })
        return {
            "ok": True,
            "restart_required": False,
            "message": "绿色版运行数据固定在软件包 data/ 内，data_dir 请求已忽略" if req.data_dir else "",
            "paths": payload,
        }


@app.post("/index")
def rebuild_index(req: IndexRequest):
    """
    扫描目录并构建/增量索引。
    overwrite=False 时复用已有 .pt，只补缺少的歌曲；True 时全量重建。
    meta_only=True 时仅刷新元数据（已移除元数据功能，行为同补充索引）。
    """
    with state_lock:
        roots = configured_roots(state['config'])
        if not roots:
            raise HTTPException(status_code=400, detail="请先添加音乐文件夹")
        if req.folder and roots_key([req.folder]) != roots_key([roots[0]]):
            raise HTTPException(status_code=409, detail="请先载入音乐文件夹列表，再更新索引")
        if state.get('library_index_roots') or state.get('library_refresh_in_progress'):
            raise HTTPException(status_code=409, detail="音乐库正在更新，请稍后重试")
        if any(not Path(root).is_dir() for root in roots):
            raise HTTPException(status_code=400, detail="部分音乐文件夹不可用，旧索引已保留")
        state['library_index_roots'] = roots
    try:
        _run_worker(["build", "--folder", roots[0], "--folders-json", json.dumps(roots, ensure_ascii=False), *(["--overwrite"] if req.overwrite else [])])
        with state_lock:
            _load_local_resource_index_locked()
            _sync_local_view_locked(Path(roots[0]))
            return {"ok": True, "count": len(state["resource_index"]), "worker": WORKER_STATUS.copy()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"索引任务失败：{exc}")
    finally:
        with state_lock:
            state.pop('library_index_roots', None)


@app.get("/index/status")
def index_status():
    with state_lock:
        return {
            "local_count": len(state["resource_index"]),
            "online_count": len(state["online_index"]),
            "local_format": "numpy-json" if LOCAL_TRACKS_PATH.exists() and LOCAL_EMBEDDINGS_PATH.exists() else "missing",
            "online_format": "numpy-json" if ONLINE_EMBEDDINGS_META_PATH.exists() and ONLINE_EMBEDDINGS_PATH.exists() else "missing",
            "migration": _migration_state,
            "worker_status": WORKER_STATUS.copy(),
        }


@app.post("/index/cancel")
def cancel_index():
    try:
        return _cancel_active_worker()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/recommendation-rate/status")
def recommendation_rate_status():
    with state_lock:
        if not state.get("recommendation_rate_rebuild_running"):
            _load_recommendation_rate_locked()
        meta = dict(state["recommendation_rate_meta"] or {})
        meta["running"] = bool(state.get("recommendation_rate_rebuild_running"))
        meta["track_count"] = len(state.get("recommendation_rate") or {})
        meta["path"] = str(RECOMMENDATION_RATE_PATH)
        return meta


@app.post("/recommendation-rate/rebuild")
def recommendation_rate_rebuild(req: RecommendationRateRebuildRequest):
    started = _maybe_start_recommendation_rate_rebuild("manual", force=bool(req.force))
    with state_lock:
        meta = dict(state["recommendation_rate_meta"] or {})
        meta["running"] = bool(state.get("recommendation_rate_rebuild_running"))
        meta["started"] = bool(started)
        meta["path"] = str(RECOMMENDATION_RATE_PATH)
        return meta


class TagEditPrepareRequest(BaseModel):
    track_path: str
    resource_id: str
    updates: Dict[str, Any]


class TagEditCommitRequest(BaseModel):
    confirmation_id: str


class TagEditUndoRequest(BaseModel):
    transaction_id: str


def _tag_edit_available_locked():
    if getattr(sys, "frozen", False):
        raise HTTPException(403, "公开版资料写入仍待依赖许可与打包验收，目前仅在源码开发版开放")
    if ACTIVE_WORKER_PROCESS is not None or MUSIC_ANALYSIS_SERVICE.running or STEM_SERVICE.running or PRACTICE_SERVICE.running:
        raise HTTPException(409, "请等待音乐处理任务完成后保存资料")
    if state.get('library_refresh_in_progress') or state.get('startup_sync_in_progress'):
        raise HTTPException(409, "音乐库正在更新，请稍后保存")


def _tag_edit_resource_locked(track_path, resource_id):
    target = str(Path(track_path))
    actual = state.get('local_path_to_resource', {}).get(target)
    if not resource_id or actual != resource_id or not any(root_contains(root, target) for root in configured_roots(state['config'])):
        raise HTTPException(409, "歌曲已移出音乐库或身份发生变化，请重新打开")
    return target


def _tag_edit_error(exc):
    code = type(exc).__name__
    messages = {'ExternalFileChanged': '歌曲已被其他程序修改，请重新打开后保存',
                'UndoConflict': '歌曲已发生变化，无法撤销', 'TagVerificationFailed': '保存校验未通过，原歌曲已保留',
                'TagWriteUnsupported': '此格式暂不支持写入资料', 'PermissionError': '文件被占用或只读，请切换歌曲后重试'}
    return HTTPException(409, messages.get(code, str(exc) if isinstance(exc, ValueError) else '保存失败，原文件已保留'))


@app.get('/tracks/tags/capabilities')
def track_tag_capabilities():
    return {'editable': not getattr(sys, 'frozen', False), 'formats': ['mp3', 'flac', 'm4a', 'ogg']}


@app.post('/tracks/tags/prepare')
def prepare_track_tags(body: TagEditPrepareRequest):
    with WORKER_PROCESS_LOCK, state_lock:
        _tag_edit_available_locked()
        target = _tag_edit_resource_locked(body.track_path, body.resource_id)
        try:
            recovered = TAG_EDIT_SERVICE.pipeline.recover_pending()
            if any("pending" in str(item.get("status")) for item in recovered):
                raise ValueError("上一次资料修改尚未完成恢复，请稍后重试")
            return TAG_EDIT_SERVICE.prepare(target, body.resource_id, body.updates)
        except Exception as exc:
            raise _tag_edit_error(exc) from exc


@app.post('/tracks/tags/commit')
def commit_track_tags(body: TagEditCommitRequest):
    with WORKER_PROCESS_LOCK, state_lock:
        _tag_edit_available_locked()
        item = TAG_EDIT_SERVICE.pending.get(body.confirmation_id)
        if not item:
            raise HTTPException(409, '修改确认已过期，请重新保存')
        _tag_edit_resource_locked(str(item['path']), item['id'])
        try:
            return TAG_EDIT_SERVICE.commit(body.confirmation_id)
        except Exception as exc:
            raise _tag_edit_error(exc) from exc


@app.post('/tracks/tags/cancel')
def cancel_track_tags(body: TagEditCommitRequest):
    with state_lock:
        TAG_EDIT_SERVICE.cancel(body.confirmation_id)
    return {'ok': True}


@app.post('/tracks/tags/undo-info')
def inspect_track_tags_undo(body: TagEditUndoRequest):
    with state_lock:
        try:
            safe = TAG_EDIT_SERVICE.transactions._validate_transaction_id(body.transaction_id)
            manifest = json.loads((TAG_EDIT_SERVICE.transactions.snapshot_root / safe / 'manifest.json').read_text(encoding='utf-8'))
            target = _tag_edit_resource_locked(manifest['path'], manifest['resource_id'])
            return {'ok': True, 'trackPath': target}
        except HTTPException:
            raise
        except Exception as exc:
            raise _tag_edit_error(exc) from exc


@app.post('/tracks/tags/undo')
def undo_track_tags(body: TagEditUndoRequest):
    with WORKER_PROCESS_LOCK, state_lock:
        _tag_edit_available_locked()
        try:
            safe = TAG_EDIT_SERVICE.transactions._validate_transaction_id(body.transaction_id)
            manifest = json.loads((TAG_EDIT_SERVICE.transactions.snapshot_root / safe / 'manifest.json').read_text(encoding='utf-8'))
            _tag_edit_resource_locked(manifest['path'], manifest['resource_id'])
            return TAG_EDIT_SERVICE.undo(safe)
        except HTTPException:
            raise
        except Exception as exc:
            raise _tag_edit_error(exc) from exc


@app.post("/tracks/rescan")
def rescan_tracks(req: Optional[TracksRescanRequest] = None):
    """
    重新扫描当前音乐目录，只更新可浏览曲库和既有索引的路径关联。
    不启动模型、不计算 embedding；失败或过期结果不会覆盖 last-known-good 曲库。
    """
    with state_lock:
        state["library_refresh_generation"] = int(state.get("library_refresh_generation") or 0) + 1
        generation = state["library_refresh_generation"]
        state["library_refresh_in_progress"] = True
        state["library_refresh_error"] = ""
        if state.get('library_index_roots'):
            state['library_refresh_in_progress'] = False
            raise HTTPException(status_code=409, detail="索引任务正在进行，请完成后再修改音乐文件夹")
        configured_roots_snapshot = configured_roots(state['config'])
        explicit_roots = bool(req and (req.audio_dirs is not None or req.audio_dir is not None))
        requested = req.audio_dirs if req and req.audio_dirs is not None else [req.audio_dir] if req and req.audio_dir is not None else configured_roots_snapshot
        scan_roots_snapshot = normalize_roots(requested)
        configured_raw_dir = next(iter(configured_roots_snapshot), '')
        raw_dir = next(iter(scan_roots_snapshot), '')
        configured_identity = roots_key(configured_roots_snapshot)
        previous_count = len(state["audio_files"])
        previous_paths = {str(path) for path in state["audio_files"]}
        known_keys = dict(state.get("path_key_cache") or {})

    if not raw_dir:
        with state_lock:
            if generation == state["library_refresh_generation"]:
                state["library_refresh_in_progress"] = False
                state["library_refresh_error"] = "尚未选择音乐目录"
        return {
            "ok": False,
            "status": "not_configured",
            "committed": False,
            "generation": generation,
            "count": previous_count,
            "message": "请先选择音乐目录，再刷新音乐库。",
        }

    scan_dir = Path(raw_dir)
    if any(not Path(root).is_dir() for root in scan_roots_snapshot):
        with state_lock:
            if generation == state["library_refresh_generation"]:
                state["library_refresh_in_progress"] = False
                state["library_refresh_error"] = f"音乐目录不可用：{scan_dir}"
        return {
            "ok": False,
            "status": "unavailable",
            "committed": False,
            "generation": generation,
            "count": previous_count,
            "message": "音乐目录暂时不可用，已保留上一次曲库。请检查磁盘或重新选择目录。",
        }

    try:
        audio_files, path_key_cache = _scan_local_audio_snapshot(scan_roots_snapshot, known_keys)
        signature = _startup_sync_signature(scan_dir, audio_files, scan_roots_snapshot)
    except Exception as exc:
        message = f"扫描失败：{exc}"
        with state_lock:
            if generation == state["library_refresh_generation"]:
                state["library_refresh_in_progress"] = False
                state["library_refresh_error"] = message
        raise HTTPException(status_code=500, detail=f"{message}；已保留上一次曲库")

    with state_lock:
        current_identity = roots_key(configured_roots(state['config']))
        is_current = generation == state['library_refresh_generation'] and current_identity == configured_identity
        if not is_current:
            if generation == state["library_refresh_generation"]:
                state["library_refresh_in_progress"] = False
                state["library_refresh_error"] = "音乐目录已变化，本次扫描结果已丢弃"
            return {
                "ok": False,
                "status": "stale",
                "committed": False,
                "generation": generation,
                "count": len(state["audio_files"]),
                "message": "发现更新的刷新任务，本次扫描结果已丢弃。",
            }

        next_paths = {str(path) for path in audio_files}
        switching_library_root = bool(
            explicit_roots
            and roots_key(scan_roots_snapshot) != configured_identity
        )
        previous_paths_by_key: Dict[str, List[str]] = {}
        next_paths_by_key: Dict[str, List[str]] = {}
        for path_str, song_key in known_keys.items():
            if path_str in previous_paths and song_key:
                previous_paths_by_key.setdefault(song_key, []).append(path_str)
        for path_str, song_key in path_key_cache.items():
            if song_key:
                next_paths_by_key.setdefault(song_key, []).append(path_str)
        relocations = []
        if not switching_library_root:
            for song_key, old_paths in previous_paths_by_key.items():
                new_paths = next_paths_by_key.get(song_key) or []
                if len(old_paths) != 1 or len(new_paths) != 1:
                    continue
                old_path = old_paths[0]
                new_path = new_paths[0]
                if old_path != new_path and old_path not in next_paths:
                    relocations.append({"song_key": song_key, "from": old_path, "to": new_path})

        next_config = copy.deepcopy(state['config'])
        if explicit_roots:
            next_config['audio_dir'] = str(scan_dir)
            next_config['audio_dirs'] = scan_roots_snapshot
            try:
                save_config(next_config)
            except Exception as exc:
                state['library_refresh_in_progress'] = False
                state['library_refresh_error'] = '音乐文件夹配置保存失败，旧曲库已保留'
                raise HTTPException(status_code=500, detail=state['library_refresh_error']) from exc
        if explicit_roots:
            state["audio_dir"] = scan_dir
            state["config"] = next_config
        state["audio_files"] = audio_files
        state["path_key_cache"] = path_key_cache
        relocation_resource_ids = _build_root_relocation_hints_locked(
            scan_dir,
            audio_files,
            previous_root=configured_raw_dir if switching_library_root and len(configured_roots_snapshot) == len(scan_roots_snapshot) == 1 else None,
        ) if len(scan_roots_snapshot) == len(configured_roots_snapshot) == 1 else {}
        identity_result = _reconcile_track_identities_locked(
            allow_song_key_relocation=not switching_library_root,
            relocation_resource_ids=relocation_resource_ids,
        )
        index_relocated = _relink_resource_records_locked(
            allow_song_key_fallback=not switching_library_root,
        )
        _rebuild_local_index_cache_locked()
        _load_recommendation_rate_locked()
        state["startup_sync_ready"] = True
        state["startup_sync_error"] = ""
        state["library_refresh_in_progress"] = False
        state["library_refresh_error"] = ""
        identity_relocations = list(identity_result.get("relocations") or [])
        if identity_relocations:
            relocations = [
                {
                    "song_key": str(path_key_cache.get(str(item.get("to") or "")) or ""),
                    "resource_id": str(item.get("resource_id") or ""),
                    "from": str(item.get("from") or ""),
                    "to": str(item.get("to") or ""),
                }
                for item in identity_relocations
                if str(item.get("from") or "") and str(item.get("to") or "")
            ]
        relocated_from = {str(item.get("from") or "") for item in relocations}
        relocated_to = {str(item.get("to") or "") for item in relocations}
        added_count = len((next_paths - previous_paths) - relocated_to)
        removed_count = len((previous_paths - next_paths) - relocated_from)
        result = {
            "ok": True,
            "status": "ready",
            "committed": True,
            "audio_dirs": scan_roots_snapshot,
            "audio_dir": scan_roots_snapshot[0],
            "generation": generation,
            "count": len(audio_files),
            "added": added_count,
            "removed": removed_count,
            "relocated": len(relocations),
            "index_relocated": index_relocated,
            "relocations": relocations,
            "identity_created": int(identity_result.get("created") or 0),
            "identity_restored": int(identity_result.get("restored") or 0),
            "message": (
                f"已扫描 {len(audio_files)} 首歌曲"
                f"；新增 {added_count} 首，移除 {removed_count} 首"
                f"{f'，恢复 {len(relocations)} 首移动歌曲' if relocations else ''}。"
            ),
        }

    _save_startup_sync_state(signature)
    return result


def _analysis_snapshot(resource_id=None, only_path=None):
    with state_lock:
        identities = dict(state.get("track_identities_by_path") or {})
        indexed = dict(state.get("local_path_to_resource") or {})
        scanned = [str(path) for path in state.get("audio_files") or [] if only_path is None or str(path) == only_path]
        paths = {str((identities.get(path) or {}).get("resource_id") or indexed.get(path) or ""): path for path in scanned}
        scope = str(state.get("audio_dir") or "") + ":" + str(state.get("library_refresh_generation", 0))
    rows = []
    for rid, path in paths.items():
        if resource_id is not None and rid != resource_id:
            continue
        # Resource IDs are stable identifiers, never caller-supplied filesystem names.
        if not str(rid).replace("-", "").replace("_", "").isalnum():
            continue
        try:
            source = analysis_source_version(path)
        except OSError:
            source = "unavailable"
        rows.append({"id": rid, "path": str(path), "source": source, "scope": scope})
    return rows


def _create_music_analysis_service():
    from music_analysis_service import MusicAnalysisService
    return MusicAnalysisService(APP_HOME, DATA_DIR, _analysis_snapshot)


def _create_semantic_library():
    from semantic_library import SemanticLibrary
    return SemanticLibrary(APP_HOME, DATA_DIR / 'library/track-analysis/results.sqlite3')


def _create_stem_service():
    from stem_service import StemService
    return StemService(APP_HOME, DATA_DIR, _analysis_snapshot)


def _create_practice_store():
    from practice_analysis import PracticeAnalysisStore
    return PracticeAnalysisStore(DATA_DIR / 'library/practice-analysis')


def _create_practice_service():
    from practice_service import PracticeService
    return PracticeService(APP_HOME, DATA_DIR, _analysis_snapshot, STEM_SERVICE, PRACTICE_ANALYSIS_STORE)


MUSIC_ANALYSIS_SERVICE = DeferredService(_create_music_analysis_service)
SEED_SEMANTIC_VERIFIER = SeedSemanticVerifier(APP_HOME, DATA_DIR / 'library/track-analysis/results.sqlite3')
RECOMMEND_SEMANTIC_LIBRARY = DeferredService(_create_semantic_library)
RECOMMEND_VECTOR_CACHE = recommendation_engine.VectorCache()
STEM_SERVICE = DeferredService(_create_stem_service)
PRACTICE_ANALYSIS_STORE = DeferredService(_create_practice_store)
PRACTICE_SERVICE = DeferredService(_create_practice_service)


@app.get('/practice/analysis')
def practice_analysis_track(path: str):
    row = next(iter(_analysis_snapshot(only_path=path)), None)
    if not row:
        return {'status': 'unsupported', 'message': '请先播放音乐库中的本地歌曲。'}
    return PRACTICE_ANALYSIS_STORE.read(row['id'], row['source'])


class StemJobRequest(BaseModel):
    resource_id: str


class StemMixRequest(StemJobRequest):
    mix: Dict[str, Any]


class PracticeJobRequest(StemJobRequest):
    force: bool = False
    melody_only: bool = False
    melody_language: str = 'unspecified'


class PracticeVersionRequest(StemJobRequest):
    digest: str
    expected_digest: str


class PracticeMelodyReviewRequest(StemJobRequest):
    mode: str = 'off'


@app.post('/practice/melody/review')
def practice_melody_review(body: PracticeMelodyReviewRequest):
    try:
        return PRACTICE_SERVICE.review_melody(body.resource_id,body.mode)
    except ValueError as exc:
        raise HTTPException(409,str(exc))
    except Exception:
        raise HTTPException(503,'旋律复核暂未完成，原始分析保持原样。')


@app.get('/practice/melody/versions')
def practice_melody_versions(resource_id: str):
    try:
        return {'rows': PRACTICE_SERVICE.melody_versions(resource_id)}
    except ValueError as exc:
        raise HTTPException(409,str(exc))
    except Exception:
        raise HTTPException(503,'分析版本暂时无法读取，已有结果保持原样。')


@app.post('/practice/melody/version')
def practice_melody_version(body: PracticeVersionRequest):
    try:
        return PRACTICE_SERVICE.restore_melody_version(body.resource_id,body.digest,body.expected_digest)
    except ValueError as exc:
        raise HTTPException(409,str(exc))
    except Exception:
        raise HTTPException(503,'分析版本未能切换，已有结果保持原样。')


@app.get('/practice/track')
def practice_track(path: str):
    row = next(iter(_analysis_snapshot(only_path=path)), None)
    if not row:
        return {'status':'unsupported','preparation':PRACTICE_SERVICE.status(),'analysis':{'status':'unsupported'},'message':'请选择音乐库中的本地歌曲。'}
    try:
        return PRACTICE_SERVICE.track(row['id'])
    except ValueError as exc:
        raise HTTPException(409,str(exc))
    except Exception:
        raise HTTPException(503,'演奏数据暂时无法读取，已保存结果保持原样。')


@app.post('/practice/start')
def practice_start(body: PracticeJobRequest):
    with WORKER_PROCESS_LOCK:
        if ACTIVE_WORKER_PROCESS is not None or MUSIC_ANALYSIS_SERVICE.running:
            raise HTTPException(409,'推荐索引或音乐分析正在使用显卡，请等待完成。')
        with state_lock:
            if state.get('library_refresh_in_progress') or state.get('startup_sync_in_progress'):
                raise HTTPException(409,'曲库正在更新，请稍后准备演奏。')
        try:
            return PRACTICE_SERVICE.start(body.resource_id,body.force,body.melody_only,body.melody_language)
        except ValueError as exc:
            raise HTTPException(409,str(exc))
        except Exception:
            raise HTTPException(503,'演奏准备暂时无法启动，已保存结果保持原样。')


@app.post('/practice/cancel')
def practice_cancel():
    return PRACTICE_SERVICE.cancel()


@app.get('/practice/library')
def practice_library():
    try:
        return PRACTICE_SERVICE.library()
    except Exception:
        raise HTTPException(503,'演奏数据暂时无法读取，原有结果保留。')


@app.delete('/practice/track/{resource_id}')
def practice_delete(resource_id: str):
    try:
        return PRACTICE_SERVICE.delete(resource_id)
    except ValueError as exc:
        raise HTTPException(409,str(exc))
    except Exception:
        raise HTTPException(503,'演奏数据未能全部清理，请检查已保存结果后重试。')


@app.get('/stems/track')
def stems_track(path: str, validation_only: bool = False):
    row = next(iter(_analysis_snapshot(only_path=path)), None)
    if not row:
        return {'status': 'unsupported', 'task': STEM_SERVICE.status(), 'message': '请先播放音乐库中的本地歌曲。'}
    try:
        return STEM_SERVICE.validate(row['id']) if validation_only else STEM_SERVICE.track(row['id'])
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@app.get('/stems/task')
def stems_task():
    return STEM_SERVICE.status()


@app.get('/stems/library')
def stems_library():
    return STEM_SERVICE.library()


@app.post('/stems/start')
def stems_start(body: StemJobRequest):
    with WORKER_PROCESS_LOCK:
        if ACTIVE_WORKER_PROCESS is not None or MUSIC_ANALYSIS_SERVICE.running or PRACTICE_SERVICE.running:
            raise HTTPException(409, '推荐索引或音乐分析正在使用显卡，请等待完成。')
        with state_lock:
            if state.get('library_refresh_in_progress') or state.get('startup_sync_in_progress'):
                raise HTTPException(409, '音乐库正在更新，请稍后分离。')
        try:
            return STEM_SERVICE.start(body.resource_id)
        except ValueError as exc:
            raise HTTPException(409, str(exc))


@app.post('/stems/cancel')
def stems_cancel():
    if PRACTICE_SERVICE.running:
        return PRACTICE_SERVICE.cancel()
    return STEM_SERVICE.cancel()


@app.post('/stems/mix')
def stems_mix(body: StemMixRequest):
    if not _analysis_snapshot(body.resource_id):
        raise HTTPException(404, '歌曲不在当前音乐库中。')
    try:
        return STEM_SERVICE.store.mix(body.resource_id, body.mix)
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc))


@app.delete('/stems/track/{resource_id}')
def stems_delete(resource_id: str):
    if PRACTICE_SERVICE.running and PRACTICE_SERVICE.status().get('id') == resource_id:
        raise HTTPException(409,'请先取消这首歌曲的演奏准备。')
    try:
        return STEM_SERVICE.delete(resource_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    except OSError:
        raise HTTPException(409, '分轨文件正在使用或无法清理，请退出伴奏播放后重试。')


@app.get('/stems/audio/{resource_id}/{generation}/{name}')
def stems_audio(resource_id: str, generation: str, name: str):
    try:
        return FileResponse(STEM_SERVICE.media(resource_id, generation, name), media_type='audio/ogg',
                            headers={'Cache-Control': 'private, max-age=31536000, immutable'})
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@app.get('/stems/page/{resource_id}/{generation}/{name}')
def stems_page(resource_id: str, generation: str, name: str, page: int, sample_rate: int):
    from stem_playback import read_page
    try:
        return Response(read_page(STEM_SERVICE, resource_id, generation, name, page, sample_rate),
                        media_type='application/octet-stream', headers={'Cache-Control': 'no-store'})
    except ValueError as exc:
        raise HTTPException(409, str(exc))


class MusicAnalysisJobRequest(BaseModel):
    mode: Literal["missing", "selected", "all", "resume", "retry"] = "missing"
    ids: List[str] = []
    target: Literal["tags", "structure"] = "tags"


@app.get("/analysis/catalog")
def analysis_catalog():
    try:
        return MUSIC_ANALYSIS_SERVICE.catalog()
    except Exception:
        raise HTTPException(503, "音乐分析数据库暂时无法读取，未覆盖原有数据。")


@app.get("/analysis/track")
def analysis_track(resource_id: str):
    try:
        return MUSIC_ANALYSIS_SERVICE.track(resource_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    except Exception:
        raise HTTPException(503, "这首歌曲的分析数据暂时无法读取。")


@app.get("/analysis/task")
def analysis_task():
    return MUSIC_ANALYSIS_SERVICE.status()


@app.post("/analysis/start")
def analysis_start(body: MusicAnalysisJobRequest):
    with WORKER_PROCESS_LOCK:
        if STEM_SERVICE.running or PRACTICE_SERVICE.running:
            raise HTTPException(409, '分轨正在使用显卡，请等待完成或先取消。')
        if ACTIVE_WORKER_PROCESS is not None:
            raise HTTPException(409, "推荐索引正在处理，请等待完成再开始音乐分析。")
        with state_lock:
            busy = state.get("library_refresh_in_progress") or state.get("startup_sync_in_progress")
        if busy:
            raise HTTPException(409, "音乐库正在更新，请稍后开始处理。")
        try:
            return MUSIC_ANALYSIS_SERVICE.start(body.mode, body.ids, body.target)
        except ValueError as exc:
            raise HTTPException(409, str(exc))
        except Exception:
            raise HTTPException(503, "音乐分析组件或数据库暂时不可用，原有数据保留。")


@app.post("/analysis/control/{action}")
def analysis_control(action: Literal["pause", "resume", "cancel"]):
    try:
        return MUSIC_ANALYSIS_SERVICE.control(action)
    except ValueError as exc:
        raise HTTPException(409, str(exc))


_sound_map_inputs = {}
_sound_map_inputs_lock = threading.Lock()


def _sound_map_snapshot():
    # Copy references under the API lock; all numerical work happens outside it.
    with state_lock:
        cache = state.get("local_index_cache") or {}
        generation = str(cache.get("generation") or "")
        keys = list(cache.get("keys") or [])
        paths = list(cache.get("paths") or [])
        matrix = cache.get("norm_embs")
        online = list((state.get("online_index") or {}).items())
        total_count = len(state.get("audio_files") or []) + len(set(state.get("online_catalog") or {}) | {token for _, (token, _) in online})
    online_hash = hashlib.sha256()
    for key, (token, vector) in online:
        online_hash.update(str(key).encode())
        online_hash.update(str(token).encode())
        online_hash.update(np.asarray(vector, dtype='<f4').tobytes())
    signature = generation + online_hash.hexdigest()
    with _sound_map_inputs_lock:
        if _sound_map_inputs.get("generation") == signature:
            return {**_sound_map_inputs, "total_count": total_count}
        rows = [] if matrix is None else [np.asarray(matrix, dtype=np.float32)]
        dimension = matrix.shape[1] if matrix is not None and len(matrix) else None
        for _, (token, vector) in online:
            arr = np.asarray(vector, dtype=np.float32).reshape(-1)
            if token in keys or not arr.size or not np.isfinite(arr).all() or float(np.linalg.norm(arr)) <= 0:
                continue
            if dimension is not None and len(arr) != dimension:
                continue
            dimension = len(arr)
            keys.append(token)
            paths.append(token)
            rows.append((arr / np.linalg.norm(arr))[None, :])
        vectors = np.concatenate(rows) if rows else None
        _sound_map_inputs.clear()
        _sound_map_inputs.update(generation=signature, ids=keys, paths=paths, vectors=vectors)
        return {**_sound_map_inputs, "total_count": total_count}


@app.get("/sound-map")
def sound_map_status(retry: bool = False):
    snapshot = _sound_map_snapshot()
    if not snapshot["ids"]:
        return {"status": "empty", "message": "还没有可用的歌曲索引，请先在设置中更新索引。"}
    try:
        result = SOUND_MAP_SERVICE.status(snapshot["generation"], snapshot["ids"], snapshot["vectors"], retry)
    except (OSError, ValueError):
        return {"status": "error", "message": "声音地图暂时无法生成，请稍后重试。"}
    if result["status"] == "ready":
        result["paths"] = snapshot["paths"]
        result["unindexed_count"] = max(0, snapshot["total_count"] - len(snapshot["ids"]))
    return result


class SoundMapRelationsRequest(BaseModel):
    generation: str
    ids: List[str]
    anchor: Optional[str] = None
    compare: Optional[str] = None
    limit: int = 30


class SoundMapConnectionsRequest(BaseModel):
    generation: str
    anchor: str
    targets: List[str]


@app.post("/sound-map/connections")
def sound_map_connections(body: SoundMapConnectionsRequest):
    snapshot = _sound_map_snapshot()
    if snapshot["generation"] != body.generation:
        raise HTTPException(status_code=409, detail="曲库索引已更新。")
    if len(body.targets) > 10000:
        raise HTTPException(status_code=400, detail="查看范围过大。")
    positions = {key: i for i, key in enumerate(snapshot["ids"])}
    if body.anchor not in positions:
        raise HTTPException(status_code=404, detail="这首歌还没有可用索引。")
    ids = list(dict.fromkeys(key for key in body.targets if key in positions))
    values = np.einsum('ij,j->i', snapshot["vectors"][[positions[key] for key in ids]], snapshot["vectors"][positions[body.anchor]], optimize=False)
    return {"generation": body.generation, "ids": ids, "similarities": np.clip(values, -1, 1).round(7).tolist()}


@app.post("/sound-map/relations")
def sound_map_relations(body: SoundMapRelationsRequest):
    snapshot = _sound_map_snapshot()
    if snapshot["generation"] != body.generation:
        raise HTTPException(status_code=409, detail="曲库索引已更新，正在重新载入地图。")
    if len(body.ids) > 256 or body.limit < 1 or body.limit > 90:
        raise HTTPException(status_code=400, detail="请缩小本次查看范围。")
    keys, vectors = snapshot["ids"], snapshot["vectors"]
    positions = {key: i for i, key in enumerate(keys)}
    indices = []
    neighborhoods = {}
    if body.anchor:
        if body.anchor not in positions or (body.compare and body.compare not in positions):
            raise HTTPException(status_code=404, detail="这首歌还没有可用索引。")
        anchors = [positions[body.anchor]]
        if body.compare:
            anchors.append(positions[body.compare])
        # Single vector products, not a full-library square matrix.
        for anchor in anchors:
            sims = np.einsum('ij,j->i', vectors, vectors[anchor], optimize=False)
            order = np.lexsort((np.arange(len(keys)), -sims))
            near = [int(i) for i in order if i != anchor][:body.limit]
            neighborhoods[keys[anchor]] = [keys[i] for i in near]
            indices.extend([anchor, *near])
    indices.extend(positions[key] for key in body.ids if key in positions)
    indices = list(dict.fromkeys(indices))
    if len(indices) > 256:
        raise HTTPException(status_code=400, detail="请缩小本次查看范围。")
    if not indices:
        return {"generation": body.generation, "ids": [], "similarities": [], "missing": body.ids}
    selected = vectors[indices]
    similarities = np.clip(np.einsum('ik,jk->ij', selected, selected, optimize=False), -1, 1)
    np.fill_diagonal(similarities, 1.0)
    return {"generation": body.generation, "ids": [keys[i] for i in indices],
            "similarities": similarities.round(7).tolist(),
            "neighborhoods": neighborhoods,
            "missing": [key for key in body.ids if key not in positions]}


@app.post('/recommend/prepare')
def prepare_recommendation_features():
    """Explicit consumer warmup of existing results; no audio/model computation."""
    with state_lock:
        entries = list((state.get('local_resource_map') or {}).items())
    RECOMMEND_SEMANTIC_LIBRARY.warm(entries)
    return {'requested': bool(entries)}


@app.get("/tracks")
def list_tracks(scope: Literal["local", "all"] = "local"):
    """返回当前索引中的所有歌曲路径列表（与索引保持一致）。"""
    with state_lock:
        local_tracks = [str(p) for p in state["audio_files"]]
        local_items = []
        for path_str in local_tracks:
            identity = state.get("track_identities_by_path", {}).get(path_str) or {}
            local_items.append({
                "path": path_str,
                "resource_id": str(identity.get("resource_id") or ""),
                "song_key": str(state.get("local_path_to_key", {}).get(path_str) or state.get("path_key_cache", {}).get(path_str) or ""),
                "content_fingerprint": str(identity.get("content_fingerprint") or ""),
                "source": "local",
            })
        if scope == "local":
            return {
                "tracks": local_tracks,
                "items": local_items,
                "identity_status": copy.deepcopy(state.get("track_identity_status") or {}),
            }
        online_tracks = set(token for token, _ in state["online_index"].values())
        online_tracks.update(state["online_catalog"].keys())
        sorted_online = sorted(online_tracks)
        online_items = [
            {
                "path": token,
                "resource_id": token,
                "song_key": token,
                "content_fingerprint": "",
                "source": "online",
            }
            for token in sorted_online
        ]
        return {
            "tracks": local_tracks + sorted_online,
            "items": local_items + online_items,
            "identity_status": copy.deepcopy(state.get("track_identity_status") or {}),
        }


def _recommend_session_policy(body, song_key, index, resource_map, path_to_resource, cache, cfg, corr_cfg):
    # Resolve current paths once; never admit stale recordings outside the active library.
    active = {}
    for key, (path, vector) in index.items():
        resolved = path if is_online_token(path) else resource_map.get(key)
        if resolved:
            active[key] = (resolved, vector)
    def resolve(path):
        if not isinstance(path, str):
            return ''
        return path if is_online_token(path) else path_to_resource.get(path, '')
    contexts = [resolve(path) for path in body.context_paths[-64:]]
    recent = [resolve(path) for path in (body.recent_paths or [])[-3:]]
    entries = [(key, path) for key, (path, _) in active.items() if not is_online_token(path)]
    semantics, semantic_status = RECOMMEND_SEMANTIC_LIBRARY.get(entries)
    behavior = _load_listening_history_for_skip_fix() if body.intent == 'change' else {}
    with state_lock:
        rate_status = (state.get('recommendation_rate_meta') or {}).get('status') or 'missing'
        index_preparing=song_key not in active and bool(globals().get('ACTIVE_WORKER_PROCESS') is not None or state.get('library_refresh_in_progress') or state.get('startup_sync_in_progress'))
        fresh_rate = rate_status == 'ready'
        rate_tracks = dict(state.get('recommendation_rate') or {}) if fresh_rate and body.intent == 'change' else {}
    def correction(path):
        rec = _recommend_rate_fix_for_path(path, corr_cfg, rate_tracks)['fix'] if fresh_rate else 1.
        skip = _skip_rate_fix_for_path(path, corr_cfg, behavior)['fix']
        return float(np.sqrt(max(0., rec*skip)))
    settings = recommendation_engine.settings(cfg)
    supplied = getattr(body, 'session_context', None) or {}
    def supplied_list(key):
        value = supplied.get(key)
        return value if isinstance(value, list) else []
    def resolve_many(values, limit=8):
        return [value for path in (values if isinstance(values, list) else [])[-limit:]
                if isinstance(path, str) and (value := resolve(path)) in active]
    def bounded_number(value, maximum):
        try:
            value = float(value)
            return min(maximum, max(0., value)) if np.isfinite(value) else 0.
        except (ValueError, TypeError):
            return 0.
    session = dict(direction=resolve_many(supplied.get('direction_paths', []), 4),
        origin=resolve(supplied.get('origin_path','')),qualified=int(bounded_number(supplied.get('qualified',0),1000000)),
        repair_active=supplied.get('repair_active') is True,route=resolve_many(supplied.get('route_paths',[]),3),
        direction_strength=bounded_number(supplied.get('direction_strength', 0), .22),
        negatives=[dict(key=resolve(item.get('path', '')), positive=resolve_many(item.get('positive_paths', [])))
                   for item in supplied_list('negatives')[-16:] if isinstance(item, dict)],
        memories=[dict(keys=resolve_many(item.get('paths', []), 6), strength=bounded_number(item.get('strength', 0), 1.))
                  for item in supplied_list('memories')[-10:] if isinstance(item, dict)],
        plays=[active[k][0] for k in resolve_many(supplied.get('played_paths', []), 100)],
        repeat_flags=[flag is True for flag in supplied_list('repeat_flags')[-19:]])
    excluded_keys=resolve_many(getattr(body,'excluded_paths',[]),64)
    dependencies=[song_key,*contexts,*recent,*session['direction'],*excluded_keys]
    for item in session['negatives']:dependencies.extend([item['key'],*item['positive']])
    for item in session['memories']:dependencies.extend(item['keys'])
    needed={key for key in dependencies if key in active and key not in semantics}
    service=globals().get('MUSIC_ANALYSIS_SERVICE')
    analysis_inputs_pending=bool(service and callable(getattr(service,'pending_for',None)) and service.pending_for(needed))
    history = list(body.history or [])[-1000:]
    protected = list(body.protected_paths[-20:]) if body.protected_paths else history[-settings['recent_exclusion']:]
    if semantic_status in {'building','unavailable'} or index_preparing or analysis_inputs_pending:
        # A temporary cold cache is not evidence that this library has no MuQ.
        rows=[];reserve_rows=[]
        details=dict(reason='index_preparing' if index_preparing else 'analysis_preparing',fallback='analysis_preparing',model=None,
            preparation_status='index_building' if index_preparing else 'analysis_inputs_pending' if analysis_inputs_pending else 'analysis_building')
        reserve_details=dict(details)
    else:
        rows, details, reserve_rows, reserve_details = recommendation_engine.recommend_with_reserve(active, song_key, contexts, recent, history,
            protected, body.blocked_paths[-64:], cfg, semantic=semantics, mode=body.intent, correction=correction,
            prepared=RECOMMEND_VECTOR_CACHE.get(active),
            excluded=excluded_keys,
            session=session, tags=RECOMMEND_SEMANTIC_LIBRARY.features(semantics),
            unavailable=getattr(body, "unavailable_paths", []),recording_groups=cache.get('recording_groups'),explain=True)
        # Defense in depth: exact in-direction rejections never enter the enlarged reserve.
        if body.intent!='change':reserve_rows=[r for r in reserve_rows if r['path'] not in set(body.blocked_paths)]
        total=sum(r['probability'] for r in reserve_rows)
        for row in reserve_rows:row['probability']/=total
    if semantic_status == 'ready' and not RECOMMEND_SEMANTIC_LIBRARY.current(semantics):
        raise HTTPException(status_code=409, detail='歌曲分析刚发生变化，请重试推荐。')
    with state_lock:
        current_config = state.get('config', cfg)
        expected_online = {key: value for key, value in index.items() if is_online_token(value[0])} if body.scope == 'all' else {}
        current_online = state.get('online_index') or {}
        same_online = body.scope != 'all' or (len(expected_online) == len(current_online)
            and all(current_online.get(key) is value for key, value in expected_online.items()))
        if state['local_index_cache'] is not cache or any(current_config.get(key) != cfg.get(key) for key in
                ('recommendation', 'similarity', 'dislike', 'history', 'dislike_correction')) or not same_online:
            raise HTTPException(status_code=409, detail='音乐库或推荐设置刚发生变化，请重试推荐。')
    if details.get('current_index_available') is False and not index_preparing:details['preparation_status']='index_required'
    details['policy_build']='context-guard-v6'
    reserve_details['policy_build']='context-guard-v6'
    reserve_details['semantic_status']=semantic_status
    if reserve_details.get('current_index_available') is False and not index_preparing:reserve_details['preparation_status']='index_required'
    details['semantic_status'] = semantic_status
    details['semantic_available'] = len(semantics)
    details['semantic_coverage'] = len(semantics)/len(active) if active else 0.
    details['semantic_feature_status'] = 'ready' if semantics else 'building' if semantic_status == 'building' else 'empty'
    like, dislike = ([], rows) if body.intent == 'change' else (rows, [])
    selected = None
    if dislike:
        cursor = secrets.randbelow(10_000_000)/10_000_000
        selected = dislike[-1]
        for item in dislike:
            cursor -= item['probability']
            if cursor <= 0:
                selected = item
                break
        for item in dislike:
            item['selected'] = item is selected
    diagnostic = dict(request_id=uuid.uuid4().hex, policy='session-intent-v5', intent=body.intent,
        query_path=body.track_path,query_resource_id=song_key,
        index_generation=cache.get('generation', ''), scope=body.scope,
        parameters={key: copy.deepcopy(cfg.get(key) or {}) for key in ('recommendation','similarity','dislike','history','dislike_correction')},
        context_paths=body.context_paths[-64:], excluded_paths=getattr(body,"excluded_paths",[])[-64:], details=details)
    diagnostic['session_revision'] = 3
    diagnostic['recent_paths'] = (body.recent_paths or [])[-3:]
    reserve_diagnostic={**diagnostic,'details':{**reserve_details,'context_reserve':True}}
    reserve_data=dict(like_list=[] if body.intent=='change' else reserve_rows,
        dislike_list=reserve_rows if body.intent=='change' else [],diagnostic=reserve_diagnostic)
    return dict(reserve=reserve_data,like_next=like[0] if like else None, dislike_next=selected,
        like_list=like, dislike_list=dislike, diagnostic=diagnostic, missing=False,
        dislike_debug=dict(fallbackLevel=details.get('fallback'), selectedPath=selected['path'] if selected else '',
                           enabled=corr_cfg.get('enabled', True), recommendRateStatus=rate_status,
                           skipRateUpdatedAt=(behavior.get('recommendationBehaviorSummary') or {}).get('updatedAt', 0),
                           totalWeight=sum(item['weight'] for item in dislike)),
        stats=dict(total_candidates=len(active)-1, like_pool=len(like), dislike_pool=len(dislike),
                   weighted_dislike_pool=len(dislike), history_fallback_policy='quality-with-repeat-budget' if settings['allow_older_repeats'] else 'strict',
                   like_fallback_level=details.get('fallback'), like_next_out_of_range=False,
                   stop_reason=details['reason'], model=details.get('model'), semantic_status=semantic_status,
                   semantic_available=len(semantics), semantic_coverage=details['semantic_coverage']))


@app.post('/recommend/adjacent')
def adjacent_recommendation_api(body: RecommendRequest):
    with state_lock:
        cache=state['local_index_cache'];cfg=copy.deepcopy(state['config'])
        resources=dict(state.get('local_resource_map') or {})
        paths=dict(state.get('local_path_to_resource') or {})
        index=dict(cache.get('index_view') or {})
        online=dict(state.get('online_index') or {}) if body.scope=='all' else {}
        index.update(online)
    active={k:(p if is_online_token(p) else resources[k],v) for k,(p,v) in index.items() if is_online_token(p) or k in resources}
    current=next((k for k,(p,_) in active.items() if p==body.track_path),paths.get(body.track_path,body.track_path))
    if body.adjacent_floor is not None:
        if not np.isfinite(body.adjacent_floor) or not 0<=body.adjacent_floor<=1:raise HTTPException(status_code=400,detail='相邻下限无效。')
        cfg['recommendation']={**(cfg.get('recommendation') or {}),'adjacent_mert_floor':body.adjacent_floor}
    base_floor=recommendation_engine.settings(cfg)['adjacent_mert_floor']
    if getattr(body,'include_lower_adjacent',False):
        cfg['recommendation']={**(cfg.get('recommendation') or {}),'adjacent_mert_floor':0.}
    data=recommendation_engine.adjacent_candidates(active,current,cfg,RECOMMEND_VECTOR_CACHE.get(active))
    with state_lock:
        current_online=state.get('online_index') or {}
        if state['local_index_cache'] is not cache or (body.scope=='all' and
                (len(online)!=len(current_online) or any(current_online.get(k) is not v for k,v in online.items()))):
            raise HTTPException(status_code=409,detail='音乐库刚发生变化，请重试。')
    return {**data,'base_floor':base_floor,'policy':'adjacent-mert-v1','query_path':body.track_path,'index_generation':cache.get('generation','')}


def _rank_similar_tracks(body, song_key, index, resource_map, cache):
    active = {key: (path if is_online_token(path) else resource_map[key], vector)
              for key, (path, vector) in index.items() if is_online_token(path) or key in resource_map}
    # This view is a completed MERT query, not a semantic-cache fallback.
    result=similar_tracks.rank(active,song_key,prepared=RECOMMEND_VECTOR_CACHE.get(active))
    result['status']='ready'
    with state_lock:
        online = {k:v for k,v in index.items() if is_online_token(v[0])}
        current_online = state.get('online_index') or {}
        if state['local_index_cache'] is not cache or (body.scope == 'all' and
                (len(online) != len(current_online) or any(current_online.get(k) is not v for k,v in online.items()))):
            raise HTTPException(status_code=409, detail='音乐库刚发生变化，请重试。')
    return {**result, 'semantic_status': 'not_required', 'index_generation': cache.get('generation', '')}


@app.post("/recommend")
def recommend_api(body: RecommendRequest):
    """
    核心推荐接口：
    - track_path：要查询的歌曲（绝对路径）
    - intent：旧客户端兼容，或自然延续/接回此前感觉/换方向
    - history：可选，最近播放列表，用于去重
    """
    track_path_raw = body.track_path
    is_online = is_online_token(track_path_raw)
    with state_lock:
        track_path = Path(track_path_raw) if not is_online else None
        cfg = _ensure_online_config(copy.deepcopy(state["config"]))
        policy_intent = getattr(body, 'intent', 'legacy')
        corr_cfg = _dislike_correction_config(cfg) if not body.ranking_only and policy_intent in {'legacy', 'change'} else {}
        if not body.ranking_only and policy_intent in {'legacy', 'change'}:
            _load_recommendation_rate_locked()
        online_index = state["online_index"]
        local_resource_map = dict(state.get("local_resource_map") or {})
        local_path_to_resource = dict(state.get("local_path_to_resource") or {})
        local_song_key_to_resources = copy.deepcopy(state.get("local_song_key_to_resources") or {})
        local_cache = state["local_index_cache"]
        filtered_local_index = dict(local_cache.get("index_view") or {})
        local_index = filtered_local_index
        index = filtered_local_index if body.scope == "local" else _merge_indexes(filtered_local_index, online_index)
        history_list = body.history or []
        online_catalog = state["online_catalog"]

    local_query_key = ""
    if not is_online:
        local_query_key = local_path_to_resource.get(track_path_raw) or ""
    if (not is_online) and (not local_query_key or local_query_key not in local_resource_map):
        raise HTTPException(status_code=404, detail=f"歌曲不存在：{track_path}")
    if is_online and body.scope == "local":
        if policy_intent != 'legacy' and not body.ranking_only:
            return _recommend_session_policy(body, track_path_raw, index, local_resource_map,
                                             local_path_to_resource, local_cache, cfg, corr_cfg)
        return {
            "like_next": None,
            "dislike_next": None,
            "like_list": [],
            "dislike_list": [],
            "stats": {"total_candidates": 0, "like_pool": 0, "dislike_pool": 0},
            "missing": True,
        }

    t0 = time.perf_counter()

    if is_online and (policy_intent != 'legacy' or body.ranking_only):
        # Only the actual online token/path identifies this recording; catalog titles cannot proxy it.
        song_key = next((key for key, (path, _) in index.items() if path == track_path_raw), track_path_raw)
    else:
        song_key = _resolve_recommend_query_key(
            track_path_raw=track_path_raw,
            is_online=is_online,
            merged_index=index,
            local_index=local_index,
            catalog=online_catalog,
            local_path_to_resource=local_path_to_resource,
            local_song_key_to_resources=local_song_key_to_resources,
        )
    if local_query_key:
        song_key = local_query_key
    if policy_intent != 'legacy' and not body.ranking_only:
        return _recommend_session_policy(body, song_key, index, local_resource_map,
                                         local_path_to_resource, local_cache, cfg, corr_cfg)
    if song_key not in index:
        now = time.time()
        last = _missing_log_ts.get(song_key, 0)
        if now - last > 5:
            print(f"[recommend][missing] skip {track_path_raw} (not in index, suppress <5s dup)")
            _missing_log_ts[song_key] = now
        return {
            "like_next": None,
            "dislike_next": None,
            "like_list": [],
            "dislike_list": [],
            "stats": {"total_candidates": 0, "like_pool": 0, "dislike_pool": 0},
            "missing": True,
        }

    if body.ranking_only:
        return _rank_similar_tracks(body, song_key, index, local_resource_map, local_cache)

    if body.scope == "local":
        recs = _recommend_from_local_cache(song_key, history_list)
    else:
        recs = _recommend_from_index(song_key, index, history_list, local_track_map=local_resource_map)

    # 服务端去重（历史 / 自身），保持相似度排序
    allow_dup = cfg.get("history", {}).get("allow_duplicates", False)
    history_set = set(history_list)
    filtered: List[tuple] = []
    for p, s1, s2 in recs:
        if track_path_raw == p:
            continue
        if (not allow_dup) and (p in history_set):
            continue
        filtered.append((p, s1, s2))

    # 相似度区间
    like_min = cfg.get("similarity", {}).get("like_min", 0.0)
    like_max = cfg.get("similarity", {}).get("like_max", 1.0)
    dislike_min = cfg.get("dislike", {}).get("min_sim", 0.0)
    dislike_max = cfg.get("dislike", {}).get("max_sim", 1.0)
    like_pool = [(p, s1, s2) for p, s1, s2 in filtered if like_min <= s1 <= like_max]
    dislike_pool = [(p, s1, s2) for p, s1, s2 in filtered if dislike_min <= s1 <= dislike_max]
    like_fallback_level = "strict"
    like_pool_for_response = like_pool

    if _should_relax_recommend_history(body, like_pool):
        if body.scope == "local":
            recs_no_history = _recommend_from_local_cache(song_key, [])
        else:
            recs_no_history = _recommend_from_index(song_key, index, [], local_track_map=local_resource_map)
        filtered_no_history: List[tuple] = []
        for p, s1, s2 in recs_no_history:
            if track_path_raw == p:
                continue
            filtered_no_history.append((p, s1, s2))
        like_pool_relaxed_history = [
            (p, s1, s2) for p, s1, s2 in filtered_no_history
            if like_min <= s1 <= like_max
        ]
        if like_pool_relaxed_history:
            like_pool = like_pool_relaxed_history
            like_pool_for_response = like_pool_relaxed_history
            like_fallback_level = "ignore_history"

    skip_history = _load_listening_history_for_skip_fix()
    weighted_dislike, weighted_dislike_next, dislike_debug = _weighted_dislike_pool(dislike_pool, corr_cfg, skip_history)
    continuity = _continuity_rewards(like_pool_for_response, body.recent_paths or [], index, local_path_to_resource, cfg, track_path_raw)
    like_total_weight = sum((1 / (i + 1)) * continuity.get(item[0], {}).get("continuity_reward", 1) for i, item in enumerate(like_pool_for_response))

    # like_next is the legacy single-item fallback; renderer draws once from
    # like_list using harmonic rank × bounded rolling support. Dislike stays authoritative here.
    like_next = like_pool[0] if like_pool else (filtered[0] if filtered else None)
    if not like_pool and like_next:
        like_fallback_level = "nearest_out_of_range"
    elif not like_next:
        like_fallback_level = "empty"
    dislike_next = weighted_dislike_next or (filtered[-1] if filtered else None)

    def pack(rec):
        if not rec:
            return None
        p, s1, s2 = rec
        return {"path": p, "sim": s1, "sim_secondary": s2}

    def pack_list(pool, limit=None):
        out = []
        items = pool if limit is None else pool[:limit]
        for item in items:
            if isinstance(item, dict):
                out.append(item)
                continue
            p, s1, s2 = item
            out.append({"path": p, "sim": s1, "sim_secondary": s2})
        return out

    like_response = pack_list(like_pool_for_response)
    for i, item in enumerate(like_response):
        item.update(continuity.get(item["path"], {"continuity_reward": 1.0}))
        item["probability"] = (item["continuity_reward"] / (i + 1)) / like_total_weight if like_total_weight else 0
    resp = {
        "like_next": pack(like_next),
        "dislike_next": pack(dislike_next),
        "like_list": like_response,
        "dislike_list": pack_list(weighted_dislike),
        "dislike_debug": dislike_debug,
        "diagnostic": {
            "request_id": uuid.uuid4().hex,
            "policy": "harmonic-rank-rolling-support-v1",
            "index_generation": local_cache.get("generation", ""),
            "scope": body.scope,
            "history_count": len(history_list),
            "recent_requested_count": min(3, len(body.recent_paths or [])),
            "parameters": {key: copy.deepcopy(cfg.get(key) or {}) for key in ("similarity", "dislike", "history", "dislike_correction")},
        },
        "stats": {
            "total_candidates": len(filtered),
            "like_pool": len(like_pool_for_response),
            "dislike_pool": len(dislike_pool),
            "weighted_dislike_pool": len(weighted_dislike),
            "history_fallback_policy": body.history_fallback,
            "like_fallback_level": like_fallback_level,
            "like_next_out_of_range": bool(like_next and not like_pool),
        },
    }
    if body.return_all_ranked:
        resp["all_ranked"] = [{"path": p, "sim": s1, "sim_secondary": s2} for p, s1, s2 in filtered]
    elapsed = time.perf_counter() - t0
    track_name = track_path_raw if is_online else track_path.name
    like_name = like_next[0] if like_next else "None"
    dislike_name = dislike_next[0] if dislike_next else "None"
    print(f"[recommend] in={track_name} | like={like_name} | dislike={dislike_name} | {elapsed:.3f}s")
    return resp


@app.post("/online/index")
def online_index_upsert(req: OnlineIndexRequest):
    token = str(req.token or "").strip()
    if not is_online_token(token):
        raise HTTPException(status_code=400, detail="在线歌曲标识无效")
    if not req.stream_url.startswith("http"):
        raise HTTPException(status_code=400, detail="播放链接无效")
    meta = req.meta or {}
    source = str(meta.get("source", "")).strip()
    song_id = str(meta.get("songId", "")).strip()
    name = str(meta.get("name", "")).strip()
    artist = str(meta.get("artist", "")).strip()
    dedupe_key = _artist_title_key(meta.get("artist", ""), meta.get("name", ""))
    log_base = f"token={token} source={source or '-'} songId={song_id or '-'} name={name or '-'} artist={artist or '-'} dedupe_key={dedupe_key or '-'}"
    print(f"[online-index][request] {log_base}")
    with state_lock:
        cfg = _ensure_online_config(state["config"].copy())
        exclude = set(cfg.get("online", {}).get("exclude_tokens", []))
        if token in exclude:
            print(f"[online-index][skip] excluded {log_base}")
            return {"ok": False, "skipped": True, "reason": "excluded"}
        if dedupe_key:
            # 本地库去重：artist + title 命中则跳过
            if dedupe_key in state["index"]:
                existed_path = state["index"][dedupe_key][0]
                catalog = state["online_catalog"]
                old = catalog.get(token, {})
                catalog[token] = {
                    **old,
                    "token": token,
                    "source": source or old.get("source", ""),
                    "songId": song_id or old.get("songId", ""),
                    "name": name or old.get("name", ""),
                    "artist": artist or old.get("artist", ""),
                    "album": (req.meta or {}).get("album", old.get("album", "")),
                    "duration": (req.meta or {}).get("duration", old.get("duration", 0)),
                    "cover": (req.meta or {}).get("cover", old.get("cover", "")),
                    "qualities": (req.meta or {}).get("qualities", old.get("qualities", [])),
                    "defaultQuality": (req.meta or {}).get("defaultQuality", old.get("defaultQuality", "320k")),
                    "acquire": req.acquire or old.get("acquire", {}),
                    "indexed": False,
                    "indexExcluded": False,
                    "duplicate_of": existed_path,
                    "dedupe_key": dedupe_key,
                    "lastPlayAt": time.time(),
                }
                state["online_catalog"] = catalog
                vector_store.save_online_catalog(catalog)
                print(f"[online-index][skip] duplicate_local {log_base} duplicate_of={existed_path}")
                return {
                    "ok": False,
                    "skipped": True,
                    "reason": "duplicate_artist_title",
                    "duplicate_of": existed_path,
                }
            # 在线库去重：artist + title 命中其他 token 则跳过
            for t, item in state["online_catalog"].items():
                if t == token:
                    continue
                item_key = _artist_title_key(item.get("artist", ""), item.get("name", ""))
                if item_key and item_key == dedupe_key:
                    catalog = state["online_catalog"]
                    old = catalog.get(token, {})
                    catalog[token] = {
                        **old,
                        "token": token,
                        "source": source or old.get("source", ""),
                        "songId": song_id or old.get("songId", ""),
                        "name": name or old.get("name", ""),
                        "artist": artist or old.get("artist", ""),
                        "album": (req.meta or {}).get("album", old.get("album", "")),
                        "duration": (req.meta or {}).get("duration", old.get("duration", 0)),
                        "cover": (req.meta or {}).get("cover", old.get("cover", "")),
                        "qualities": (req.meta or {}).get("qualities", old.get("qualities", [])),
                        "defaultQuality": (req.meta or {}).get("defaultQuality", old.get("defaultQuality", "320k")),
                        "acquire": req.acquire or old.get("acquire", {}),
                        "indexed": False,
                        "indexExcluded": False,
                        "duplicate_of": t,
                        "dedupe_key": dedupe_key,
                        "lastPlayAt": time.time(),
                    }
                    state["online_catalog"] = catalog
                    vector_store.save_online_catalog(catalog)
                    print(f"[online-index][skip] duplicate_online {log_base} duplicate_of={t}")
                    return {
                        "ok": False,
                        "skipped": True,
                        "reason": "duplicate_artist_title",
                        "duplicate_of": t,
                    }
    t0 = time.perf_counter()
    try:
        _run_worker(["online-upsert", "--token", token, "--stream-url", req.stream_url])
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"在线索引任务失败：{exc}")
    embed_cost = time.perf_counter() - t0
    with state_lock:
        online_idx = vector_store.load_online_index()
        existed_before = token in online_idx
        state["online_index"] = online_idx
        catalog = state["online_catalog"]
        old = catalog.get(token, {})
        catalog[token] = {
            **old,
            "token": token,
            "source": (req.meta or {}).get("source", old.get("source", "")),
            "songId": (req.meta or {}).get("songId", old.get("songId", "")),
            "name": (req.meta or {}).get("name", old.get("name", "")),
            "artist": (req.meta or {}).get("artist", old.get("artist", "")),
            "album": (req.meta or {}).get("album", old.get("album", "")),
            "duration": (req.meta or {}).get("duration", old.get("duration", 0)),
            "cover": (req.meta or {}).get("cover", old.get("cover", "")),
            "qualities": (req.meta or {}).get("qualities", old.get("qualities", [])),
            "defaultQuality": (req.meta or {}).get("defaultQuality", old.get("defaultQuality", "320k")),
            "acquire": req.acquire or old.get("acquire", {}),
            "indexed": True,
            "indexExcluded": False,
            "duplicate_of": "",
            "dedupe_key": dedupe_key,
            "lastPlayAt": time.time(),
        }
        state["online_catalog"] = catalog
        vector_store.save_online_catalog(catalog)
        print(
            f"[online-index][ok] {log_base} "
            f"token_existed={existed_before} online_index_size={len(online_idx)} online_catalog_size={len(catalog)} "
            f"embed_sec={embed_cost:.3f}"
        )
    return {"ok": True, "token": token, "worker": WORKER_STATUS.copy()}


@app.post("/online/exclude")
def online_exclude(req: OnlineExcludeRequest):
    token = str(req.token or "").strip()
    if not is_online_token(token):
        raise HTTPException(status_code=400, detail="在线歌曲标识无效")
    with state_lock:
        cfg = _ensure_online_config(state["config"])
        online_cfg = cfg.setdefault("online", {})
        exclude = set(online_cfg.get("exclude_tokens", []))
        if req.excluded:
            exclude.add(token)
        else:
            exclude.discard(token)
        online_cfg["exclude_tokens"] = sorted(exclude)
        state["config"] = cfg
        save_config(cfg)

        catalog = state["online_catalog"]
        if token in catalog:
            catalog[token]["indexExcluded"] = bool(req.excluded)
            if req.excluded:
                catalog[token]["indexed"] = False
            vector_store.save_online_catalog(catalog)

        if req.excluded and token in state["online_index"]:
            state["online_index"].pop(token, None)
            vector_store.save_online_index(state["online_index"])
    return {"ok": True, "token": token, "excluded": req.excluded}


@app.get("/online/catalog")
def online_catalog():
    with state_lock:
        return {"catalog": state["online_catalog"]}


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": SERVICE_ID,
        "protocol_version": SERVICE_PROTOCOL_VERSION,
        "features_signature": FEATURE_SELECTION['signature'],
        "features_error": FEATURE_SELECTION['error'],
        "model_loaded": False,
        "api_pid": __import__("os").getpid(),
        "data_dir": str(DATA_DIR),
        "model_dir": str(MODEL_DIR),
        "index_ready": bool(state.get("resource_index")),
        "local_index_count": len(state.get("resource_index") or {}),
        "online_index_count": len(state.get("online_index") or {}),
        "worker_status": WORKER_STATUS.copy(),
        "active_tasks": [name for name, active in (
            ("推荐索引", bool(WORKER_STATUS.get("running"))),
            ("歌曲分析", MUSIC_ANALYSIS_SERVICE.running),
            ("分轨", STEM_SERVICE.running),
            ("演奏分析", PRACTICE_SERVICE.running),
            ("音乐库刷新", bool(state.get("library_refresh_in_progress"))),
        ) if active],
        "startup_sync": {
            "ready": bool(state.get("startup_sync_ready")),
            "error": str(state.get("startup_sync_error") or ""),
        },
    }


# ------------- 复合种子 API -------------

@app.get("/seeds")
def list_seeds():
    with state_lock:
        seeds = _load_seeds()
        changed = _relink_seeds_paths_locked(seeds, state["index"], _current_local_track_map_locked())
        if changed:
            _save_seeds(seeds)
    return {"seeds": seeds}


@app.post("/seeds")
def upsert_seed(req: SeedUpsertRequest):
    with state_lock:
        seeds = _load_seeds()
        changed = _relink_seeds_paths_locked(seeds, state["index"], _current_local_track_map_locked())
        if req.id:
            seed = _find_seed(seeds, req.id)
            if not seed:
                raise HTTPException(status_code=404, detail="seed not found")
            seed["name"] = req.name
            seed["k"] = int(req.k)
            seed["updated_at"] = time.time()
            changed += 1
        else:
            new_seed = {
                "id": str(uuid.uuid4()),
                "name": req.name,
                "k": int(req.k),
                "seed_track_paths": [],
                "rec_cache": [],
                "updated_at": time.time(),
            }
            seeds.append(new_seed)
            changed += 1
        if changed:
            _save_seeds(seeds)
    return {"ok": True, "seeds": seeds}


@app.post("/seeds/{seed_id}/tracks")
def modify_seed_tracks(seed_id: str, req: SeedTracksRequest):
    action = req.action.lower()
    if action not in {"add", "remove"}:
        raise HTTPException(status_code=400, detail="action must be add/remove")
    with state_lock:
        seeds = _load_seeds()
        changed = _relink_seeds_paths_locked(seeds, state["index"], _current_local_track_map_locked())
        seed = _find_seed(seeds, seed_id)
        if not seed:
            raise HTTPException(status_code=404, detail="seed not found")
        target = "neg_track_paths" if (req.target and req.target.lower() == "neg") else "seed_track_paths"
        seed.setdefault("neg_track_paths", [])
        seed.setdefault("seed_track_paths", seed.get("pos_track_paths", seed.get("seed_track_paths", [])))
        paths = set(seed.get(target, []))
        if action == "add":
            paths.update(req.tracks)
        else:
            paths.difference_update(req.tracks)
        seed[target] = list(paths)
        seed["rec_cache"] = []  # 标记需刷新
        seed["updated_at"] = time.time()
        changed += 1
        _save_seeds(seeds)
    return {"ok": True, "seed": seed}


@app.post("/seeds/{seed_id}/refresh")
def refresh_seed(seed_id: str, req: SeedRefreshRequest):
    with state_lock:
        if not state.get("startup_sync_ready"):
            raise HTTPException(status_code=409, detail="音乐库尚未完成载入。请刷新音乐库后重试，已有推荐结果已保留。")
        seeds = _load_seeds()
        local_track_map = _current_local_track_map_locked()
        _relink_seeds_paths_locked(seeds, state["index"], local_track_map)
        seed = _find_seed(seeds, seed_id)
        if not seed:
            raise HTTPException(status_code=404, detail="seed not found")
        if not (seed.get("seed_track_paths") or seed.get("pos_track_paths")):
            raise HTTPException(status_code=400, detail="请先添加喜欢方向的歌曲。")
        original = json.dumps(seed, sort_keys=True, ensure_ascii=False)
        working = copy.deepcopy(seed)
        if req.k is not None:
            working["k"] = int(req.k)
        cache = state["local_index_cache"]
        online = dict(state["online_index"])
        index = _merge_indexes(cache.get("index_view") or {}, online)
        config = copy.deepcopy(state["config"])
        path_to_resource = dict(state.get("local_path_to_resource") or {})
        resource_map = dict(state.get("local_resource_map") or {})
    # Planning must not hold the shared API lock. Vectors are immutable snapshots.
    try:
        recs = _compute_seed_recs(working, index, config, local_track_map=local_track_map,
            local_path_to_resource=path_to_resource, local_resource_map=resource_map,
            semantic_verifier=SEED_SEMANTIC_VERIFIER)
    except SeedSemanticError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    semantic_snapshot = working.pop("_semantic_snapshot", None)
    working.setdefault("rec_diagnostics", {}).update({"index_generation": cache.get("generation", ""),
        "parameters": {"seed": config.get("seed", {}), "similarity": config.get("similarity", {})}})
    if not recs and not working.get("rec_diagnostics", {}).get("valid_positive"):
        if working.get("rec_diagnostics", {}).get("conflicting_positive"):
            raise HTTPException(status_code=409, detail="喜欢的歌曲也被列为排除，且没有其他有效喜欢方向。请先解决冲突；已有结果已保留。")
        raise HTTPException(status_code=409, detail="当前喜欢方向的歌曲没有可用推荐向量。请检查歌曲是否仍在曲库并已完成索引；已有推荐结果已保留。")
    with state_lock:
        current_online = state["online_index"]
        same_online = len(current_online) == len(online) and all(current_online.get(k) is value for k, value in online.items())
        if (not state.get("startup_sync_ready") or state["local_index_cache"] is not cache or not same_online
                or any(state["config"].get(k) != config.get(k) for k in ("seed", "similarity"))):
            raise HTTPException(status_code=409, detail="音乐库或推荐设置已变化，请重新刷新，已有结果已保留。")
        if semantic_snapshot is not None and not SEED_SEMANTIC_VERIFIER.current(semantic_snapshot):
            raise HTTPException(status_code=409, detail="歌曲分析在刷新期间发生变化，请重试；已有结果已保留。")
        seeds = _load_seeds()
        _relink_seeds_paths_locked(seeds, state["index"], local_track_map)
        seed = _find_seed(seeds, seed_id)
        if not seed or json.dumps(seed, sort_keys=True, ensure_ascii=False) != original:
            raise HTTPException(status_code=409, detail="复合种子已变化，请重新刷新，已有结果已保留。")
        seed["k"] = working.get("k", 50)
        seed["rec_cache"] = recs
        seed["rec_diagnostics"] = working.get("rec_diagnostics", {})
        seed["updated_at"] = time.time()
        _save_seeds(seeds)
    return {"ok": True, "seed": seed}


@app.get("/seeds/{seed_id}")
def get_seed(seed_id: str):
    with state_lock:
        seeds = _load_seeds()
        changed = _relink_seeds_paths_locked(seeds, state["index"], _current_local_track_map_locked())
        if changed:
            _save_seeds(seeds)
        seed = _find_seed(seeds, seed_id)
        if not seed:
            raise HTTPException(status_code=404, detail="seed not found")
    return {"seed": seed}


@app.delete("/seeds/{seed_id}")
def delete_seed(seed_id: str):
    with state_lock:
        seeds = _load_seeds()
        new_seeds = [s for s in seeds if s.get("id") != seed_id]
        if len(new_seeds) == len(seeds):
            raise HTTPException(status_code=404, detail="seed not found")
        _save_seeds(new_seeds)
    return {"ok": True}
