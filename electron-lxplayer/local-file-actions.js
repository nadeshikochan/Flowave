const fs = require("fs");
const path = require("path");
const audioExtensions = new Set([".mp3",".flac",".wav",".ogg",".opus",".m4a",".aac",".wma",".ape",".aif",".aiff",".alac",".wv",".dsf",".dff"]);

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
module.exports = {revealLocalTrack};
