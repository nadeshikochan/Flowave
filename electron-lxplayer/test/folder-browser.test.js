const test=require("node:test");
const assert=require("node:assert/strict");
const folders=require("../renderer/folder-browser");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {revealLocalTrack, createSongTrash}=require("../local-file-actions");

test("folder browser preserves direct song order, nested paths and case-insensitive roots",()=>{
  const paths=["D:/Music/root.mp3","d:\\music\\part1\\second.mp3","D:/Music/part1/first.mp3","D:/Music/part1/sub/third.mp3","D:/MusicExtra/other.mp3","online://wy/1"];
  const tree=folders.build(paths.map(path=>({path})),"D:\\Music\\");
  assert.deepEqual(tree.root.tracks,[paths[0]]);assert.equal(tree.root.count,4);
  const part=tree.nodes.get("d:/music/part1");
  assert.deepEqual(part.tracks,[paths[1],paths[2]]);assert.equal(part.count,3);
  assert.deepEqual(folders.breadcrumbs(tree,"D:/Music/part1/sub").map(n=>n.name),["音乐文件夹","part1","sub"]);
  assert.equal(folders.breadcrumbs(tree,"Z:/offline").at(-1),tree.root);
});

test("folder browser supports UNC paths without merging same-name sibling folders",()=>{
  const tree=folders.build(["a","b"].map(x=>({path:`\\\\server\\music\\${x}\\same\\song.mp3` })),"\\\\server\\music");
  assert.equal(tree.root.count,2);assert.equal(tree.root.children.length,2);
  assert.notEqual(tree.root.children[0].children[0],tree.root.children[1].children[0]);
});

test("reveal validates audio files and forwards exact path without a shell command",async()=>{
  const seen=[];const options={shell:{showItemInFolder:p=>seen.push(p)},stat:async()=>({isFile:()=>true})};
  const file="D:\\Music\\歌手 & [1]\\song.mp3";
  assert.equal((await revealLocalTrack(file,options)).ok,true);assert.deepEqual(seen,[file]);
  for(const bad of ["online://wy/1","https://example.org/a.mp3","relative.mp3","C:\\temp\\script.cmd",null]) assert.equal((await revealLocalTrack(bad,options)).ok,false);
  assert.equal(seen.length,1);
  assert.equal((await revealLocalTrack(file,{...options,stat:async()=>({isFile:()=>false})})).ok,false);
  assert.match((await revealLocalTrack(file,{...options,stat:async()=>{throw Object.assign(new Error(),{code:"ENOENT"});}})).message,/不存在/);
});

async function trashFixture(t, trashItem) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flowave-trash-test-"));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const write = async name => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), {recursive:true});
    await fs.writeFile(file, name);
    return file;
  };
  const audio = await write("album/曲 & [1].mp3");
  const moved = [];
  const retired = [];
  const service = createSongTrash({
    getRoots: () => [root],
    async verifyTrack(file, id) {
      if (file !== audio || (id && id !== "track-1")) throw Error("identity");
      return "track-1";
    },
    withLyricLock: (_target, operation) => operation(),
    ensureIdle: async () => {},
    async trashItem(file) {
      await trashItem?.(file);
      await fs.rename(file, path.join(root, "recycled-" + moved.length));
      moved.push(file);
    },
    async onTrashed(...track) { retired.push(track); },
  });
  return {write, audio, moved, retired, service};
}

test("trash plans exact local sidecars and preserves same-title songs in other folders", async t => {
  const {write, audio, moved, retired, service} = await trashFixture(t);
  const lyric = await write("album/曲 & [1].lrc");
  const ktv = await write("KTV歌词/album/曲 & [1].qrc");
  const cover = await write("album/曲 & [1].mp3.cover.png");
  const preserved = await Promise.all(["album/cover.jpg", "album/曲 & [1].txt", "other/曲 & [1].mp3",
    "other/曲 & [1].lrc", "KTV歌词/other/曲 & [1].lrc"].map(write));
  await assert.rejects(service.prepare("online://wy/1"), /identity/);
  const plan = await service.prepare(audio);
  assert.deepEqual(new Set(plan.files.map(item => item.file)), new Set([audio, lyric, ktv, cover]));
  assert.deepEqual(moved, []);
  assert.deepEqual(await service.commit(plan.token), {ok:true, moved:4, remaining:[], refreshFailed:false});
  assert.equal(moved[0], audio);
  assert.deepEqual(retired, [[audio, "track-1"]]);
  for (const file of preserved) await fs.access(file);
  await assert.rejects(service.commit(plan.token), /失效/);
});

test("trash excludes linked, shared and filename-ambiguous sidecars", async t => {
  const {write, audio, moved, service} = await trashFixture(t);
  const preserved = await Promise.all(["album/曲 & [1].flac", "album/曲 & [1].lrc",
    "KTV歌词/album/曲 & [1].lrc", "album/曲 & [1].mp3.cover.jpg", "album/曲 & [1].mp3.flac",
    "album/曲 & [1].mp3.lrc", "other/independent.qrc"].map(write));
  const linked = path.join(path.dirname(audio), "曲 & [1].mp3.qrc");
  await fs.link(preserved.at(-1), linked);
  const plan = await service.prepare(audio);
  assert.deepEqual(plan.files, [{file:audio, kind:"音频"}]);
  await service.commit(plan.token);
  assert.deepEqual(moved, [audio]);
  for (const file of [...preserved, linked]) await fs.access(file);
});

test("trash rejects changed inventory and leaves lyrics intact when audio recycle fails", async t => {
  let denyAudio = true;
  const {write, audio, moved, service} = await trashFixture(t, file => {
    if (denyAudio && file === audio) throw Error("occupied");
  });
  const lyric = await write("album/曲 & [1].lrc");
  const before = await service.prepare(audio);
  await fs.appendFile(lyric, "\nchanged");
  await assert.rejects(service.commit(before.token), /变化/);
  const attempt = await service.prepare(audio);
  await assert.rejects(service.commit(attempt.token), /无法移到回收站/);
  assert.deepEqual(moved, []);
  await fs.access(lyric);
  denyAudio = false;
  const allowed = await service.prepare(audio);
  assert.equal((await service.commit(allowed.token)).moved, 2);
});

test("trash reports sidecar failure and protects a song that appears during recycle", async t => {
  const {write, audio, moved, service} = await trashFixture(t, async file => {
    if (file === audio) await write("album/曲 & [1].flac");
    if (file.endsWith(".qrc")) throw Error("occupied");
  });
  const shared = await write("album/曲 & [1].lrc");
  const blocked = await write("album/曲 & [1].mp3.qrc");
  const plan = await service.prepare(audio);
  const result = await service.commit(plan.token);
  assert.deepEqual(new Set(result.remaining), new Set([shared, blocked]));
  assert.deepEqual(moved, [audio]);
});
