from __future__ import annotations

import hashlib
import struct
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import BinaryIO, Iterable, Tuple


class AudioPayloadFingerprintError(RuntimeError):
    pass


class UnsupportedAudioPayload(AudioPayloadFingerprintError):
    pass


@dataclass(frozen=True)
class AudioPayloadFingerprint:
    format: str
    sha256: str
    bytes_hashed: int
    algorithm: str = "sha256-audio-payload-v1"

    def to_dict(self) -> dict:
        return asdict(self)

    def identity_value(self) -> str:
        return f"{self.algorithm}:{self.format}:{self.bytes_hashed}:{self.sha256}"


def is_audio_payload_identity(value: str) -> bool:
    parts = str(value or "").strip().split(":")
    if len(parts) != 4 or parts[0] != "sha256-audio-payload-v1":
        return False
    try:
        byte_count = int(parts[2])
    except (TypeError, ValueError):
        return False
    digest = parts[3].lower()
    return bool(
        parts[1] in {"mp3", "flac", "wav", "mp4", "aac", "ogg"}
        and byte_count > 0
        and len(digest) == 64
        and all(char in "0123456789abcdef" for char in digest)
    )


def _hash_ranges(handle: BinaryIO, ranges: Iterable[Tuple[int, int]]) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    for start, length in ranges:
        if start < 0 or length < 0:
            raise AudioPayloadFingerprintError("invalid payload range")
        handle.seek(start)
        remaining = length
        while remaining:
            chunk = handle.read(min(1024 * 1024, remaining))
            if not chunk:
                raise AudioPayloadFingerprintError("audio payload ended early")
            digest.update(chunk)
            total += len(chunk)
            remaining -= len(chunk)
    if total <= 0:
        raise AudioPayloadFingerprintError("audio payload is empty")
    return digest.hexdigest(), total


def _syncsafe_size(raw: bytes) -> int:
    if len(raw) != 4 or any(byte & 0x80 for byte in raw):
        raise AudioPayloadFingerprintError("invalid ID3 size")
    return (raw[0] << 21) | (raw[1] << 14) | (raw[2] << 7) | raw[3]


def _id3v2_end(handle: BinaryIO, file_size: int) -> int:
    handle.seek(0)
    header = handle.read(10)
    if len(header) < 10 or header[:3] != b"ID3":
        return 0
    tag_size = _syncsafe_size(header[6:10])
    footer_size = 10 if header[5] & 0x10 else 0
    end = 10 + tag_size + footer_size
    if end >= file_size:
        raise AudioPayloadFingerprintError("ID3 tag consumes the file")
    return end


def _mp3_audio_range(handle: BinaryIO, file_size: int) -> tuple[int, int]:
    start = _id3v2_end(handle, file_size)
    end = file_size
    if end - start >= 128:
        handle.seek(end - 128)
        if handle.read(3) == b"TAG":
            end -= 128
    if end - start >= 32:
        handle.seek(end - 32)
        footer = handle.read(32)
        if footer[:8] == b"APETAGEX":
            tag_size = struct.unpack("<I", footer[12:16])[0]
            if 32 <= tag_size <= end - start:
                end -= tag_size
    if end <= start:
        raise AudioPayloadFingerprintError("MP3 audio payload is empty")
    return start, end - start


def _flac_audio_range(handle: BinaryIO, file_size: int) -> tuple[int, int]:
    handle.seek(0)
    if handle.read(4) != b"fLaC":
        raise AudioPayloadFingerprintError("invalid FLAC marker")
    cursor = 4
    while True:
        if cursor + 4 > file_size:
            raise AudioPayloadFingerprintError("truncated FLAC metadata")
        handle.seek(cursor)
        header = handle.read(4)
        is_last = bool(header[0] & 0x80)
        block_length = int.from_bytes(header[1:4], "big")
        cursor += 4 + block_length
        if cursor > file_size:
            raise AudioPayloadFingerprintError("invalid FLAC metadata length")
        if is_last:
            break
    if cursor >= file_size:
        raise AudioPayloadFingerprintError("FLAC audio payload is empty")
    return cursor, file_size - cursor


def _wave_audio_ranges(handle: BinaryIO, file_size: int) -> list[tuple[int, int]]:
    handle.seek(0)
    header = handle.read(12)
    if len(header) != 12 or header[:4] not in {b"RIFF", b"RF64"} or header[8:12] != b"WAVE":
        raise AudioPayloadFingerprintError("invalid WAVE header")
    if header[:4] == b"RF64":
        raise UnsupportedAudioPayload("RF64 payload parsing is not enabled")
    ranges = []
    cursor = 12
    while cursor + 8 <= file_size:
        handle.seek(cursor)
        chunk_id = handle.read(4)
        chunk_size = struct.unpack("<I", handle.read(4))[0]
        payload_start = cursor + 8
        payload_end = payload_start + chunk_size
        if payload_end > file_size:
            raise AudioPayloadFingerprintError("invalid WAVE chunk length")
        if chunk_id == b"data" and chunk_size:
            ranges.append((payload_start, chunk_size))
        cursor = payload_end + (chunk_size & 1)
    if not ranges:
        raise AudioPayloadFingerprintError("WAVE data chunk is missing")
    return ranges


