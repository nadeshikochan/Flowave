from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any, Dict


PROJECT_ROOT = Path(__file__).resolve().parent
APP_HOME = Path(os.getenv("KUMIKO_APP_HOME") or PROJECT_ROOT).expanduser().resolve()


def _resolve_portable_data_dir() -> Path:
    default = (APP_HOME / "data").resolve()
    raw = str(os.getenv("KUMIKO_DATA_DIR") or "").strip()
    if not raw:
        return default
    candidate = Path(raw).expanduser().resolve()
    try:
        candidate.relative_to(APP_HOME)
        return candidate
    except ValueError:
        return default


DATA_DIR = _resolve_portable_data_dir()
CONFIG_DIR = DATA_DIR / "config"
LIBRARY_DIR = DATA_DIR / "library"
CACHE_DIR = DATA_DIR / "cache"
LOG_DIR = DATA_DIR / "logs"
DOWNLOAD_DIR = DATA_DIR / "downloads"
MODEL_DIR = APP_HOME / "models" / "MERT-v1-330M"
MIGRATION_STATE_PATH = CONFIG_DIR / "migration.json"

APP_CONFIG_PATH = CONFIG_DIR / "app.json"
LOCAL_TRACKS_PATH = LIBRARY_DIR / "tracks.json"
LOCAL_EMBEDDINGS_PATH = LIBRARY_DIR / "embeddings.npy"
TRACK_IDENTITIES_PATH = LIBRARY_DIR / "track_identities.json"
TAG_COMMIT_JOURNAL_PATH = LIBRARY_DIR / "tag_commit_pending.json"
ONLINE_EMBEDDINGS_META_PATH = LIBRARY_DIR / "online_embeddings.json"
ONLINE_EMBEDDINGS_PATH = LIBRARY_DIR / "online_embeddings.npy"
ONLINE_CATALOG_PATH = LIBRARY_DIR / "online_catalog.json"
SEED_PATH = LIBRARY_DIR / "composite_seeds.json"

LEGACY_CONFIG_PATH = PROJECT_ROOT / "config.json"
LEGACY_LOCAL_INDEX_PATH = PROJECT_ROOT / "music_index.pt"
LEGACY_ONLINE_INDEX_PATH = PROJECT_ROOT / "online_index.pt"
LEGACY_ONLINE_CATALOG_PATH = PROJECT_ROOT / "online_catalog.json"
LEGACY_SEED_PATH = PROJECT_ROOT / "composite_seeds.json"


def ensure_runtime_dirs() -> None:
    for path in (DATA_DIR, CONFIG_DIR, LIBRARY_DIR, CACHE_DIR, LOG_DIR, DOWNLOAD_DIR):
        path.mkdir(parents=True, exist_ok=True)


def runtime_paths_payload() -> Dict[str, str]:
    return {
        "app_home": str(APP_HOME),
        "data_dir": str(DATA_DIR),
        "config_dir": str(CONFIG_DIR),
        "library_dir": str(LIBRARY_DIR),
        "cache_dir": str(CACHE_DIR),
        "log_dir": str(LOG_DIR),
        "download_dir": str(DOWNLOAD_DIR),
        "model_dir": str(MODEL_DIR),
    }


def _read_json(path: Path, default: Any) -> Any:
    try:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _copy_if_needed(src: Path, dst: Path, backup_dir: Path, migrated: list[str]) -> None:
    if not src.exists() or dst.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, backup_dir / src.name)
    shutil.copy2(src, dst)
    migrated.append(f"{src.name} -> {dst.relative_to(DATA_DIR)}")


def migrate_legacy_files() -> Dict[str, Any]:
    """
    把开发期散落在项目根目录的数据复制到绿色版 data/ 结构。
    不删除旧文件；.pt 索引只复制到备份，实际转换交给 index_worker 子进程。
    """
    ensure_runtime_dirs()
    state = _read_json(MIGRATION_STATE_PATH, {})
    if state.get("done"):
        return state

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_dir = DATA_DIR / "migration-backup" / stamp
    migrated: list[str] = []

    _copy_if_needed(LEGACY_CONFIG_PATH, APP_CONFIG_PATH, backup_dir, migrated)
    _copy_if_needed(LEGACY_ONLINE_CATALOG_PATH, ONLINE_CATALOG_PATH, backup_dir, migrated)
    _copy_if_needed(LEGACY_SEED_PATH, SEED_PATH, backup_dir, migrated)

    # .pt 文件含 torch 序列化对象，常驻 API 不读取；只备份，worker 后续转换。
    for legacy in (LEGACY_LOCAL_INDEX_PATH, LEGACY_ONLINE_INDEX_PATH):
        if legacy.exists():
            backup_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(legacy, backup_dir / legacy.name)
            migrated.append(f"{legacy.name} -> migration-backup/{stamp}/{legacy.name}")

    state = {
        "done": True,
        "migrated_at": time.time(),
        "backup_dir": str(backup_dir) if backup_dir.exists() else "",
        "items": migrated,
    }
    _write_json(MIGRATION_STATE_PATH, state)
    return state
