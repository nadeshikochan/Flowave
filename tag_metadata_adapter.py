"""Shared field validation for explicitly confirmed text metadata edits."""


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