def _mp4_audio_ranges(handle: BinaryIO, file_size: int) -> list[tuple[int, int]]:
    ranges = []
    cursor = 0
    while cursor + 8 <= file_size:
        handle.seek(cursor)
        size32 = struct.unpack(">I", handle.read(4))[0]
        box_type = handle.read(4)
        header_size = 8
        if size32 == 1:
            if cursor + 16 > file_size:
                raise AudioPayloadFingerprintError("truncated extended MP4 box")
            box_size = struct.unpack(">Q", handle.read(8))[0]
            header_size = 16
        elif size32 == 0:
            box_size = file_size - cursor
        else:
            box_size = size32
        if box_size < header_size or cursor + box_size > file_size:
            raise AudioPayloadFingerprintError("invalid MP4 box length")
        if box_type == b"mdat" and box_size > header_size:
            ranges.append((cursor + header_size, box_size - header_size))
        cursor += box_size
        if size32 == 0:
            break
    if not ranges:
        raise AudioPayloadFingerprintError("MP4 mdat box is missing")
    return ranges


def _ogg_fingerprint(handle: BinaryIO) -> AudioPayloadFingerprint:
    """Hash codec/audio packets, excluding Vorbis/Opus comments and page layout.

    Refuse multiplexed/chained/unsupported streams instead of guessing identity.
    Packet lengths delimit the hash so repagination and tag edits stay stable.
    """
    digest = hashlib.sha256()
    packet = bytearray()
    serial = None
    sequence = 0
    packet_count = 0
    total = 0
    codec = ""
    ended = False
    while True:
        header = handle.read(27)
        if not header:
            break
        if ended or len(header) != 27 or header[:5] != b"OggS\x00":
            raise AudioPayloadFingerprintError("invalid Ogg page")
        flags = header[5]
        page_serial, page_sequence = struct.unpack_from("<II", header, 14)
        if serial is None:
            if not flags & 2 or flags & 1:
                raise AudioPayloadFingerprintError("missing Ogg beginning")
            serial = page_serial
        elif flags & 2:
            raise UnsupportedAudioPayload("chained Ogg stream")
        if page_serial != serial or page_sequence != sequence or bool(flags & 1) != bool(packet):
            raise AudioPayloadFingerprintError("discontinuous Ogg stream")
        sequence += 1
        lacing = handle.read(header[26])
        if len(lacing) != header[26]:
            raise AudioPayloadFingerprintError("truncated Ogg lacing")
        for size in lacing:
            data = handle.read(size)
            if len(data) != size:
                raise AudioPayloadFingerprintError("truncated Ogg packet")
            packet.extend(data)
            if len(packet) > 16 * 1024 * 1024:
                raise UnsupportedAudioPayload("oversized Ogg packet")
            if size == 255:
                continue
            if packet_count == 0:
                codec = "vorbis" if packet.startswith(b"\x01vorbis") else "opus" if packet.startswith(b"OpusHead") else ""
                if not codec:
                    raise UnsupportedAudioPayload("unsupported Ogg codec")
            if packet_count == 1:
                marker = b"\x03vorbis" if codec == "vorbis" else b"OpusTags"
                if not packet.startswith(marker):
                    raise AudioPayloadFingerprintError("missing Ogg comment header")
            else:
                if codec == "vorbis" and packet_count == 2 and not packet.startswith(b"\x05vorbis"):
                    raise AudioPayloadFingerprintError("missing Vorbis setup header")
                digest.update(struct.pack("<I", len(packet)))
                digest.update(packet)
                total += len(packet)
            packet_count += 1
            packet.clear()
        ended = bool(flags & 4)
        if ended:
            digest.update(header[6:14])  # Final sample position affects audible trimming.
    if packet or not ended or packet_count < (4 if codec == "vorbis" else 3) or not total:
        raise AudioPayloadFingerprintError("incomplete Ogg audio stream")
    return AudioPayloadFingerprint(format="ogg", sha256=digest.hexdigest(), bytes_hashed=total)


def fingerprint_audio_payload(path: Path | str) -> AudioPayloadFingerprint:
    target = Path(path)
    extension = target.suffix.lower()
    file_size = target.stat().st_size
    if file_size <= 0:
        raise AudioPayloadFingerprintError("audio file is empty")
    with target.open("rb") as handle:
        if extension == ".ogg":
            return _ogg_fingerprint(handle)
        if extension == ".mp3":
            ranges = [_mp3_audio_range(handle, file_size)]
            format_name = "mp3"
        elif extension == ".flac":
            ranges = [_flac_audio_range(handle, file_size)]
            format_name = "flac"
        elif extension == ".wav":
            ranges = _wave_audio_ranges(handle, file_size)
            format_name = "wav"
        elif extension in {".m4a", ".mp4"}:
            ranges = _mp4_audio_ranges(handle, file_size)
            format_name = "mp4"
        elif extension == ".aac":
            start = _id3v2_end(handle, file_size)
            ranges = [(start, file_size - start)]
            format_name = "aac"
        else:
            raise UnsupportedAudioPayload(f"unsupported audio payload format: {extension or '<none>'}")
        sha256, bytes_hashed = _hash_ranges(handle, ranges)
    return AudioPayloadFingerprint(format=format_name, sha256=sha256, bytes_hashed=bytes_hashed)


__all__ = [
    "AudioPayloadFingerprint",
    "AudioPayloadFingerprintError",
    "UnsupportedAudioPayload",
    "fingerprint_audio_payload",
    "is_audio_payload_identity",
]
