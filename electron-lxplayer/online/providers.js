const axios = require("axios");
const crypto = require("crypto");
const { adaptNeteaseLyricPayload } = require("../lyrics/online-payload-adapter");
const { buildUnifiedLyric, parseLyricChannel } = require("../lyrics/unified-lyric");
const { decodeKugouWordLyrics } = require("../lyrics/kugou-word-lyrics");
const { wordTimingQuality } = require("../lyrics/word-timing-quality");

function formatTime(sec) {
  const n = Number(sec) || 0;
  const m = Math.floor(n / 60).toString().padStart(2, "0");
  const s = Math.floor(n % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function sizeFormat(size) {
  const n = Number(size) || 0;
  if (!n) return "";
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function parseDurationSeconds(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 10000) return Math.floor(value / 1000);
    return Math.floor(value);
  }
  const text = String(value).trim();
  if (!text) return 0;
  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(text)) {
    const parts = text.split(":").map((x) => Number(x) || 0);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  const n = Number(text);
  if (Number.isFinite(n)) {
    if (n > 10000) return Math.floor(n / 1000);
    return Math.floor(n);
  }
  return 0;
}

function joinArtistNames(list) {
  if (!Array.isArray(list)) return "";
  return list
    .map((x) => {
      if (!x) return "";
      if (typeof x === "string") return x;
      return String(x.name || x.artistName || x.singerName || "");
    })
    .filter(Boolean)
    .join("、");
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function normalizeCoverUrl(value, source = "") {
  let cover = String(value || "").trim();
  if (!cover) return "";
  cover = cover
    .replace(/\{size\}/gi, "400")
    .replace(/^120\/120\//, "400/400/")
    .replace(/^150\/150\//, "400/400/")
    .replace(/\/120\/120\//, "/400/400/")
    .replace(/\/150\/150\//, "/400/400/");
  if (cover.startsWith("//")) cover = `https:${cover}`;
  if (/^https?:\/\//i.test(cover)) return cover.replace(/^http:\/\//i, "https://");
  if (String(source || "").toLowerCase() === "mg" && cover.startsWith("/")) {
    return `https://d.musicapp.migu.cn${cover}`;
  }
  if (String(source || "").toLowerCase() === "kw") {
    const relative = cover.replace(/^\/+/, "").replace(/^(\d+\/\d+)\/albumcover\//i, "$1/");
    return `https://img1.kuwo.cn/star/albumcover/${relative}`;
  }
  return "";
}

function buildTrack(source, raw = {}) {
  const songId = String(raw.songmid || raw.hash || raw.copyrightId || raw.songId || raw.id || "");
  if (!songId) return null;
  const artist = firstText(
    raw.singer,
    raw.artist,
    raw.author,
    raw.artistName,
    raw.singerName,
    raw.singer_name,
    joinArtistNames(raw.singerList),
    joinArtistNames(raw.singer),
    joinArtistNames(raw.ar),
    joinArtistNames(raw.artists),
  );
  const name = firstText(raw.name, raw.title, raw.songName, raw.musicName);
  const album = firstText(raw.albumName, raw.album, raw.albumname, raw.albumTitle, raw.al?.name, raw.album?.name);
  const duration = parseDurationSeconds(raw.duration || raw.interval || raw.songTimeMinutes || 0);
  let cover = normalizeCoverUrl(
    raw.img
    || raw.pic
    || raw.cover
    || raw.coverUrl
    || raw.coverImgUrl
    || raw.picUrl
    || raw.al?.picUrl
    || raw.album?.picUrl
    || "",
    source,
  );
  if (!cover) {
    const albumMid = String(raw.albumMid || raw.album?.mid || "");
    if (albumMid) {
      cover = `https://y.qq.com/music/photo_new/T002R500x500M000${encodeURIComponent(albumMid)}.jpg`;
    }
  }
  const qualities = Array.isArray(raw.types) ? raw.types.map((q) => q.type) : [];
  return {
    token: `online://${source}/${songId}`,
    source,
    songId,
    title: name,
    name,
    artist,
    album,
    durationText: /^\d+:\d{1,2}(:\d{1,2})?$/.test(String(raw.interval || "").trim())
      ? String(raw.interval).trim()
      : formatTime(duration || 0),
    duration: duration || 0,
    cover,
    qualities,
    qualityMeta: raw._types || {},
    raw,
  };
}

async function searchWy(keyword, page = 1, limit = 20, { signal } = {}) {
  const payload = new URLSearchParams({
    s: keyword,
    type: "1",
    limit: String(limit),
    offset: String((page - 1) * limit),
    total: page === 1 ? "true" : "false",
  });
  const { data } = await axios.post("https://music.163.com/api/cloudsearch/pc", payload.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://music.163.com/",
      "User-Agent": "Mozilla/5.0",
    },
    timeout: 15000,
  });
  const songs = data?.result?.songs || [];
  const list = songs.map((s) =>
    buildTrack("wy", {
      songmid: s.id,
      name: s.name,
      singer: Array.isArray(s.ar) ? s.ar.map((x) => x.name).join("、") : "",
      albumName: s.al?.name || "",
      img: s.al?.picUrl || "",
      interval: formatTime(Math.floor((s.dt || 0) / 1000)),
      types: [{ type: "128k", size: "" }, { type: "320k", size: "" }, { type: "flac", size: "" }],
    })
  ).filter(Boolean);
  return { list, total: Number(data?.result?.songCount || list.length), limit };
}

async function searchKw(keyword, page = 1, limit = 20, { signal } = {}) {
  const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keyword)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
  const { data } = await axios.get(url, { timeout: 15000, signal });
  const rows = data?.abslist || [];
  const list = rows
    .map((r) => {
      const types = [];
      const m = String(r.N_MINFO || "").split(";");
      m.forEach((x) => {
        const g = /bitrate:(\d+),format:(\w+),size:([\w.]+)/.exec(x);
        if (!g) return;
        const bitrate = g[1];
        const size = String(g[3] || "").toUpperCase();
        if (bitrate === "4000") types.push({ type: "flac24bit", size });
        else if (bitrate === "2000") types.push({ type: "flac", size });
        else if (bitrate === "320") types.push({ type: "320k", size });
        else if (bitrate === "128") types.push({ type: "128k", size });
      });
      return buildTrack("kw", {
        songmid: String(r.MUSICRID || "").replace("MUSIC_", ""),
        name: r.SONGNAME || "",
        singer: r.ARTIST || "",
        albumName: r.ALBUM || "",
        img: r.web_albumpic_short || r.web_artistpic_short || r.hts_MVPIC || "",
        interval: formatTime(Number(r.DURATION || 0)),
        types: types.reverse(),
      });
    })
    .filter(Boolean);
  return { list, total: Number(data?.TOTAL || list.length), limit };
}

async function searchKg(keyword, page = 1, limit = 20, { signal } = {}) {
  const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`;
  const { data } = await axios.get(url, { timeout: 15000, signal });
  const rows = data?.data?.lists || [];
  const list = rows
    .map((r) => {
      const types = [{ type: "128k", size: "" }];
      if (r?.HQFileSize) types.push({ type: "320k", size: sizeFormat(r.HQFileSize) });
      if (r?.SQFileSize) types.push({ type: "flac", size: sizeFormat(r.SQFileSize) });
      return buildTrack("kg", {
        hash: r.FileHash,
        songmid: r.AudioID || r.ID || r.FileHash,
        name: r.SongName || "",
        singer: r.SingerName || "",
        albumName: r.AlbumName || "",
        img: r.Image || r.AlbumImg || r.imgurl || "",
        interval: formatTime(Number(r.Duration || 0)),
        types,
      });
    })
    .filter(Boolean);
  return { list, total: Number(data?.data?.total || list.length), limit };
}

async function searchTx(keyword, page = 1, limit = 20, { signal } = {}) {
  const { data } = await axios.get("https://c.y.qq.com/soso/fcgi-bin/client_search_cp", {
    timeout: 15000,
    signal,
    signal,
    params: {
      p: page,
      n: limit,
      w: keyword,
      format: "json",
      new_json: 1,
      cr: 1,
    },
    headers: {
      Referer: "https://y.qq.com/",
      "User-Agent": "Mozilla/5.0",
    },
  });
  const rows = data?.data?.song?.list || [];
  const list = rows
    .map((r) => {
      if (!r?.mid) return null;
      return buildTrack("tx", {
        songmid: r.mid,
        name: `${r.name || ""}${r.title_extra || ""}`,
        singer: Array.isArray(r.singer) ? r.singer.map((s) => s.name).join("、") : "",
        albumName: r.album?.name || "",
        albumMid: r.album?.mid || r.albummid || "",
        interval: formatTime(r.interval || 0),
        types: [{ type: "128k", size: "" }, { type: "320k", size: "" }, { type: "flac", size: "" }],
      });
    })
    .filter(Boolean);
  return { list, total: Number(data?.data?.song?.totalnum || list.length), limit };
}

function createMgSignature(keyword) {
  const time = Date.now().toString();
  const deviceId = "963B7AA0D21511ED807EE5846EC87D20";
  const signatureMd5 = "6cdc72a439cef99a3418d2a78aa28c73";
  const sign = crypto.createHash("md5").update(`${keyword}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`).digest("hex");
  return { time, deviceId, sign };
}

async function searchMg(keyword, page = 1, limit = 20, { signal } = {}) {
  const sign = createMgSignature(keyword);
  const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(keyword)}&pageNo=${page}&sort=0&sid=USS`;
  const { data } = await axios.get(url, {
    timeout: 15000,
    signal,
    headers: {
      uiVersion: "A_music_3.6.1",
      deviceId: sign.deviceId,
      timestamp: sign.time,
      sign: sign.sign,
      channel: "0146921",
      "User-Agent": "Mozilla/5.0",
    },
  });
  const resultList = data?.songResultData?.resultList || [];
  const list = [];
  resultList.forEach((group) => {
    (group || []).forEach((r) => {
      const track = buildTrack("mg", {
        songmid: r.songId,
        copyrightId: r.copyrightId,
        name: r.name,
        singer: Array.isArray(r.singerList) ? r.singerList.map((x) => x.name).join("、") : "",
        albumName: r.album || "",
        interval: formatTime(r.duration || 0),
        img: r.img3 || r.img2 || r.img1 || "",
        types: [{ type: "128k", size: "" }, { type: "320k", size: "" }, { type: "flac", size: "" }],
      });
      if (track) list.push(track);
    });
  });
  return { list, total: Number(data?.songResultData?.totalCount || list.length), limit };
}

async function searchMusic(source, keyword, page = 1, size = 20, options = {}) {
  const s = String(source || "all");
  if (s === "all") {
    const tasks = ["kw", "kg", "tx", "wy", "mg"].map((x) =>
      searchMusic(x, keyword, page, size, options).catch(() => ({ list: [], total: 0, limit: size }))
    );
    const arr = await Promise.all(tasks);
    const list = arr.flatMap((x) => x.list);
    return { list, total: list.length, limit: size };
  }
  if (s === "kw") return searchKw(keyword, page, size, options);
  if (s === "kg") return searchKg(keyword, page, size, options);
  if (s === "tx") return searchTx(keyword, page, size, options);
  if (s === "wy") return searchWy(keyword, page, size, options);
  if (s === "mg") return searchMg(keyword, page, size, options);
  return { list: [], total: 0, limit: size };
}

async function searchSonglist(source, keyword, page = 1, size = 20) {
  const s = String(source || "all");
  if (s === "all") {
    const tasks = ["kw", "kg", "tx", "wy", "mg"].map((x) =>
      searchSonglist(x, keyword, page, size).catch(() => ({ list: [], total: 0, limit: size }))
    );
    const arr = await Promise.all(tasks);
    const list = arr.flatMap((x) => x.list);
    return { list, total: list.length, limit: size };
  }
  if (s === "wy") {
    const payload = new URLSearchParams({
      s: keyword,
      type: "1000",
      limit: String(size),
      offset: String((page - 1) * size),
      total: page === 1 ? "true" : "false",
    });
    const { data } = await axios.post("https://music.163.com/api/cloudsearch/pc", payload.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://music.163.com/" },
      timeout: 15000,
    });
    const rows = data?.result?.playlists || [];
    return {
      list: rows.map((x) => ({
        id: String(x.id),
        source: "wy",
        name: x.name || "",
        author: x.creator?.nickname || "",
        img: normalizeCoverUrl(x.coverImgUrl || "", "wy"),
        total: x.trackCount || 0,
      })),
      total: Number(data?.result?.playlistCount || 0),
      limit: size,
    };
  }
  if (s === "kw") {
    const { data } = await axios.get(
      `http://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}&pn=${page - 1}&rn=${size}&rformat=json&encoding=utf8&ver=mbox&plat=pc&ft=playlist`,
      { timeout: 15000 }
    );
    const rows = data?.abslist || [];
    return {
      list: rows.map((x) => ({ id: String(x.playlistid || ""), source: "kw", name: x.name || "", author: x.nickname || "", img: normalizeCoverUrl(x.pic || "", "kw"), total: Number(x.songnum || 0) })),
      total: Number(data?.TOTAL || rows.length),
      limit: size,
    };
  }
  if (s === "tx") {
    const { data } = await axios.get(
      `http://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?page_no=${page - 1}&num_per_page=${size}&format=json&query=${encodeURIComponent(keyword)}&remoteplace=txt.yqq.playlist&inCharset=utf8&outCharset=utf-8`,
      { timeout: 15000, headers: { Referer: "http://y.qq.com/portal/search.html", "User-Agent": "Mozilla/5.0" } }
    );
    const rows = data?.data?.list || [];
    return {
      list: rows.map((x) => ({ id: String(x.dissid || ""), source: "tx", name: x.dissname || "", author: x.creator?.name || "", img: normalizeCoverUrl(x.imgurl || "", "tx"), total: Number(x.song_count || 0) })),
      total: Number(data?.data?.sum || rows.length),
      limit: size,
    };
  }
  if (s === "mg") {
    const sign = createMgSignature(keyword);
    const { data } = await axios.get(
      `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=1&isCopyright=1&searchSwitch=%7B%22song%22%3A0%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22bestShow%22%3A0%2C%22songlist%22%3A1%2C%22lyricSong%22%3A0%7D&pageSize=${size}&text=${encodeURIComponent(keyword)}&pageNo=${page}&sort=0&sid=USS`,
      { timeout: 15000, headers: { deviceId: sign.deviceId, timestamp: sign.time, sign: sign.sign, channel: "0146921", uiVersion: "A_music_3.6.1" } }
    );
    const rows = data?.songListResultData?.result || [];
    return {
      list: rows.map((x) => ({ id: String(x.id || ""), source: "mg", name: x.name || "", author: x.userName || "", img: normalizeCoverUrl(x.musicListPicUrl || "", "mg"), total: Number(x.musicNum || 0) })),
      total: Number(data?.songListResultData?.totalCount || rows.length),
      limit: size,
    };
  }
  if (s === "kg") {
    const { data } = await axios.get(
      `http://msearchretry.kugou.com/api/v3/search/special?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${size}&showtype=10&filter=0&version=7910&sver=2`,
      { timeout: 15000 }
    );
    const rows = data?.data?.info || [];
    return {
      list: rows.map((x) => ({ id: String(x.specialid || ""), source: "kg", name: x.specialname || "", author: x.nickname || "", img: normalizeCoverUrl(x.imgurl || "", "kg"), total: Number(x.songcount || 0) })),
      total: Number(data?.data?.total || rows.length),
      limit: size,
    };
  }
  return { list: [], total: 0, limit: size };
}

function adaptPlainLyricChannels({ source, main = "", translation = "", romanization = "" } = {}) {
  const channels = {};
  for (const [role, text] of Object.entries({ main, translation, romanization })) {
    if (!String(text || "").trim()) continue;
    try {
      const parsed = parseLyricChannel(String(text), {
        role,
        format: "lrc",
        sourceId: `online:${source}:${role}`,
      });
      if (parsed.lines.length) channels[role] = parsed;
    } catch (_) {}
  }
  if (!channels.main) return { lyricsModel: null, provenance: { provider: source } };
  return {
    lyricsModel: buildUnifiedLyric(channels, { identityReason: "online_song_id", toleranceMs: 80 }),
    provenance: { provider: source },
  };
}

function adaptKuwoLyricPayload(payload = {}) {
  const rows = Array.isArray(payload?.data?.lrclist) ? payload.data.lrclist : [];
  const main = rows.map((row) => {
    const seconds = Number(row?.time);
    const text = String(row?.lineLyric || "").trim();
    if (!Number.isFinite(seconds) || seconds < 0 || !text) return "";
    const minutes = Math.floor(seconds / 60);
    const remainder = (seconds - minutes * 60).toFixed(3).padStart(6, "0");
    return `[${String(minutes).padStart(2, "0")}:${remainder}]${text}`;
  }).filter(Boolean).join("\n");
  return adaptPlainLyricChannels({ source: "kuwo", main });
}

async function getLyric(source, songId, musicInfo = null, { signal } = {}) {
  if (source === "wy") {
    const normalizedSongId = String(songId || "").trim();
    if (!/^\d{1,20}$/.test(normalizedSongId)) {
      throw new Error("invalid online song id");
    }
    const requestOptions = {
      timeout: 10000, signal,
      headers: {
        Referer: "https://music.163.com/",
        "User-Agent": "Flowave/0.1.0",
      },
    };
    // Ask the word-capable endpoint first; its absence/failure must not remove LRC.
    let data;
    try {
      ({ data } = await axios.get(`https://music.163.com/api/song/lyric/v1?id=${encodeURIComponent(normalizedSongId)}&lv=-1&tv=-1&rv=-1&yv=-1&ytv=-1&yrv=-1`, requestOptions));
      if (!adaptNeteaseLyricPayload(data).lyricsModel) throw new Error("empty lyric response");
    } catch (error) {
      if (signal?.aborted) throw error;
      ({ data } = await axios.get(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(normalizedSongId)}&lv=-1&kv=-1&tv=-1&rv=-1&yv=-1&ytv=-1&yrv=-1`, requestOptions));
    }
    return adaptNeteaseLyricPayload(data);
  }
  if (source === "tx") {
    const normalizedSongId = String(songId || "").trim();
    if (!/^[A-Za-z0-9]{8,32}$/.test(normalizedSongId)) throw new Error("invalid online song id");
    const { data } = await axios.get("https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg", {
      params: { songmid: normalizedSongId, format: "json", nobase64: 1, g_tk: 5381 },
      timeout: 15000, signal,
      headers: {
        Referer: "https://y.qq.com/",
        Origin: "https://y.qq.com",
        "User-Agent": "Flowave/0.1.0",
      },
    });
    return adaptPlainLyricChannels({
      source: "qq-music",
      main: data?.lyric,
      translation: data?.trans,
      romanization: data?.roma,
    });
  }
  if (source === "kg") {
    const raw = musicInfo?.raw && typeof musicInfo.raw === "object" ? musicInfo.raw : {};
    const normalizedSongId = String(songId || raw.songmid || "").trim();
    const hash = String(raw.hash || "").trim().toUpperCase();
    const durationMs = Math.round(Math.max(0, Number(musicInfo?.duration || 0)) * 1000);
    if (!/^\d{1,20}$/.test(normalizedSongId) || !/^[A-F0-9]{32}$/.test(hash) || !durationMs) {
      throw new Error("invalid online song info");
    }
    const keyword = [musicInfo?.artist, musicInfo?.title].map((value) => String(value || "").trim()).filter(Boolean).join(" - ");
    const { data: searchData } = await axios.get("https://lyrics.kugou.com/search", {
      params: { ver: 1, man: "yes", client: "mobi", keyword, duration: durationMs, hash },
      timeout: 10000, signal,
      headers: { "User-Agent": "Flowave/0.1.0" },
    });
    const lyricCandidates = (Array.isArray(searchData?.candidates) ? searchData.candidates : [])
      .filter(item => item?.id && item?.accesskey && (!Number(item.duration) || Math.abs(Number(item.duration) - durationMs) <= 4000)).slice(0, 2);
    let bestKrc = null;
    for (const lyricInfo of lyricCandidates) {
      if (signal?.aborted) throw new Error("lyric query aborted");
      try {
        const { data } = await axios.get("https://lyrics.kugou.com/download", {
          params: { ver: 1, client: "mobi", id: String(lyricInfo.id), accesskey: String(lyricInfo.accesskey), fmt: "krc", charset: "utf8" },
          timeout: 8000, signal, maxContentLength: 8 * 1024 * 1024,
          headers: { "User-Agent": "Flowave/0.1.0" },
        });
        const lyricsModel = decodeKugouWordLyrics(data?.content);
        const quality = wordTimingQuality(lyricsModel);
        if (!bestKrc || quality.coverage > bestKrc.quality.coverage
          || (quality.coverage === bestKrc.quality.coverage && quality.textCoverage > bestKrc.quality.textCoverage)) {
          bestKrc = { lyricsModel, quality };
        }
        if (quality.complete) break;
      } catch (error) { if (signal?.aborted) throw error; }
    }
    if (bestKrc) return { lyricsModel: bestKrc.lyricsModel, provenance: { provider: "kugou", format: "krc" } };
    const lyricInfo = lyricCandidates[0];
    if (!lyricInfo?.id || !lyricInfo?.accesskey) return { lyricsModel: null, provenance: { provider: "kugou" } };
    const { data } = await axios.get("https://lyrics.kugou.com/download", {
      params: {
        ver: 1,
        client: "mobi",
        id: String(lyricInfo.id),
        accesskey: String(lyricInfo.accesskey),
        fmt: "lrc",
        charset: "utf8",
      },
      timeout: 10000, signal,
      headers: { "User-Agent": "Flowave/0.1.0" },
    });
    let main = "";
    try {
      main = Buffer.from(String(data?.content || ""), "base64").toString("utf8");
    } catch (_) {}
    return adaptPlainLyricChannels({ source: "kugou", main });
  }
  if (source === "kw") {
    const normalizedSongId = String(songId || "").trim();
    if (!/^\d{1,20}$/.test(normalizedSongId)) throw new Error("invalid online song id");
    const { data } = await axios.get("https://m.kuwo.cn/newh5/singles/songinfoandlrc", {
      params: { musicId: normalizedSongId },
      timeout: 15000, signal,
      headers: { Referer: "https://m.kuwo.cn/", "User-Agent": "Flowave/0.1.0" },
    });
    return adaptKuwoLyricPayload(data);
  }
  return { lyricsModel: null, provenance: null };
}

async function getWySonglistTracks(id, page = 1, size = 50) {
  const { data } = await axios.get(`https://music.163.com/api/v3/playlist/detail?id=${encodeURIComponent(id)}&n=1000&s=8`, {
    timeout: 15000,
    headers: { Referer: "https://music.163.com/" },
  });
  const trackIds = (data?.playlist?.trackIds || []).map((x) => x.id).filter(Boolean);
  const total = trackIds.length;
  const start = (page - 1) * size;
  const ids = trackIds.slice(start, start + size);
  if (!ids.length) return { list: [], total, limit: size };
  const { data: detailData } = await axios.get(
    `https://music.163.com/api/song/detail?ids=${encodeURIComponent(JSON.stringify(ids))}`,
    { timeout: 15000, headers: { Referer: "https://music.163.com/" } }
  );
  const rows = detailData?.songs || [];
  const list = rows.map((s) =>
    buildTrack("wy", {
      songmid: s.id,
      name: s.name,
      singer: Array.isArray(s.artists) ? s.artists.map((x) => x.name).join("、") : (Array.isArray(s.ar) ? s.ar.map((x) => x.name).join("、") : ""),
      singerList: s.artists || s.ar || [],
      albumName: s.album?.name || s.al?.name || "",
      img: s.album?.picUrl || s.al?.picUrl || "",
      duration: s.duration || s.dt || 0,
      interval: s.duration || s.dt || 0,
      types: [{ type: "128k", size: "" }, { type: "320k", size: "" }, { type: "flac", size: "" }],
    })
  ).filter(Boolean);
  return { list, total, limit: size };
}

async function getKwSonglistTracks(id, page = 1, size = 100) {
  const url = `http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${encodeURIComponent(id)}&pn=${Math.max(0, page - 1)}&rn=${size}&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`;
  const { data } = await axios.get(url, { timeout: 15000 });
  const rows = data?.musiclist || [];
  const list = rows.map((r) => {
    const types = [];
    String(r.N_MINFO || "").split(";").forEach((x) => {
      const g = /bitrate:(\d+),format:(\w+),size:([\w.]+)/.exec(x);
      if (!g) return;
      if (g[1] === "4000") types.push({ type: "flac24bit", size: g[3] });
      else if (g[1] === "2000") types.push({ type: "flac", size: g[3] });
      else if (g[1] === "320") types.push({ type: "320k", size: g[3] });
      else if (g[1] === "128") types.push({ type: "128k", size: g[3] });
    });
    return buildTrack("kw", {
      songmid: r.id || r.rid || r.musicrid || r.MUSICRID || "",
      name: r.name || r.songname || r.SONGNAME || "",
      singer: r.artist || r.artistname || r.ARTIST || "",
      albumName: r.album || r.albumname || r.ALBUM || "",
      duration: r.duration || r.DURATION || r.interval || "",
      interval: r.duration || r.DURATION || r.interval || "",
      img: r.pic || r.web_albumpic_short || "",
      types: types.reverse(),
    });
  }).filter(Boolean);
  return { list, total: Number(data?.total || list.length), limit: size };
}

async function getTxSonglistTracks(id) {
  const url = `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${encodeURIComponent(id)}&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`;
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: {
      Referer: `https://y.qq.com/n/ryqq/playlist/${id}`,
      "User-Agent": "Mozilla/5.0",
    },
  });
  const rows = data?.cdlist?.[0]?.songlist || [];
  const list = rows.map((item) => {
    const r = item?.songInfo || item || {};
    return buildTrack("tx", {
      songmid: r.mid || r.songmid || r.id || "",
      name: r.title || r.name || "",
      singer: Array.isArray(r.singer) ? r.singer.map((x) => x.name).join("、") : (r.singerName || ""),
      singerList: Array.isArray(r.singer) ? r.singer : [],
      albumName: r.album?.name || r.albumname || "",
      albumMid: r.album?.mid || r.albummid || "",
      duration: r.interval || r.duration || 0,
      interval: r.interval || r.duration || 0,
      types: [{ type: "128k", size: "" }, { type: "320k", size: "" }, { type: "flac", size: "" }],
    });
  }).filter(Boolean);
  return { list, total: rows.length, limit: rows.length || 1 };
}

async function getMgSonglistTracks(id, page = 1, size = 50) {
  const url = `https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo=${page}&pageSize=${size}&playlistId=${encodeURIComponent(id)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  const rows = data?.data?.songList || [];
  const list = rows.map((r) =>
    buildTrack("mg", {
      songmid: r.songId || r.id,
      copyrightId: r.copyrightId,
      name: r.songName || r.name || "",
      singer: Array.isArray(r.singerList) ? r.singerList.map((x) => x.name).join("、") : (r.singer || r.artist || ""),
      singerList: r.singerList || [],
      albumName: r.albumName || "",
      duration: r.duration || r.length || 0,
      interval: r.duration || r.length || 0,
      img: r.img1 || r.img2 || r.img3 || r.picUrl || "",
      types: [{ type: "128k", size: "" }, { type: "320k", size: "" }, { type: "flac", size: "" }],
    })
  ).filter(Boolean);
  return { list, total: Number(data?.data?.totalCount || list.length), limit: size };
}

async function getSonglistTracks(source, id, page = 1, size = 50) {
  if (source === "wy") return getWySonglistTracks(id, page, size);
  if (source === "kw") return getKwSonglistTracks(id, page, size);
  if (source === "tx") return getTxSonglistTracks(id);
  if (source === "mg") return getMgSonglistTracks(id, page, size);
  if (source === "kg") {
    throw new Error("kg songlist detail not supported currently");
  }
  throw new Error("unsupported source");
}

module.exports = {
  searchMusic,
  searchSonglist,
  getSonglistTracks,
  getLyric,
  __test: {
    adaptKuwoLyricPayload,
    adaptPlainLyricChannels,
    buildTrack,
    normalizeCoverUrl,
  },
};
