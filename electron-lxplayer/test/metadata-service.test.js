const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const tempCacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flowave-metadata-cache-"));
const previousCacheDir = process.env.KUMIKO_CACHE_DIR;
process.env.KUMIKO_CACHE_DIR = tempCacheRoot;
const {
  __test,
  getMeta,
  flushMetadataCache,
  invalidateTrackMetadata,
  invalidateLyricSources,
  resolveExternalLyricsForOnline,
  resolveLocalLyricsForLookup,
  setExternalLyricRoot,
  setLibraryAudioRoot,
} = require("../metadata-service");

test.after(async () => {
  await flushMetadataCache();
  setExternalLyricRoot("");
  setLibraryAudioRoot("");
  if (previousCacheDir === undefined) delete process.env.KUMIKO_CACHE_DIR;
  else process.env.KUMIKO_CACHE_DIR = previousCacheDir;
  const resolved = path.resolve(tempCacheRoot);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
  fs.rmSync(resolved, { recursive: true, force: true });
});

test("performance list metadata defers lyrics without poisoning later playback lookup", async () => {
  const trackPath = path.join(tempCacheRoot, "Singer - Performance Song.mp3");
  await fs.promises.writeFile(trackPath, "invalid audio fixture");
  await fs.promises.writeFile(trackPath.replace(/\.mp3$/, ".lrc"), "[ti:Performance Song]\n[ar:Singer]\n[00:01.00]Hello");
  const listInfo = await getMeta(trackPath, { includeLyrics: false, resourceId: "performance-song" });
  assert.equal(Object.hasOwn(listInfo, "lyrics"), false);
  assert.equal(Object.hasOwn(listInfo, "lyricsModel"), false);
  const playbackInfo = await getMeta(trackPath, { includeLyricsModel: true, resourceId: "performance-song" });
  assert.match(playbackInfo.lyrics, /Hello/);
  assert.equal(playbackInfo.lyricsModel.schemaVersion, 1);
  const laterListInfo = await getMeta(trackPath, { includeLyrics: false });
  assert.equal(Object.hasOwn(laterListInfo, "lyrics"), false);
});

test("audio detail reads real PCM format and enriches legacy cache without lyrics", async () => {
  const trackPath=path.join(tempCacheRoot,"Audio Details.wav");
  const frames=441, pcm=Buffer.alloc(44+frames*4);
  pcm.write("RIFF",0);pcm.writeUInt32LE(pcm.length-8,4);pcm.write("WAVEfmt ",8);
  pcm.writeUInt32LE(16,16);pcm.writeUInt16LE(1,20);pcm.writeUInt16LE(2,22);
  pcm.writeUInt32LE(44100,24);pcm.writeUInt32LE(176400,28);pcm.writeUInt16LE(4,32);pcm.writeUInt16LE(16,34);
  pcm.write("data",36);pcm.writeUInt32LE(frames*4,40);
  await fs.promises.writeFile(trackPath,pcm);
  const options={includeLyrics:false,includeAudioDetails:true,resourceId:"audio-details"};
  const cold=await getMeta(trackPath,options);
  assert.equal(cold.audioInfo.sampleRate,44100);
  assert.equal(cold.audioInfo.bitsPerSample,16);
  assert.equal(cold.audioInfo.channels,2);
  assert.equal(cold.audioInfo.size,pcm.length);
  assert.equal(cold.audioInfo.bitrate,1411200);
  assert.equal(Object.hasOwn(cold,"lyrics"),false);
  for(const item of __test.cache.values())if(item.path===trackPath)delete item.audioInfo;
  assert.equal((await getMeta(trackPath,{includeLyrics:false})).audioInfo,undefined);
  const enriched=await getMeta(trackPath,options);
  assert.equal(enriched.audioInfo.sampleRate,44100);
  assert.equal(enriched.audioInfo.bitsPerSample,16);
  assert.equal(Object.hasOwn(enriched,"lyrics"),false);
  assert.equal(__test.audioFormatDetails({bitrate:NaN,lossless:false},{}).bitrate,null);
  assert.equal(__test.audioFormatDetails({codec:"MP3"},{}).bitsPerSample,null);
});

