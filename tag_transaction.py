from __future__ import annotations

import hashlib
import copy
import json
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Protocol

from audio_payload_fingerprint import (
    AudioPayloadFingerprint,
    AudioPayloadFingerprintError,
    fingerprint_audio_payload,
)


_SAFE_TRANSACTION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")


class TagTransactionError(RuntimeError):
    pass


class TagWriteUnsupported(TagTransactionError):
    pass


class ExternalFileChanged(TagTransactionError):
    pass


class TagVerificationFailed(TagTransactionError):
    pass


class UndoConflict(TagTransactionError):
    pass


@dataclass(frozen=True)
class FileVersion:
    size: int
    mtime_ns: int
    ctime_ns: int
    file_sha256: str
    audio_payload: AudioPayloadFingerprint

    def to_dict(self) -> dict:
        value = asdict(self)
        value["audio_payload"] = self.audio_payload.to_dict()
        return value


@dataclass(frozen=True)
class TagReadback:
    fields: Dict[str, Any]
    preservation_fingerprint: str
    technical: Dict[str, Any] = field(default_factory=dict)


class TagAdapter(Protocol):
    adapter_id: str
    adapter_version: str

    def supports(self, path: Path) -> bool: ...

    def read(self, path: Path) -> TagReadback: ...

    def write(self, path: Path, updates: Mapping[str, Any]) -> None: ...

    def verify(self, before: TagReadback, after: TagReadback, updates: Mapping[str, Any]) -> None: ...


@dataclass(frozen=True)
class TagWriteRequest:
    path: Path | str
    updates: Mapping[str, Any]
    expected: FileVersion
    resource_id: str = ""
    provider: str = ""
    candidate_id: str = ""
    provenance: Mapping[str, Any] = field(default_factory=dict)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def capture_file_version(path: Path | str) -> FileVersion:
    target = Path(path)
    stat = target.stat()
    if not target.is_file():
        raise TagTransactionError("target is not a file")
    return FileVersion(
        size=int(stat.st_size),
        mtime_ns=int(stat.st_mtime_ns),
        ctime_ns=int(stat.st_ctime_ns),
        file_sha256=_file_sha256(target),
        audio_payload=fingerprint_audio_payload(target),
    )


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return {"type": "bytes", "size": len(value), "sha256": hashlib.sha256(value).hexdigest()}
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)


def _atomic_write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


