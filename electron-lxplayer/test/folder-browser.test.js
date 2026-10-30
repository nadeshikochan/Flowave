const test=require("node:test");
const assert=require("node:assert/strict");
const folders=require("../renderer/folder-browser");
const {revealLocalTrack}=require("../local-file-actions");

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