test("performance metadata invalidation finds matching identities without scanning the cache", async () => {
  __test.cache.clear();
  const trackPath = path.join(tempCacheRoot, "performance-index.mp3");
  const identity = __test.metadataIdentity(trackPath, "performance-index");
  for (let index = 0; index < 100; index += 1) {
    const otherPath = path.join(tempCacheRoot, `other-${index}.mp3`);
    __test.cache.set(`${otherPath}|1`, { _cacheIdentity: __test.metadataIdentity(otherPath, `other-${index}`) });
  }
  __test.cache.set(`${trackPath}|old`, { _cacheIdentity: identity });
  __test.cache.set(`${trackPath}|new`, { _cacheIdentity: identity });
  const iterator = __test.cache[Symbol.iterator];
  __test.cache[Symbol.iterator] = () => { throw new Error("full cache scan"); };
  try {
    assert.equal(__test.pruneSupersededCacheEntries(identity, `${trackPath}|new`), 1);
    assert.equal((await invalidateTrackMetadata({ resourceId: identity.resourceId })).invalidated, 1);
    assert.equal(__test.cache.size, 100);
  } finally {
    __test.cache[Symbol.iterator] = iterator;
  }
});

test("online lyrics search the complete mirrored KTV library", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-online-mirror-"));
  const part1 = path.join(root, "KTV歌词", "lx.music", "part1");
  const part2 = path.join(root, "KTV歌词", "lx.music", "part2");
  await Promise.all([
    fs.promises.mkdir(part1, { recursive: true }),
    fs.promises.mkdir(part2, { recursive: true }),
  ]);
  await fs.promises.writeFile(
    path.join(part2, "Singer - Online Song.lrc"),
    "[ti:Online Song]\n[ar:Singer]\n[00:01.00]Mirrored lyric",
    "utf8",
  );
  setExternalLyricRoot("");
  setLibraryAudioRoot(root);
  t.after(async () => {
    setLibraryAudioRoot("");
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const result = await resolveExternalLyricsForOnline({
    title: "Online Song",
    artists: ["Singer"],
    durationSeconds: 180,
  });

  assert.equal(result.status, "selected");
  assert.match(result.lyric, /Mirrored lyric/);
  assert.equal(result.provenance.sourceName, "Singer - Online Song.lrc");
});

test("online lyrics refuse equally strong conflicting files in the mirrored library", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-online-ambiguous-"));
  const roots = ["part1", "part2"].map((part) => path.join(root, "KTV歌词", "lx.music", part));
  await Promise.all(roots.map((item) => fs.promises.mkdir(item, { recursive: true })));
  await Promise.all(roots.map((item, index) => fs.promises.writeFile(
    path.join(item, "Singer - Same Song.lrc"),
    `[ti:Same Song]\n[ar:Singer]\n[00:01.00]Version ${index + 1}`,
    "utf8",
  )));
  setExternalLyricRoot("");
  setLibraryAudioRoot(root);
  t.after(async () => {
    setLibraryAudioRoot("");
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const result = await resolveExternalLyricsForOnline({ title: "Same Song", artists: ["Singer"] });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.lyricsModel, null);
  assert.equal(result.lyric, "");
});

test("offline lyric lookup reuses the configured external resolver without exposing a sidecar", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-local-lookup-"));
  const external = path.join(root, "ktv");
  const trackPath = path.join(root, "music", "Singer - Song.mp3");
  await fs.promises.mkdir(external, { recursive: true });
  await fs.promises.writeFile(
    path.join(external, "Singer - Song.lrc"),
    "[ti:Song]\n[ar:Singer]\n[00:01.00]Line",
    "utf8",
  );
  setExternalLyricRoot(external);
  t.after(async () => {
    setExternalLyricRoot("");
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const result = await resolveLocalLyricsForLookup(trackPath, {
    title: "Song",
    artists: ["Singer"],
    durationSeconds: 180,
  }, { sources: ["external"] });

  assert.equal(result.status, "selected");
  assert.equal(result.selected.sourceType, "external");
  assert.equal(result.selected.model.lines[0].main.text, "Line");
});

test("a track uses its mirrored KTV directory and preserves word timing for desktop lyrics", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-mirrored-lookup-"));
  const partition = path.join(root, "lx.music", "part4");
  const mirroredKtv = path.join(root, "KTV歌词", "lx.music", "part4");
  const fallbackKtv = path.join(root, "fallback-ktv");
  const trackPath = path.join(partition, "Singer - Song.mp3");
  await Promise.all([
    fs.promises.mkdir(mirroredKtv, { recursive: true }),
    fs.promises.mkdir(fallbackKtv, { recursive: true }),
    fs.promises.mkdir(partition, { recursive: true }),
  ]);
  await fs.promises.writeFile(path.join(partition, "Singer - Song.lrc"), "[00:01.00]Ordinary sidecar\n[00:03.00]Next line", "utf8");
  await fs.promises.writeFile(
    path.join(mirroredKtv, "Singer - Song (译名) (12345678).lrc"),
    "[ti:Song]\n[00:01.000]<00:01.000>逐<00:01.400>字<00:01.800>",
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(fallbackKtv, "Singer - Song.lrc"),
    "[ti:Song]\n[ar:Singer]\n[00:01.00]Fallback lyric",
    "utf8",
  );
  setExternalLyricRoot(fallbackKtv);
  setLibraryAudioRoot(root);
  t.after(async () => {
    setExternalLyricRoot("");
    setLibraryAudioRoot("");
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const result = await resolveLocalLyricsForLookup(trackPath, {
    title: "Song",
    artists: ["Singer"],
    durationSeconds: 180,
  }, { sources: ["external", "sidecar"] });

  assert.equal(result.status, "selected");
  assert.equal(result.selected.model.lines[0].main.words.length, 2);
  assert.equal(result.selected.model.lines[0].main.words[0].startMs, 1000);
  assert.equal(result.selected.model.lines[0].main.words[0].endMs, 1400);
  assert.equal(result.selected.rootPriority, 2);
  assert.equal(result.selected.identityReason, "mirrored_path_bound");
});

test("manual lyric choice refreshes mirrored cache, survives quality ranking and still rejects identity conflicts", async () => {
  const root = path.join(tempCacheRoot, "manual-choice"), folder = path.join(root, "Album");
  const mirror = path.join(root, "KTV歌词", "Album"), audio = path.join(folder, "Singer - Song.mp3");
  await fs.promises.mkdir(folder, { recursive: true });
  await fs.promises.mkdir(mirror, { recursive: true });
  await fs.promises.writeFile(audio, "synthetic audio");
  await fs.promises.writeFile(path.join(mirror, "Singer - Song (译名).lrc"), "[ti:Song]\n[ar:Singer]\n[00:01.000]<00:01.000>Old<00:01.400> word<00:01.800>");
  setLibraryAudioRoot(root);
  const evidence = { title: "Song", artists: ["Singer"], durationSeconds: 180 };
  const resolve = () => resolveLocalLyricsForLookup(audio, evidence, { sources: ["external"] });
  assert.match((await resolve()).selected.model.lines[0].main.text, /Old/);
  const canonical = path.join(mirror, "Singer - Song.lrc");
  await fs.promises.writeFile(canonical, "[re:Flowave:user-selected]\n[00:01.00]Chosen line");
  await invalidateLyricSources(audio);
  const selected = await resolve();
  assert.match(selected.selected.model.lines[0].main.text, /Chosen/);
  assert.equal(selected.selected.rootPriority, 3);
  await fs.promises.writeFile(canonical, "[re:Flowave:user-selected]\n[ti:Unrelated]\n[ar:Other]\n[00:01.00]Wrong identity");
  await invalidateLyricSources(audio);
  assert.match((await resolve()).selected.model.lines[0].main.text, /Old/);
  await fs.promises.writeFile(canonical, "[00:01.00]Restored unselected line");
  await invalidateLyricSources(audio);
  assert.match((await resolve()).selected.model.lines[0].main.text, /Old/);
  setLibraryAudioRoot("");
});

test("metadata cache key changes when tags alter ctime without changing size or mtime", () => {
  const base = {
    mtimeMs: 1000,
    ctimeMs: 2000,
    birthtimeMs: 500,
    size: 4096,
  };
  const changed = { ...base, ctimeMs: 2001 };

  assert.notEqual(__test.cacheKey("C:\\Music\\song.flac", base), __test.cacheKey("C:\\Music\\song.flac", changed));
});

test("metadata cache key changes after an atomic replacement", () => {
  const base = {
    mtimeMs: 1000,
    ctimeMs: 2000,
    birthtimeMs: 500,
    size: 4096,
  };
  const replaced = { ...base, birthtimeMs: 2500 };

  assert.notEqual(__test.cacheKey("C:\\Music\\song.flac", base), __test.cacheKey("C:\\Music\\song.flac", replaced));
});

test("track invalidation removes current and legacy path entries without touching another song", async () => {
  __test.cache.clear();
  const firstPath = path.join(tempCacheRoot, "first.mp3");
  const otherPath = path.join(tempCacheRoot, "other.mp3");
  const firstIdentity = __test.metadataIdentity(firstPath, "resource-1");
  const otherIdentity = __test.metadataIdentity(otherPath, "resource-2");
  __test.cache.set(`${firstPath}|1|2|3|4`, { title: "First", _cacheIdentity: firstIdentity });
  __test.cache.set(`${firstPath}|legacy`, { title: "Legacy" });
  __test.cache.set(`${otherPath}|1|2|3|4`, { title: "Other", _cacheIdentity: otherIdentity });

  const result = await invalidateTrackMetadata({ trackPath: firstPath, resourceId: "resource-1" });

  assert.equal(result.invalidated, 2);
  assert.equal(__test.cache.size, 1);
  assert.equal([...__test.cache.values()][0].title, "Other");
});

test("resource invalidation removes a moved track's old path cache", async () => {
  __test.cache.clear();
  const oldPath = path.join(tempCacheRoot, "old", "song.mp3");
  __test.cache.set(`${oldPath}|1|2|3|4`, {
    title: "Old",
    _cacheIdentity: __test.metadataIdentity(oldPath, "resource-moved"),
  });

  const result = await invalidateTrackMetadata({
    trackPath: path.join(tempCacheRoot, "new", "song.mp3"),
    resourceId: "resource-moved",
  });

  assert.equal(result.invalidated, 1);
  assert.equal(__test.cache.size, 0);
});

test("a new file version prunes only older entries for the same track", () => {
  __test.cache.clear();
  const trackPath = path.join(tempCacheRoot, "versioned.mp3");
  const otherPath = path.join(tempCacheRoot, "other-versioned.mp3");
  const identity = __test.metadataIdentity(trackPath, "resource-versioned");
  const currentKey = `${trackPath}|5|6|7|8`;
  __test.cache.set(`${trackPath}|1|2|3|4`, { title: "Old", _cacheIdentity: identity });
  __test.cache.set(currentKey, { title: "Current", _cacheIdentity: identity });
  __test.cache.set(`${otherPath}|1|2|3|4`, {
    title: "Other",
    _cacheIdentity: __test.metadataIdentity(otherPath, "resource-other"),
  });

  assert.equal(__test.pruneSupersededCacheEntries(identity, currentKey), 1);
  assert.equal(__test.cache.get(currentKey).title, "Current");
  assert.equal(__test.cache.size, 2);
});

test("invalidation advances only the matching identity generation", async () => {
  __test.cache.clear();
  __test.invalidationGenerations.clear();
  const first = __test.metadataIdentity(path.join(tempCacheRoot, "one.mp3"), "resource-1");
  const other = __test.metadataIdentity(path.join(tempCacheRoot, "two.mp3"), "resource-2");
  const firstGeneration = __test.captureInvalidationGeneration(first);
  const otherGeneration = __test.captureInvalidationGeneration(other);

  await invalidateTrackMetadata({ trackPath: first.path, resourceId: first.resourceId });

  assert.equal(__test.isInvalidationGenerationCurrent(firstGeneration), false);
  assert.equal(__test.isInvalidationGenerationCurrent(otherGeneration), true);
});

test("a parse started before invalidation cannot repopulate the cache", async () => {
  __test.cache.clear();
  __test.invalidationGenerations.clear();
  const trackPath = path.join(tempCacheRoot, "late.mp3");
  const identity = __test.metadataIdentity(trackPath, "resource-late");
  const generation = __test.captureInvalidationGeneration(identity);
  await invalidateTrackMetadata({ trackPath, resourceId: identity.resourceId });

  const committed = __test.commitCacheEntry(
    `${trackPath}|1|2|3|4`,
    { title: "Stale", _cacheIdentity: identity },
    generation,
  );

  assert.equal(committed, false);
  assert.equal(__test.cache.size, 0);
});

test("cache-only identity fields never cross the renderer boundary", () => {
  const output = __test.publicMetadata({
    title: "Song",
    _cacheIdentity: { path: "C:\\Private\\Song.mp3", resourceId: "resource-secret" },
  });

  assert.equal(Object.hasOwn(output, "_cacheIdentity"), false);
  assert.doesNotMatch(JSON.stringify(output), /Private|resource-secret/);
});

test("matching metadata cache envelope loads only object entries", () => {
  const good = { title: "Good" };
  const entries = __test.readCacheEntries({
    version: __test.CACHE_VERSION,
    entries: { key: good },
  });

  assert.deepEqual(entries, { key: good });
  assert.deepEqual(__test.readCacheEntries({ version: __test.CACHE_VERSION, entries: [] }), {});
});

test("v6 lyrics migrate before publishing the small index, and migration failure retains the old cache", () => {
  const { execFileSync } = require('node:child_process');
  for (const fail of [false, true]) {
    const directory = path.join(tempCacheRoot, 'migration-' + fail);
    fs.mkdirSync(path.join(directory, 'metadata'), { recursive: true });
    const file = path.join(directory, 'metadata/metadata_cache.json');
    const original = JSON.stringify({ version: 6, entries: { song: { title: 'Song', lyrics: '保存的歌词', lyricsProvenance: { sourceType: 'embedded' } } } });
    fs.writeFileSync(file, original);
    const script = `
      const fs = require('node:fs');
      if (${fail}) { const rename=fs.promises.rename; fs.promises.rename=async(from,to)=>{
        if(to===${JSON.stringify(file)}) throw Error('fixture publish failure');
        return rename(from,to);
      }; }
      const service=require(${JSON.stringify(path.resolve(__dirname, '../metadata-service'))});
      service.flushMetadataCache().then(()=>console.log(JSON.stringify([...service.__test.cache.values()])));
    `;
    const values = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, KUMIKO_CACHE_DIR: directory }, encoding: 'utf8', windowsHide: true,
    }).trim());
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.version, fail ? 6 : 7);
    assert.equal(values[0].title, 'Song');
    if (fail) assert.equal(fs.readFileSync(file, 'utf8'), original);
    else {
      assert.equal(Object.hasOwn(saved.entries.song, 'lyrics'), false);
      const body = path.join(directory, 'metadata/lyrics', saved.entries.song._lyricBlob + '.json');
      assert.equal(JSON.parse(fs.readFileSync(body, 'utf8')).lyrics, '保存的歌词');
      assert.equal(fs.readFileSync(path.join(directory, 'metadata/metadata_cache.v6.json'), 'utf8'), original);
    }
  }
});

