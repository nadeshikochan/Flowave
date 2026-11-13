from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any, Dict


PROJECT_ROOT = Path(__file__).resolve().parent
APP_HOME = Path(os.getenv("KUMIKO_APP_HOME") or PROJECT_ROOT).expanduser().resolve()


def resolve_data_dir(app_home: Path, raw: str | None = None, local_app_data: str | None = None) -> Path:
    app_home = Path(app_home).resolve()
    try:
        installed = json.loads((app_home / 'distribution.json').read_text(encoding='utf-8')).get('mode') == 'installed'
    except (OSError, ValueError, AttributeError):
        installed = False
    local = local_app_data or os.getenv('LOCALAPPDATA') or str(Path.home() / 'AppData/Local')
    default = (Path(local) / 'Flowave/data' if installed else app_home / 'data').resolve()
    raw = str((os.getenv('KUMIKO_DATA_DIR') or '') if raw is None else raw).strip()
    if not raw:
        pointer = Path(local) / 'Flowave/data-location.txt' if installed else app_home / 'workspace-location.txt'
        if pointer.exists():
            raw = pointer.read_text(encoding='utf-8-sig').strip()
            if not raw:
                raise ValueError('数据目录记录为空，请保留原文件并恢复备份。')
            if not Path(raw).is_absolute():
                if installed:
                    raise ValueError('数据目录记录损坏，请保留原文件并恢复备份。')
                raw = str(app_home / raw)
            if not Path(raw).is_dir():
                raise ValueError('数据目录不可用，请连接原磁盘后重试。')
        elif installed and not default.exists():
            raise ValueError('尚未选择数据目录，请重新运行安装包选择软件数据存储位置。')
    if not raw:
        return default
    if not Path(raw).expanduser().is_absolute():
        raise ValueError('数据目录必须是完整路径。')
    candidate = Path(raw).expanduser().resolve()
    contained = candidate == app_home or app_home in candidate.parents
    if installed:
        if contained:
            raise ValueError('安装版数据目录必须位于程序安装目录之外。')
        return candidate
    return candidate


DATA_DIR = resolve_data_dir(APP_HOME)
CONFIG_DIR = DATA_DIR / "config"
LIBRARY_DIR = DATA_DIR / "library"
CACHE_DIR = DATA_DIR / "cache"
LOG_DIR = DATA_DIR / "logs"
DOWNLOAD_DIR = DATA_DIR / "downloads"
_HISTORY_ROOT = LIBRARY_DIR / "listening"
LISTENING_HISTORY_DIR = (CONFIG_DIR if any(
    (CONFIG_DIR / name).exists() for name in ("listening_history.json", "listening-history-backups", "listening-history-snapshots")
) else _HISTORY_ROOT)
MODEL_DIR = DATA_DIR / "components/resources/legacy/models/MERT-v1-330M"
if not MODEL_DIR.is_dir():
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


def legacy_import_allowed() -> bool:
    if DATA_DIR != (APP_HOME / 'data').resolve():
        return False
    workspace = _read_json(DATA_DIR / '.flowave-workspace.json', {})
    return workspace.get('legacyImport') is not False


def migrate_legacy_files() -> Dict[str, Any]:
    """
    把开发期散落在项目根目录的数据复制到绿色版 data/ 结构。
    不删除旧文件；.pt 索引只复制到备份，实际转换交给 index_worker 子进程。
    """
    ensure_runtime_dirs()
    state = _read_json(MIGRATION_STATE_PATH, {})
    if state.get("done"):
        return state
    if not legacy_import_allowed():
        state = {"done": True, "legacy_import": False, "items": []}
        _write_json(MIGRATION_STATE_PATH, state)
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
