const path = require("node:path");

const KTV_DIRECTORY_NAME = "KTV歌词";
const PARTITION_CONTAINER_NAME = "lx.music";

function normalizedKey(value) {
  return path.resolve(String(value || "")).toLocaleLowerCase();
}

function isContainedPath(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function libraryLyricRoot(audioRoot) {
  const root = String(audioRoot || "").trim();
  return root && path.isAbsolute(root) ? path.join(path.resolve(root), KTV_DIRECTORY_NAME) : "";
}

function mirroredLyricRootForAudio(audioPath, audioRoot) {
  const root = String(audioRoot || "").trim();
  const target = String(audioPath || "").trim();
  if (!root || !target || !path.isAbsolute(root) || !path.isAbsolute(target)) return "";
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const lyricRoot = libraryLyricRoot(resolvedRoot);
  if (!isContainedPath(resolvedRoot, resolvedTarget) || isContainedPath(lyricRoot, resolvedTarget)) return "";
  return path.join(lyricRoot, path.relative(resolvedRoot, path.dirname(resolvedTarget)));
}

function legacyLyricPathForAudio(audioPath) {
  const target = path.resolve(String(audioPath || ""));
  const extension = path.extname(target);
  return path.join(path.dirname(target), `${path.basename(target, extension)}.lrc`);
}

// 仅用于恢复短期分区内目录实现创建的历史事务，今后不再向这里保存。
function legacyPartitionLyricPathForAudio(audioPath) {
  const target = path.resolve(String(audioPath || ""));
  let current = path.dirname(target);
  while (true) {
    const parent = path.dirname(current);
    if (path.basename(parent).toLocaleLowerCase() === PARTITION_CONTAINER_NAME) {
      return path.join(current, KTV_DIRECTORY_NAME, `${path.basename(target, path.extname(target))}.lrc`);
    }
    if (parent === current) return "";
    current = parent;
  }
}

function preferredLyricPathForAudio(audioPath, audioRoot) {
  const target = path.resolve(String(audioPath || ""));
  const lyricRoot = mirroredLyricRootForAudio(target, audioRoot);
  return lyricRoot
    ? path.join(lyricRoot, `${path.basename(target, path.extname(target))}.lrc`)
    : legacyLyricPathForAudio(target);
}

function isSupportedLyricPathForAudio(audioPath, lyricPath, audioRoot) {
  const candidateKey = normalizedKey(lyricPath);
  return [
    preferredLyricPathForAudio(audioPath, audioRoot),
    legacyLyricPathForAudio(audioPath),
    legacyPartitionLyricPathForAudio(audioPath),
  ].filter(Boolean).some((value) => normalizedKey(value) === candidateKey);
}

module.exports = {
  KTV_DIRECTORY_NAME,
  PARTITION_CONTAINER_NAME,
  isContainedPath,
  isSupportedLyricPathForAudio,
  legacyLyricPathForAudio,
  legacyPartitionLyricPathForAudio,
  libraryLyricRoot,
  mirroredLyricRootForAudio,
  preferredLyricPathForAudio,
};