test("lyric bodies round-trip across restart with a bounded recent cache and checksum protection", async () => {
  const { MetadataLyricsCache } = require('../metadata-lyrics-cache');
  const directory = path.join(tempCacheRoot, 'body-fixture');
  const bodies = new MetadataLyricsCache(directory, 400);
  const original = { title: 'Song', lyrics: '逐字歌词'.repeat(15), lyricsProvenance: { sourceType: 'embedded' } };
  const packed = bodies.pack(original);
  assert.equal(Object.hasOwn(packed, 'lyrics'), false);
  assert.deepEqual(await bodies.expand(packed), { ...original, _lyricBlob: packed._lyricBlob });
  await bodies.persist();
  assert.equal(bodies.pending.size, 0);
  const cold = new MetadataLyricsCache(directory, 400);
  assert.deepEqual(await cold.expand(packed), { ...original, _lyricBlob: packed._lyricBlob });
  for (let i = 0; i < 20; i++) cold.pack({ lyrics: String(i).repeat(50) });
  assert(cold.bytes <= 400);
  const corrupt = new MetadataLyricsCache(directory);
  fs.writeFileSync(path.join(directory, packed._lyricBlob + '.json'), '{}');
  await assert.rejects(corrupt.expand(packed), /校验失败/);
  await assert.rejects(corrupt.expand({ _lyricBlob: '../../private' }), /索引无效/);
  assert.equal(Object.hasOwn(__test.publicMetadata(packed), '_lyricBlob'), false);
});

