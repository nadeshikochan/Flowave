const fs = require("fs");
const path = require("path");
const { randomUUID } = require("node:crypto");
const { isContainedPath, legacyPartitionLyricPathForAudio, preferredLyricPathForAudio } = require("./lyrics/mirrored-lyric-paths");
const audioExtensions = new Set([".mp3",".flac",".wav",".ogg",".opus",".m4a",".aac",".wma",".ape",".aif",".aiff",".alac",".wv",".dsf",".dff"]);
const lyricExtensions = new Set([".lrc", ".yrc", ".qrc", ".lyric", ".lyrics"]);
const coverExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const fileKey = value => path.resolve(value).toLowerCase();
const isAudioName = value => audioExtensions.has(path.extname(value).toLowerCase());
const hasOtherOwner = (entries, audioName, file, kind) => {
  const owner = path.parse(file.toLowerCase()).name;
  return entries.some(entry => !entry.isDirectory() && isAudioName(entry.name)
    && entry.name.toLowerCase() !== audioName
    && (kind === "封面" || path.parse(entry.name).name.toLowerCase() === owner));
};

async function revealLocalTrack(value, { shell, stat = file => fs.promises.stat(file) }) {
  const file = typeof value === "string" ? value.trim() : "";
  if (!file || file.includes("\0") || !path.win32.isAbsolute(file) || /^\w+:\/\//.test(file)
    || !audioExtensions.has(path.win32.extname(file).toLowerCase())) {
    return {ok:false,message:"只能定位本地音频文件。"};
  }
  try {
    const normalized=path.win32.normalize(file);
    if (!(await stat(normalized)).isFile()) return {ok:false,message:"歌曲文件不存在，请刷新音乐库。"};
    shell.showItemInFolder(normalized);
    return {ok:true};
  } catch (error) {
    return {ok:false,message:error?.code==="ENOENT" ? "歌曲文件不存在，请刷新音乐库。" : "无法定位歌曲，请检查文件是否可访问。"};
  }
}
async function verifiedFile(file) {
  try {
    const [stat, real] = await Promise.all([fs.promises.lstat(file, { bigint: true }), fs.promises.realpath(file)]);
    if (!stat.isFile() || stat.nlink !== 1n || fileKey(real) !== fileKey(file)) return null;
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
}

async function inspectSongTrash(trackPath, roots) {
  if (typeof trackPath !== "string" || !path.isAbsolute(trackPath) || trackPath.includes("\0")
    || !audioExtensions.has(path.extname(trackPath).toLowerCase())) throw Error("只能删除曲库中的本地歌曲。");
  const audio = path.resolve(trackPath);
  const root = roots.find(value => value && isContainedPath(value, audio));
  const revision = root && await verifiedFile(audio);
  if (!revision) throw Error("歌曲已移动、不可用，或通过链接共享。请刷新曲库后重试。");

  const directory = path.dirname(audio);
  const audioName = path.basename(audio);
  const stem = path.basename(audio, path.extname(audio)).toLowerCase();
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  if (entries.filter(entry => entry.name.toLowerCase() === audioName.toLowerCase()).length !== 1)
    throw Error("发现同名音频路径，请先在文件夹中核对歌曲。");
  const candidates = new Map();
  const ambiguous = new Set();
  function add(file, kind) {
    if (hasOtherOwner(entries, audioName.toLowerCase(), file, kind)) return;
    const key = fileKey(file);
    if (ambiguous.has(key)) return;
    if (candidates.has(key) && candidates.get(key).file !== file) {
      candidates.delete(key);
      ambiguous.add(key);
    } else candidates.set(key, {file, kind});
  }
  for (const entry of entries) {
    const { name, ext } = path.parse(entry.name.toLowerCase());
    if (lyricExtensions.has(ext) && (name === stem || name === audioName.toLowerCase())) {
      // Song.mp3.lrc could also be the unqualified sidecar of Song.mp3.flac.
      add(path.join(directory, entry.name), "歌词");
    } else if (coverExtensions.has(ext) && !["cover", "folder", "album", "front"].includes(name)
        && (name === stem || name === audioName.toLowerCase() + ".cover" || name === audioName.toLowerCase())) {
      add(path.join(directory, entry.name), "封面");
    }
  }
  const lyricTarget = preferredLyricPathForAudio(audio, root);
  const mirrorDirectories = new Set([path.dirname(lyricTarget)]);
  const legacy = legacyPartitionLyricPathForAudio(audio);
  if (legacy && isContainedPath(root, legacy)) mirrorDirectories.add(path.dirname(legacy));
  mirrorDirectories.delete(directory);
  for (const folder of mirrorDirectories) {
    let names;
    try { names = await fs.promises.readdir(folder); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const name of names) {
      const parsed = path.parse(name.toLowerCase());
      if (lyricExtensions.has(parsed.ext) && [stem, audioName.toLowerCase()].includes(parsed.name))
        add(path.join(folder, name), "歌词");
    }
  }
  const files = [{file: audio, kind: "音频", revision}];
  for (const item of [...candidates.values()].sort((left, right) => left.file.localeCompare(right.file))) {
    const stamp = await verifiedFile(item.file);
    if (stamp) files.push({ ...item, revision: stamp });
  }
  return { audio, lyricTarget, files };
}

function createSongTrash({ trashItem, verifyTrack, getRoots, withLyricLock, ensureIdle, onTrashed }) {
  let pending = null;
  let preparing = false;
  let active = null;
  return {
    get running() { return Boolean(active); },
    drain() { return active?.catch(() => {}); },
    async prepare(trackPath, resourceId) {
      if (active || preparing) throw Error("正在处理另一首歌的删除操作。");
      pending = null;
      preparing = true;
      try {
        const identity = await verifyTrack(trackPath, resourceId);
        const plan = await inspectSongTrash(trackPath, getRoots());
        const token = randomUUID();
        pending = { ...plan, token, resourceId: identity, expires: Date.now() + 3 * 60 * 1000 };
        return {ok: true, token, path: plan.audio,
          files: plan.files.map(({file, kind}) => ({file, kind}))};
      } finally { preparing = false; }
    },
    async commit(token) {
      const request = pending;
      if (active || !request || request.token !== token || Date.now() > request.expires) {
        throw Error("删除确认已失效，请重新打开菜单。");
      }
      pending = null;
      active = withLyricLock(request.lyricTarget, async () => {
        await ensureIdle(request.audio);
        await verifyTrack(request.audio, request.resourceId);
        const current = await inspectSongTrash(request.audio, getRoots());
        if (current.lyricTarget !== request.lyricTarget || JSON.stringify(current.files) !== JSON.stringify(request.files)) {
          throw Error("歌曲或关联文件已变化，请重新确认删除范围。");
        }
        const remaining = [];
        for (const item of current.files) {
          try {
            if (item.kind !== "音频") {
              const entries = await fs.promises.readdir(path.dirname(current.audio), {withFileTypes:true});
              if (entries.some(entry => entry.name.toLowerCase() === path.basename(current.audio).toLowerCase())
                  || hasOtherOwner(entries, path.basename(current.audio).toLowerCase(), item.file, item.kind))
                throw Error("sidecar owner changed");
            }
            if (await verifiedFile(item.file) !== item.revision) throw Error("file changed");
            await trashItem(item.file);
          } catch (_) {
            if (item.kind === "音频") throw Error("歌曲无法移到回收站。请检查文件是否被占用或磁盘是否支持回收站。");
            remaining.push(item.file);
          }
        }
        let refreshFailed = false;
        try { await onTrashed(current.audio, request.resourceId); }
        catch (_) { refreshFailed = true; }
        return {ok: true, remaining, moved: current.files.length - remaining.length, refreshFailed};
      });
      try {
        return await active;
      } finally { active = null; }
    },
  };
}

module.exports = {revealLocalTrack, createSongTrash};
