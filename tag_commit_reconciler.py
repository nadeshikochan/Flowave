from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

from audio_payload_fingerprint import is_audio_payload_identity
from track_identity import TrackIdentityError, TrackIdentityRegistry, normalize_resource_path
from vector_store import LocalVectorRecord, LocalVectorRecords


JOURNAL_VERSION = 1


class TagCommitReconcileError(RuntimeError):
    pass


class TagCommitConflict(TagCommitReconcileError):
    pass


@dataclass(frozen=True)
class TagCommitIdentityRequest:
    transaction_id: str
    resource_id: str
    path: str
    previous_song_key: str
    next_song_key: str
    size: int
    mtime_ns: int
    content_fingerprint: str


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with staged.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(staged, path)
    finally:
        staged.unlink(missing_ok=True)


def _coerce_request(raw: TagCommitIdentityRequest | Mapping[str, Any]) -> TagCommitIdentityRequest:
    if isinstance(raw, TagCommitIdentityRequest):
        request = raw
    elif isinstance(raw, Mapping):
        request = TagCommitIdentityRequest(
            transaction_id=str(raw.get("transaction_id") or ""),
            resource_id=str(raw.get("resource_id") or ""),
            path=str(raw.get("path") or ""),
            previous_song_key=str(raw.get("previous_song_key") or ""),
            next_song_key=str(raw.get("next_song_key") or ""),
            size=int(raw.get("size") or 0),
            mtime_ns=int(raw.get("mtime_ns") or 0),
            content_fingerprint=str(raw.get("content_fingerprint") or ""),
        )
    else:
        raise TagCommitReconcileError("标签提交对账请求无效")
    if not request.transaction_id.strip() or not request.resource_id.strip():
        raise TagCommitReconcileError("标签提交对账请求缺少事务或资源身份")
    if not Path(request.path).is_absolute() or not normalize_resource_path(request.path):
        raise TagCommitReconcileError("标签提交对账请求缺少绝对路径")
    if not request.next_song_key.strip():
        raise TagCommitReconcileError("标签提交后的 song key 为空")
    if not is_audio_payload_identity(request.content_fingerprint):
        raise TagCommitReconcileError("标签提交缺少可信音频载荷指纹")
    return replace(
        request,
        transaction_id=request.transaction_id.strip(),
        resource_id=request.resource_id.strip(),
        path=str(Path(request.path)),
        previous_song_key=request.previous_song_key.strip(),
        next_song_key=request.next_song_key.strip(),
        size=max(0, int(request.size)),
        mtime_ns=max(0, int(request.mtime_ns)),
        content_fingerprint=request.content_fingerprint.strip(),
    )