test("a corrupt cold lyric body is rebuilt from the actual song sources", async () => {
  const { execFileSync } = require('node:child_process');
  const trackPath = path.join(tempCacheRoot, 'Recovered - Lyrics.mp3');
  fs.writeFileSync(trackPath, 'invalid audio fixture');
  fs.writeFileSync(trackPath.replace(/\.mp3$/, '.lrc'), '[ti:Lyrics]\n[ar:Recovered]\n[00:01.00]真实歌词');
  const info = await getMeta(trackPath);
  assert.match(info.lyrics, /真实歌词/);
  await flushMetadataCache();
  const key = __test.cacheKey(trackPath, fs.statSync(trackPath));
  const hash = __test.cache.get(key)._lyricBlob;
  fs.writeFileSync(path.join(tempCacheRoot, 'metadata/lyrics', hash + '.json'), '{}');
  const script = `const service=require(${JSON.stringify(path.resolve(__dirname, '../metadata-service'))});
    (async()=>{const info=await service.getMeta(${JSON.stringify(trackPath)});await service.flushMetadataCache();console.log(JSON.stringify(info));})();`;
  const restored = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, KUMIKO_CACHE_DIR: tempCacheRoot }, encoding: 'utf8', windowsHide: true,
  }).trim());
  assert.match(restored.lyrics, /真实歌词/);
  assert.equal(Object.hasOwn(restored, '_lyricBlob'), false);
});

