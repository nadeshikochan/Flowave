"""Conservative text-tag adapter. Audio and untouched tag verification precede publication."""
import hashlib
import pickle
from pathlib import Path

from tag_transaction import TagReadback, TagVerificationFailed, TagWriteUnsupported

FIELDS = ("title", "artists", "album", "albumArtists", "releaseDate", "genres")
ID3_KEYS = dict(zip(FIELDS, ("TIT2", "TPE1", "TALB", "TPE2", "TDRC", "TCON")))
VORBIS_KEYS = dict(zip(FIELDS, ("title", "artist", "album", "albumartist", "date", "genre")))
MP4_KEYS = dict(zip(FIELDS, ("\xa9nam", "\xa9ART", "\xa9alb", "aART", "\xa9day", "\xa9gen")))
LIST_FIELDS = {"artists", "albumArtists", "genres"}


def clean_updates(raw):
    if not isinstance(raw, dict) or not raw or set(raw) - set(FIELDS):
        raise ValueError("请选择要修改的文字资料")
    output = {}
    for field, value in raw.items():
        if field in LIST_FIELDS:
            values = value if isinstance(value, list) else [value]
            if len(values) > 32 or any(not isinstance(v, str) or len(v) > 500 or "\0" in v for v in values):
                raise ValueError("歌手或流派内容过长")
            output[field] = list(dict.fromkeys(v.strip() for v in values if v.strip()))
        else:
            if not isinstance(value, str) or len(value) > 500 or "\0" in value:
                raise ValueError("资料内容无效或过长")
            output[field] = value.strip()
    if "title" in output and not output["title"]:
        raise ValueError("歌名不能为空")
    return output


class MetadataTagAdapter:
    adapter_id = "mutagen-text"
    adapter_version = "1"

    def supports(self, path):
        return Path(path).suffix.lower() in {".mp3", ".flac", ".m4a", ".ogg"}

    def _open(self, path):
        from mutagen import File
        if not self.supports(path):
            raise TagWriteUnsupported("暂不支持写入此格式")
        audio = File(path, easy=False)
        if audio is None:
            raise TagWriteUnsupported("无法读取音频标签")
        if audio.tags is None:
            audio.add_tags()
        suffix = Path(path).suffix.lower()
        keys = ID3_KEYS if suffix == ".mp3" else MP4_KEYS if suffix == ".m4a" else VORBIS_KEYS
        return audio, keys

    def read(self, path):
        audio, keys = self._open(path)
        fields = {}
        for field, key in keys.items():
            value = audio.tags.get(key, [])
            values = list(getattr(value, "text", value))
            strings = [str(item) for item in values if str(item)]
            fields[field] = strings if field in LIST_FIELDS else (strings[0] if strings else "")
        raw = {str(key): hashlib.sha256(pickle.dumps(value, protocol=4)).hexdigest() for key, value in audio.tags.items()}
        if hasattr(audio, "metadata_blocks"):
            raw["__metadata_blocks__"] = hashlib.sha256(pickle.dumps([(block.code, block.write()) for block in audio.metadata_blocks if block.code not in (1, 4)], protocol=4)).hexdigest()
        if hasattr(audio, "pictures"):
            raw["__pictures__"] = hashlib.sha256(pickle.dumps(audio.pictures, protocol=4)).hexdigest()
        technical = {"raw": raw, "keys": keys, "length": float(audio.info.length),
                     "sample_rate": getattr(audio.info, "sample_rate", 0), "channels": getattr(audio.info, "channels", 0)}
        return TagReadback(fields, "", technical)

    def write(self, path, updates):
        updates = clean_updates(dict(updates))
        audio, keys = self._open(path)
        for field, value in updates.items():
            key = keys[field]
            values = value if field in LIST_FIELDS else ([value] if value else [])
            if Path(path).suffix.lower() == ".mp3":
                from mutagen import id3
                audio.tags.delall(key)
                if values:
                    audio.tags.add(getattr(id3, key)(encoding=3, text=values))
            elif values:
                audio.tags[key] = values
            elif key in audio.tags:
                del audio.tags[key]
        if Path(path).suffix.lower() == ".mp3":
            # Retain ID3 v2.3 when present; unedited values are checked below.
            version = 3 if getattr(audio.tags, "version", (2, 4, 0))[1] == 3 else 4
            if any(isinstance(value, list) and len(value) > 1 for value in updates.values()):
                version = 4  # ID3 v2.4 represents multiple artist values without joining names.
            audio.save(v2_version=version)
        else:
            audio.save()

    def verify(self, before, after, updates):
        for field, value in updates.items():
            if after.fields.get(field) != value:
                raise TagVerificationFailed(f"写入后{field}回读不一致")
        for field in set(FIELDS) - set(updates):
            if before.fields.get(field) != after.fields.get(field):
                raise TagVerificationFailed("未选择的资料发生变化")
        changed_keys = {before.technical["keys"][field] for field in updates}
        original = {k: v for k, v in before.technical["raw"].items() if k not in changed_keys}
        current = {k: v for k, v in after.technical["raw"].items() if k not in changed_keys}
        if original != current:
            raise TagVerificationFailed("未选择的标签或封面发生变化")
        if any(before.technical[key] != after.technical[key] for key in ("sample_rate", "channels")):
            raise TagVerificationFailed("音频格式发生变化")
        if abs(before.technical["length"] - after.technical["length"]) > .02:
            raise TagVerificationFailed("音频时长发生变化")