class TagCommitIdentityReconciler:
    def __init__(
        self,
        journal_path: Path | str,
        *,
        identity_registry: TrackIdentityRegistry,
        load_records: Callable[[], LocalVectorRecords],
        save_records: Callable[[LocalVectorRecords], None],
        now: Callable[[], float] = time.time,
    ) -> None:
        self.journal_path = Path(journal_path)
        self.previous_path = self.journal_path.with_name(f"{self.journal_path.name}.previous")
        self.identity_registry = identity_registry
        self.load_records = load_records
        self.save_records = save_records
        self.now = now
        self._lock = threading.Lock()

    @staticmethod
    def _decode_journal(path: Path) -> dict[str, Any]:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as error:
            raise TagCommitReconcileError(f"标签提交恢复记录无法读取：{error}") from error
        if not isinstance(payload, dict) or int(payload.get("version") or 0) != JOURNAL_VERSION:
            raise TagCommitReconcileError("标签提交恢复记录版本无效")
        if payload.get("status") not in {"prepared", "identity-applied", "index-applied"}:
            raise TagCommitReconcileError("标签提交恢复记录状态无效")
        _coerce_request(payload.get("request") or {})
        return payload

    def _read_journal(self) -> dict[str, Any]:
        current_error: Optional[Exception] = None
        if self.journal_path.exists():
            try:
                return self._decode_journal(self.journal_path)
            except Exception as error:
                current_error = error
        if self.previous_path.exists():
            try:
                return self._decode_journal(self.previous_path)
            except Exception as previous_error:
                raise TagCommitReconcileError(
                    f"标签提交恢复记录两代均损坏：{previous_error}"
                ) from previous_error
        if current_error is not None:
            raise TagCommitReconcileError(str(current_error)) from current_error
        raise TagCommitReconcileError("标签提交恢复记录不存在")

    def _write_journal(self, payload: dict[str, Any], status: str) -> None:
        next_payload = dict(payload)
        next_payload["status"] = status
        next_payload["updated_at"] = float(self.now())
        if self.journal_path.exists():
            try:
                self._decode_journal(self.journal_path)
            except TagCommitReconcileError:
                pass
            else:
                shutil.copy2(self.journal_path, self.previous_path)
        _atomic_write_json(self.journal_path, next_payload)

    def _identity_entry(self, resource_id: str) -> Optional[dict[str, Any]]:
        return (self.identity_registry.snapshot().get("tracks") or {}).get(resource_id)

    @staticmethod
    def _validate_path(actual: str, expected: str) -> None:
        if normalize_resource_path(actual) != normalize_resource_path(expected):
            raise TagCommitConflict("歌曲路径与资源身份不一致")

    def _prepare(self, request: TagCommitIdentityRequest) -> dict[str, Any]:
        entry = self._identity_entry(request.resource_id)
        if not entry:
            raise TagCommitConflict("歌曲资源身份不存在")
        self._validate_path(str(entry.get("current_path") or ""), request.path)
        current_key = str(entry.get("current_song_key") or "")
        if current_key not in {request.previous_song_key, request.next_song_key}:
            raise TagCommitConflict("歌曲身份已被其他操作修改")

        records = self.load_records()
        record = records.get(request.resource_id)
        if record is not None:
            if record.legacy or str(record.resource_id or "") != request.resource_id:
                raise TagCommitConflict("歌曲向量记录缺少稳定身份")
            self._validate_path(record.path, request.path)
            if record.song_key not in {request.previous_song_key, request.next_song_key}:
                raise TagCommitConflict("歌曲向量记录已被其他操作修改")
        return {
            "version": JOURNAL_VERSION,
            "status": "prepared",
            "created_at": float(self.now()),
            "updated_at": float(self.now()),
            "requires_vector_update": record is not None,
            "request": asdict(request),
        }

    def _apply_identity(self, request: TagCommitIdentityRequest) -> None:
        entry = self._identity_entry(request.resource_id)
        if not entry:
            raise TagCommitConflict("歌曲资源身份不存在")
        self._validate_path(str(entry.get("current_path") or ""), request.path)
        current_key = str(entry.get("current_song_key") or "")
        if current_key == request.next_song_key:
            return
        if current_key != request.previous_song_key:
            raise TagCommitConflict("歌曲身份已被其他操作修改")
        try:
            self.identity_registry.record_tag_change(
                resource_id=request.resource_id,
                path=request.path,
                previous_song_key=request.previous_song_key,
                next_song_key=request.next_song_key,
                size=request.size,
                mtime_ns=request.mtime_ns,
                content_fingerprint=request.content_fingerprint,
            )
        except TrackIdentityError as error:
            raise TagCommitConflict(str(error)) from error

    def _apply_index(self, request: TagCommitIdentityRequest, *, required: bool) -> None:
        records = self.load_records()
        record = records.get(request.resource_id)
        if record is None:
            if required:
                raise TagCommitConflict("歌曲向量记录在提交后消失")
            return
        if record.legacy or str(record.resource_id or "") != request.resource_id:
            raise TagCommitConflict("歌曲向量记录缺少稳定身份")
        self._validate_path(record.path, request.path)
        if record.song_key == request.next_song_key and record.content_fingerprint == request.content_fingerprint:
            return
        if record.song_key not in {request.previous_song_key, request.next_song_key}:
            raise TagCommitConflict("歌曲向量记录已被其他操作修改")
        updated = dict(records)
        updated[request.resource_id] = LocalVectorRecord(
            resource_id=request.resource_id,
            song_key=request.next_song_key,
            path=request.path,
            embedding=record.embedding.copy(),
            content_fingerprint=request.content_fingerprint,
        )
        self.save_records(updated)

    def _apply_journal(self, journal: dict[str, Any]) -> dict[str, Any]:
        request = _coerce_request(journal["request"])
        self._apply_identity(request)
        self._write_journal(journal, "identity-applied")
        self._apply_index(request, required=bool(journal.get("requires_vector_update")))
        self._write_journal(journal, "index-applied")
        self.journal_path.unlink(missing_ok=True)
        self.previous_path.unlink(missing_ok=True)
        return {
            "ok": True,
            "status": "reconciled",
            "transaction_id": request.transaction_id,
            "resource_id": request.resource_id,
            "song_key": request.next_song_key,
        }

    def reconcile(self, raw: TagCommitIdentityRequest | Mapping[str, Any]) -> dict[str, Any]:
        request = _coerce_request(raw)
        with self._lock:
            if self.journal_path.exists():
                pending = self._read_journal()
                pending_request = _coerce_request(pending["request"])
                if pending_request.transaction_id != request.transaction_id:
                    raise TagCommitReconcileError("存在未完成的标签提交对账")
                return self._apply_journal(pending)
            journal = self._prepare(request)
            _atomic_write_json(self.journal_path, journal)
            return self._apply_journal(journal)

    def recover_pending(self) -> Optional[dict[str, Any]]:
        with self._lock:
            if not self.journal_path.exists():
                return None
            return self._apply_journal(self._read_journal())


__all__ = [
    "TagCommitConflict",
    "TagCommitIdentityReconciler",
    "TagCommitIdentityRequest",
    "TagCommitReconcileError",
]