test("outdated metadata cache envelope is ignored instead of becoming fake entries", () => {
  const entries = __test.readCacheEntries({
    version: __test.CACHE_VERSION - 2,
    entries: { stale: { title: "Stale" } },
  });

  assert.deepEqual(entries, {});
  assert.equal(Object.hasOwn(entries, "version"), false);
  assert.equal(Object.hasOwn(entries, "entries"), false);
});

test("legacy flat metadata cache remains readable", () => {
  const legacy = { "C:\\Music\\song.mp3|1|2": { title: "Legacy" } };
  assert.equal(__test.readCacheEntries(legacy), legacy);
});

test("lyric provenance returned to renderer omits absolute source paths", () => {
  const provenance = __test.publicLyricProvenance({
    sourceType: "external",
    sourcePath: "C:\\Private\\Lyrics\\Singer - Song.lrc",
    relativePath: "Private Album\\Singer - Song.lrc",
    identityLevel: "strong",
    identityScore: 99,
    identityReason: "artist_title_metadata",
    qualityLevel: "line",
    contentHash: "abc",
    encoding: "shift_jis",
    dependency: {
      path: "C:\\Private\\Lyrics\\Singer - Song.lrc",
      size: 100,
      mtimeMs: 200,
      hash: "abc",
    },
  });

  assert.equal(Object.hasOwn(provenance, "sourcePath"), false);
  assert.equal(Object.hasOwn(provenance.dependency, "path"), false);
  assert.equal(provenance.sourceName, "Singer - Song.lrc");
  assert.equal(Object.hasOwn(provenance, "relativePath"), false);
  assert.equal(provenance.encoding, "shift_jis");
  assert.doesNotMatch(JSON.stringify(provenance), /Private/);
});