class TagTransactionManager:
    def __init__(
        self,
        snapshot_root: Path | str,
        *,
        version_reader: Callable[[Path], FileVersion] = capture_file_version,
        now: Callable[[], float] = time.time,
        id_factory: Callable[[], str] = lambda: uuid.uuid4().hex,
    ):
        self.snapshot_root = Path(snapshot_root)
        self.version_reader = version_reader
        self.now = now
        self.id_factory = id_factory
        self._locks_guard = threading.Lock()
        self._locks: Dict[str, threading.Lock] = {}

    def _lock_for(self, path: Path) -> threading.Lock:
        key = os.path.normcase(str(path.resolve(strict=False)))
        with self._locks_guard:
            return self._locks.setdefault(key, threading.Lock())

    @staticmethod
    def _validate_transaction_id(value: Any) -> str:
        transaction_id = str(value or "")
        if not _SAFE_TRANSACTION_ID.fullmatch(transaction_id):
            raise TagTransactionError("invalid transaction id")
        return transaction_id

    @staticmethod
    def _same_expected(expected: FileVersion, actual: FileVersion) -> bool:
        return (
            expected.size == actual.size
            and expected.mtime_ns == actual.mtime_ns
            and expected.file_sha256 == actual.file_sha256
            and expected.audio_payload.sha256 == actual.audio_payload.sha256
        )

    def write(
        self,
        request: TagWriteRequest,
        adapter: TagAdapter,
        *,
        after_commit: Optional[Callable[[dict], None]] = None,
    ) -> dict:
        target = Path(request.path).resolve(strict=True)
        if not adapter.supports(target):
            raise TagWriteUnsupported(f"adapter does not support {target.suffix.lower()}")
        if not request.updates:
            raise TagTransactionError("tag update is empty")
        lock = self._lock_for(target)
        with lock:
            return self._write_locked(target, request, adapter, after_commit=after_commit)

    def _write_locked(
        self,
        target: Path,
        request: TagWriteRequest,
        adapter: TagAdapter,
        *,
        after_commit: Optional[Callable[[dict], None]],
    ) -> dict:
        before_version = self.version_reader(target)
        if not self._same_expected(request.expected, before_version):
            raise ExternalFileChanged("file changed after confirmation")
        before_tags = adapter.read(target)
        transaction_id = self._validate_transaction_id(self.id_factory())
        temporary = target.with_name(f".{target.stem}.flowave-{transaction_id}.tmp{target.suffix}")
        snapshot_dir = self.snapshot_root / transaction_id
        snapshot = snapshot_dir / f"original{target.suffix.lower()}"
        manifest_path = snapshot_dir / "manifest.json"
        manifest: dict = {
            "schema_version": 1,
            "transaction_id": transaction_id,
            "status": "preparing",
            "created_at": self.now(),
            "resource_id": str(request.resource_id or ""),
            "path": str(target),
            "adapter": {
                "id": str(adapter.adapter_id),
                "version": str(adapter.adapter_version),
            },
            "provider": str(request.provider or ""),
            "candidate_id": str(request.candidate_id or ""),
            "updates": _json_safe(request.updates),
            "provenance": _json_safe(request.provenance),
            "before": before_version.to_dict(),
            "temporary": str(temporary),
        }
        try:
            shutil.copy2(target, temporary)
            adapter.write(temporary, request.updates)
            staged_version = self.version_reader(temporary)
            if staged_version.audio_payload.sha256 != before_version.audio_payload.sha256:
                raise TagVerificationFailed("audio payload changed during tag write")
            if staged_version.audio_payload.bytes_hashed != before_version.audio_payload.bytes_hashed:
                raise TagVerificationFailed("audio payload length changed during tag write")
            after_tags = adapter.read(temporary)
            adapter.verify(before_tags, after_tags, request.updates)

            if not self._same_expected(before_version, self.version_reader(target)):
                raise ExternalFileChanged("file changed while preparing tags")
            snapshot_dir.mkdir(parents=True, exist_ok=False)
            shutil.copy2(target, snapshot)
            if _file_sha256(snapshot) != before_version.file_sha256:
                raise TagVerificationFailed("undo snapshot does not match original")
            manifest["status"] = "prepared"
            manifest["snapshot"] = str(snapshot)
            manifest["staged"] = staged_version.to_dict()
            manifest["before_fields"] = _json_safe(before_tags.fields)
            manifest["after_fields"] = _json_safe(after_tags.fields)
            _atomic_write_json(manifest_path, manifest)

            if not self._same_expected(before_version, self.version_reader(target)):
                raise ExternalFileChanged("file changed before tag publication")
            os.replace(temporary, target)
            try:
                final_version = self.version_reader(target)
                if final_version.file_sha256 != staged_version.file_sha256:
                    raise TagVerificationFailed("final file does not match verified staging file")
                if final_version.audio_payload.sha256 != before_version.audio_payload.sha256:
                    raise TagVerificationFailed("final audio payload changed")
            except Exception:
                self._restore_snapshot(target, snapshot, before_version)
                raise

            manifest["status"] = "committed"
            manifest["post_commit_status"] = "pending"
            manifest["committed_at"] = self.now()
            manifest["after"] = final_version.to_dict()
            _atomic_write_json(manifest_path, manifest)
            if after_commit is not None:
                try:
                    after_commit(dict(manifest))
                    manifest["post_commit_status"] = "complete"
                    manifest["post_commit_completed_at"] = self.now()
                    _atomic_write_json(manifest_path, manifest)
                except Exception as exc:  # 写入已提交，保留记录供后续对账。
                    manifest["post_commit_error"] = str(exc)
                    _atomic_write_json(manifest_path, manifest)
            return dict(manifest)
        except Exception:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    def recover_incomplete(self) -> list[dict]:
        """Reconcile transactions interrupted after their staging manifest was saved.

        Recovery never guesses from filenames alone. A prepared transaction is committed
        only when the target is byte-for-byte identical to the verified staging file and
        its undo snapshot still matches the recorded original. If the original target is
        unchanged, the transaction is closed as aborted. All other states remain prepared
        with a conflict marker for explicit handling.
        """

        if not self.snapshot_root.is_dir():
            return []
        outcomes: list[dict] = []
        for manifest_path in sorted(self.snapshot_root.glob("*/manifest.json")):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                outcomes.append({"status": "invalid", "transaction_id": manifest_path.parent.name})
                continue
            if manifest.get("status") != "prepared":
                continue
            try:
                outcomes.append(self._recover_prepared(manifest_path, manifest))
            except (OSError, AudioPayloadFingerprintError, TagTransactionError, ValueError):
                outcomes.append(
                    {"status": "error", "transaction_id": manifest_path.parent.name}
                )
        return outcomes

    def _recover_prepared(self, manifest_path: Path, manifest: dict) -> dict:
        try:
            transaction_id = self._validate_transaction_id(manifest.get("transaction_id"))
            if transaction_id != manifest_path.parent.name:
                raise TagTransactionError("transaction directory mismatch")
            raw_target = Path(str(manifest.get("path") or ""))
            if not raw_target.is_absolute():
                raise TagTransactionError("transaction target is not absolute")
            target = raw_target.resolve(strict=False)
            snapshot = manifest_path.parent / f"original{target.suffix.lower()}"
            declared_snapshot = Path(str(manifest.get("snapshot") or "")).resolve(strict=False)
            if declared_snapshot != snapshot.resolve(strict=False):
                raise TagTransactionError("transaction snapshot mismatch")
            temporary = target.with_name(
                f".{target.stem}.flowave-{transaction_id}.tmp{target.suffix}"
            )
            declared_temporary = Path(str(manifest.get("temporary") or "")).resolve(strict=False)
            if declared_temporary != temporary.resolve(strict=False):
                raise TagTransactionError("transaction temporary mismatch")
        except (OSError, TagTransactionError, ValueError):
            return {"status": "invalid", "transaction_id": manifest_path.parent.name}

        lock = self._lock_for(target)
        with lock:
            try:
                current_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                return {"status": "invalid", "transaction_id": transaction_id}
            if current_manifest.get("status") != "prepared":
                return {
                    "status": str(current_manifest.get("status") or "invalid"),
                    "transaction_id": transaction_id,
                }

            before_hash = str((current_manifest.get("before") or {}).get("file_sha256") or "")
            staged_hash = str((current_manifest.get("staged") or {}).get("file_sha256") or "")
            if not before_hash or not staged_hash or not target.is_file():
                return self._record_recovery_conflict(
                    manifest_path,
                    current_manifest,
                    transaction_id,
                    "target-unavailable",
                )
            try:
                current = self.version_reader(target)
            except (OSError, AudioPayloadFingerprintError, TagTransactionError, ValueError):
                return self._record_recovery_conflict(
                    manifest_path,
                    current_manifest,
                    transaction_id,
                    "target-unreadable",
                )

            if current.file_sha256 == staged_hash:
                try:
                    snapshot_is_valid = snapshot.is_file() and _file_sha256(snapshot) == before_hash
                except OSError:
                    snapshot_is_valid = False
                if not snapshot_is_valid:
                    return self._record_recovery_conflict(
                        manifest_path,
                        current_manifest,
                        transaction_id,
                        "snapshot-invalid",
                    )
                current_manifest["status"] = "committed"
                current_manifest["post_commit_status"] = "pending"
                current_manifest["recovered_at"] = self.now()
                current_manifest["after"] = current.to_dict()
                current_manifest.pop("recovery", None)
                _atomic_write_json(manifest_path, current_manifest)
                self._remove_verified_temporary(temporary, staged_hash)
                return {"status": "committed", "transaction_id": transaction_id}

            if current.file_sha256 == before_hash:
                current_manifest["status"] = "aborted"
                current_manifest["aborted_at"] = self.now()
                current_manifest["recovery_reason"] = "original-unchanged"
                current_manifest.pop("recovery", None)
                _atomic_write_json(manifest_path, current_manifest)
                self._remove_verified_temporary(temporary, staged_hash)
                return {"status": "aborted", "transaction_id": transaction_id}

            return self._record_recovery_conflict(
                manifest_path,
                current_manifest,
                transaction_id,
                "target-changed",
            )

    def pending_post_commits(self) -> list[dict[str, Any]]:
        if not self.snapshot_root.is_dir():
            return []
        pending: list[dict[str, Any]] = []
        for manifest_path in sorted(self.snapshot_root.glob("*/manifest.json")):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                transaction_id = self._validate_transaction_id(manifest.get("transaction_id"))
            except (OSError, UnicodeError, json.JSONDecodeError, TagTransactionError):
                continue
            if transaction_id != manifest_path.parent.name:
                continue
            if manifest.get("status") != "committed":
                continue
            if manifest.get("post_commit_status") == "complete":
                continue
            pending.append(copy.deepcopy(manifest))
        return pending

    def mark_post_commit_complete(self, transaction_id: str) -> dict[str, Any]:
        safe_id = self._validate_transaction_id(transaction_id)
        manifest_path = self.snapshot_root / safe_id / "manifest.json"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise TagTransactionError("transaction manifest is unavailable") from error
        if str(manifest.get("transaction_id") or "") != safe_id:
            raise TagTransactionError("transaction directory mismatch")
        if manifest.get("status") != "committed":
            raise TagTransactionError("transaction is not committed")
        if manifest.get("post_commit_status") != "complete":
            manifest["post_commit_status"] = "complete"
            manifest["post_commit_completed_at"] = self.now()
            manifest.pop("post_commit_error", None)
            _atomic_write_json(manifest_path, manifest)
        return copy.deepcopy(manifest)

    def pending_post_undos(self) -> list[dict[str, Any]]:
        if not self.snapshot_root.is_dir():
            return []
        pending: list[dict[str, Any]] = []
        for manifest_path in sorted(self.snapshot_root.glob("*/manifest.json")):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                transaction_id = self._validate_transaction_id(manifest.get("transaction_id"))
            except (OSError, UnicodeError, json.JSONDecodeError, TagTransactionError):
                continue
            if transaction_id != manifest_path.parent.name:
                continue
            if manifest.get("status") != "undone":
                continue
            if manifest.get("post_undo_status") == "complete":
                continue
            pending.append(copy.deepcopy(manifest))
        return pending

    def mark_post_undo_complete(self, transaction_id: str) -> dict[str, Any]:
        safe_id = self._validate_transaction_id(transaction_id)
        manifest_path = self.snapshot_root / safe_id / "manifest.json"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise TagTransactionError("transaction manifest is unavailable") from error
        if str(manifest.get("transaction_id") or "") != safe_id:
            raise TagTransactionError("transaction directory mismatch")
        if manifest.get("status") != "undone":
            raise TagTransactionError("transaction undo is not committed")
        if manifest.get("post_undo_status") != "complete":
            manifest["post_undo_status"] = "complete"
            manifest["post_undo_completed_at"] = self.now()
            manifest.pop("post_undo_error", None)
            _atomic_write_json(manifest_path, manifest)
        return copy.deepcopy(manifest)

    def _record_recovery_conflict(
        self,
        manifest_path: Path,
        manifest: dict,
        transaction_id: str,
        reason: str,
    ) -> dict:
        manifest["recovery"] = {
            "status": "conflict",
            "reason": reason,
            "checked_at": self.now(),
        }
        _atomic_write_json(manifest_path, manifest)
        return {"status": "conflict", "transaction_id": transaction_id, "reason": reason}

    @staticmethod
    def _remove_verified_temporary(temporary: Path, expected_hash: str) -> None:
        try:
            if temporary.is_file() and _file_sha256(temporary) == expected_hash:
                temporary.unlink()
        except OSError:
            pass

    def _restore_snapshot(self, target: Path, snapshot: Path, expected: FileVersion) -> None:
        recovery = target.with_name(f".{target.stem}.flowave-recovery-{uuid.uuid4().hex}{target.suffix}")
        try:
            shutil.copy2(snapshot, recovery)
            if _file_sha256(recovery) != expected.file_sha256:
                raise TagVerificationFailed("recovery snapshot is invalid")
            os.replace(recovery, target)
        finally:
            try:
                recovery.unlink(missing_ok=True)
            except OSError:
                pass

    def undo(self, manifest_path: Path | str) -> dict:
        manifest_file = Path(manifest_path)
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        if manifest.get("status") != "committed":
            raise UndoConflict("transaction is not undoable")
        target = Path(str(manifest.get("path") or "")).resolve(strict=True)
        snapshot = Path(str(manifest.get("snapshot") or "")).resolve(strict=True)
        lock = self._lock_for(target)
        with lock:
            current = self.version_reader(target)
            expected_after_hash = str((manifest.get("after") or {}).get("file_sha256") or "")
            if not expected_after_hash or current.file_sha256 != expected_after_hash:
                raise UndoConflict("file changed after Flowave write")
            expected_before_hash = str((manifest.get("before") or {}).get("file_sha256") or "")
            if _file_sha256(snapshot) != expected_before_hash:
                raise UndoConflict("undo snapshot is invalid")
            recovery = target.with_name(f".{target.stem}.flowave-undo-{uuid.uuid4().hex}{target.suffix}")
            try:
                shutil.copy2(snapshot, recovery)
                staged_restore = self.version_reader(recovery)
                if staged_restore.file_sha256 != expected_before_hash:
                    raise TagVerificationFailed("undo staging verification failed")
                before_audio = manifest.get("before", {}).get("audio_payload") or {}
                if staged_restore.audio_payload.to_dict() != before_audio:
                    raise TagVerificationFailed("undo audio payload verification failed")
                os.replace(recovery, target)
            finally:
                try:
                    recovery.unlink(missing_ok=True)
                except OSError:
                    pass
            restored = self.version_reader(target)
            if restored.file_sha256 != expected_before_hash:
                raise TagVerificationFailed("undo verification failed")
            manifest["status"] = "undone"
            manifest["post_undo_status"] = "pending"
            manifest["undone_at"] = self.now()
            manifest["restored"] = restored.to_dict()
            _atomic_write_json(manifest_file, manifest)
            return manifest


__all__ = [
    "ExternalFileChanged",
    "FileVersion",
    "TagAdapter",
    "TagReadback",
    "TagTransactionError",
    "TagTransactionManager",
    "TagVerificationFailed",
    "TagWriteRequest",
    "TagWriteUnsupported",
    "UndoConflict",
    "capture_file_version",
]