test("persistent metadata cache omits the rebuildable structured lyric copy", () => {
  const serialized = __test.serializeCacheEntry({
    title: "Song",
    lyrics: "[00:01.00]Line",
    lyricsModel: { schemaVersion: 1, lines: [{ startMs: 1000 }] },
    lyricsStatus: "selected",
  });

  assert.equal(serialized.title, "Song");
  assert.equal(serialized.lyrics, "[00:01.00]Line");
  assert.equal(Object.hasOwn(serialized, "lyricsModel"), false);
});

test("structured lyrics are returned only for an explicit current-track request", () => {
  const info = { title: "Song", lyrics: "Line", lyricsModel: { schemaVersion: 1 } };
  assert.equal(Object.hasOwn(__test.publicMetadata(info), "lyricsModel"), false);
  assert.equal(__test.publicMetadata(info, { includeLyricsModel: true }).lyricsModel.schemaVersion, 1);
});

test("changing the configured lyric directory clears a cached external lyric", async () => {
  const root = await fs.promises.mkdtemp(path.join(tempCacheRoot, "lyric-root-switch-"));
  const musicDir = path.join(root, "music");
  const sourceA = path.join(root, "source-a");
  const sourceB = path.join(root, "source-b");
  await Promise.all([
    fs.promises.mkdir(musicDir, { recursive: true }),
    fs.promises.mkdir(sourceA, { recursive: true }),
    fs.promises.mkdir(sourceB, { recursive: true }),
  ]);
  const trackPath = path.join(musicDir, "Singer - Blue Sky.mp3");
  await fs.promises.writeFile(trackPath, "not an audio stream", "utf8");
  await fs.promises.writeFile(
    path.join(sourceA, "Singer - Blue Sky.lrc"),
    "[00:01.00]From source A",
    "utf8",
  );

  setExternalLyricRoot(sourceA);
  const first = await getMeta(trackPath, { includeLyricsModel: true });
  assert.equal(first.lyricsStatus, "selected");
  assert.equal(first.lyricsProvenance.sourceType, "external");
  assert.equal(first.lyricsModel.schemaVersion, 1);
  assert.match(first.lyrics, /From source A/);
  assert.doesNotMatch(JSON.stringify(first.lyricsProvenance), new RegExp(sourceA.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"), "i"));

  setExternalLyricRoot(sourceB);
  const second = await getMeta(trackPath, { includeLyricsModel: true });
  assert.equal(second.lyricsStatus, "missing");
  assert.equal(second.lyrics, "");
  assert.equal(second.lyricsProvenance, null);
});

test("migrated cover URLs resolve inside the current workspace", async () => {
  const {toLocalMediaUrl, localMediaUrlToPath} = require("../secure-protocols");
  const {pathToFileURL} = require("node:url");
  const track = path.join(tempCacheRoot, "migrated-cover.wav");
  await fs.promises.writeFile(track, "isolated metadata fixture");
  await getMeta(track, {includeLyrics:false});
  const row = __test.cache.get(__test.cacheKey(track, await fs.promises.stat(track)));
  const currentCover = path.join(tempCacheRoot, "metadata/covers/moved.png");
  const currentThumb = path.join(tempCacheRoot, "metadata/thumbs/moved.png");
  await fs.promises.writeFile(currentCover, "current cover");
  await fs.promises.writeFile(currentThumb, "current thumb");
  for (const legacy of ["old/data/cache/metadata", "old workspace 音乐/cache/metadata"]) {
    const previousCover = path.join(tempCacheRoot, legacy, "covers/moved.png");
    const previousThumb = path.join(tempCacheRoot, legacy, "thumbs/moved.png");
    await fs.promises.mkdir(path.dirname(previousCover), {recursive:true});
    await fs.promises.mkdir(path.dirname(previousThumb), {recursive:true});
    await fs.promises.writeFile(previousCover, "old cover");
    await fs.promises.writeFile(previousThumb, "old thumb");
    for (const encode of [toLocalMediaUrl, value => pathToFileURL(value).href]) {
      row.cover = encode(previousCover);
      row.cover_thumb = encode(previousThumb);
      const result = await getMeta(track, {includeLyrics:false});
      assert.equal(localMediaUrlToPath(result.cover), currentCover);
      assert.equal(localMediaUrlToPath(result.cover_thumb), currentThumb);
    }
    await fs.promises.unlink(previousCover);
    await fs.promises.unlink(previousThumb);
    row.cover = toLocalMediaUrl(previousCover);
    row.cover_thumb = toLocalMediaUrl(previousThumb);
    const result = await getMeta(track, {includeLyrics:false});
    assert.equal(localMediaUrlToPath(result.cover), currentCover);
    assert.equal(localMediaUrlToPath(result.cover_thumb), currentThumb);
  }
});
