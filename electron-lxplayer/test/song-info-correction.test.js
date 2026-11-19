const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SongInfoService } = require("../song-info/song-info-service");
const { SongInfoProviderRegistry } = require("../song-info/provider-registry");
const { LyricLookupService } = require("../lyrics/lookup-service");
const { LyricSaveService } = require("../song-info/lyric-save-service");
const { LyricSidecarStore } = require("../song-info/lyric-sidecar-store");
const { lyricFileLocation } = require("../song-info/lyric-file-location");
const { normalizeLyricCandidate, rankLyricCandidates } = require("../lyrics/candidate-model");
const { createLocalLibraryLyricProvider } = require("../lyrics/local-library-provider");
const { createLddcStrategyLyricProvider } = require("../lyrics/lddc-strategy-provider");

const current = { title: "Find A Way", artists: ["加藤達也"], album: "", duration: 135 };
const corrected = { title: "A Brand New Day", artists: ["加藤達也"], album: "", durationSeconds: 135 };
const lyric = normalizeLyricCandidate({ sourceRecordId: "1", trackName: corrected.title, artists: corrected.artists,
  durationSeconds: 135, syncedLyrics: "[00:01.00]First line\n[00:04.00]Next line" }, { id: "remote", version: "1" });

test("corrected title enables manual lyric save, keeps real current info, and preserves duration rejection", async () => {
  let candidates = [lyric], context;
  const service = new LyricLookupService({ getMeta: async () => current, stat: async () => ({ isFile: () => true }),
    registry: { queryAll: async request => { context = request.localContext; return { candidates, sources: [] }; } } });
  const payload = { trackPath: "C:/fixture/song.mp3", searchTitle: corrected.title, searchArtist: "加藤達也", onlyMissing: false };
  assert.equal((await service.query(payload)).candidates[0].recommendation, "none");
  const result = await service.query({ ...payload, manualIdentity: true });
  assert.equal(result.current.title, "Find A Way");
  assert.equal(result.candidates[0].recommendation, "medium");
  assert.equal(result.candidates[0].autoEligible, false);
  assert.equal(result.candidates[0].identityCorrection.title, corrected.title);
  assert.equal(context.originalEvidence.title, current.title);
  candidates = [{ ...lyric, durationSeconds: 170 }];
  assert.equal((await service.query({ ...payload, manualIdentity: true })).candidates[0].recommendation, "none");
});

test("metadata correction uses new title and allows clearing a wrong artist without changing stored current evidence", async () => {
  let searched;
  const service = new SongInfoService({ getMeta: async () => current, stat: async () => ({ isFile: () => true }),
    registry: { queryAll: async ({ evidence }) => { searched = evidence; return { candidates: [{ ...corrected, provider: "fixture" }], sources: [] }; } } });
  const result = await service.query({ trackPath: "C:/fixture/song.mp3", searchTitle: corrected.title, searchArtist: "", manualIdentity: true,
    requestedFields: ["title", "artists"] });
  assert.deepEqual(searched.artists, []);
  assert.equal(result.current.title, current.title);
  assert.equal(result.candidates[0].recommendation, "medium");
  assert.equal(result.candidates[0].differences.find(diff => diff.field === "title").current, current.title);
});

test("missing singer is not counted as a mismatch; ambiguous or wrong-duration lyrics remain blocked", () => {
  const evidence = { title: corrected.title, artists: [], durationSeconds: 135 };
  assert.equal(rankLyricCandidates(evidence, [lyric])[0].recommendation, "medium");
  const differentTimeline = normalizeLyricCandidate({
    sourceRecordId: "2", trackName: corrected.title, artists: corrected.artists, durationSeconds: 135,
    syncedLyrics: "[00:02.00]First line\n[00:05.00]Next line",
  }, { id: "remote", version: "1" });
  assert.ok(rankLyricCandidates(evidence, [lyric, differentTimeline]).every(item => item.recommendation === "none"));
  assert.equal(rankLyricCandidates(evidence, [{ ...lyric, durationSeconds: 200 }])[0].recommendation, "none");
});

test("edited search must not relabel an embedded lyric", async () => {
  let resolved;
  const provider = createLocalLibraryLyricProvider({ resolve: async request => {
    resolved = request.evidence;
    return { status: "selected", selected: { candidateId: "embedded", identityLevel: "strong", identityScore: 100,
      sourceType: "embedded", model: { schemaVersion: 1, lines: [] } } };
  } });
  const results = await provider.query({ evidence: corrected, localContext: { trackPath: "C:/fixture/song.mp3", originalEvidence: current } });
  assert.equal(resolved.title, corrected.title);
  assert.equal(results[0].trackName, current.title);
});

test("explicit retry bypasses an old empty catalog cache", async () => {
  let calls = 0;
  const registry = new SongInfoProviderRegistry();
  registry.register({ id: "fixture", version: "1", query: async () => { calls++; return calls === 1 ? [] : [corrected]; } });
  const request = { evidence: corrected, requestedFields: ["title"] };
  await registry.queryAll(request);
  assert.equal((await registry.queryAll(request)).candidates.length, 0);
  assert.equal(calls, 1);
  assert.equal((await registry.queryAll({ ...request, forceRefresh: true })).candidates.length, 1);
});

test("lyric fetch failures are reported rather than returned as no results", async () => {
  const provider = createLddcStrategyLyricProvider({ searchMusic: async source => ({ list: [{ title: corrected.title,
    artist: "加藤達也", duration: 135, source, songId: "1" }] }), getLyric: async () => { throw new Error("offline"); } });
  await assert.rejects(provider.query({ evidence: corrected }), /offline/);
});

test("corrected save, replace, conflict, undo and independent lyric file discovery use temporary files", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flowave-correction-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const audio = path.join(root, "album", "wrong-name.mp3");
  await fs.mkdir(path.dirname(audio)); await fs.writeFile(audio, "audio-original");
  const store = new LyricSidecarStore({ snapshotRoot: path.join(root, "transactions"), resolveAudioRoot: () => root });
  const service = new LyricSaveService({ store });
  const query = new LyricLookupService({ getMeta: async () => current, registry: { queryAll: async () => ({ candidates: [lyric], sources: [] }) } });
  const result = await query.query({ trackPath: audio, searchTitle: corrected.title, searchArtist: "加藤達也", manualIdentity: true, onlyMissing: false });
  const staged = service.stageQueryResult({ requestId: "manual", trackPath: audio, result, isSaveApproved: () => true });
  const token = staged.candidates[0].lyricSaveToken; assert.ok(token);
  const prepare = () => service.prepare({ candidateToken: token });
  let ready = await prepare(); assert.equal(ready.identityCorrection.title, corrected.title);
  assert.equal(ready.destination, path.join("KTV歌词", "album", "wrong-name.lrc"));
  assert.equal((await service.commit({ confirmationId: ready.confirmationId })).status, "committed");
  assert.equal((await lyricFileLocation(store, audio)).filePath, store.lyricPath(audio));
  ready = await prepare(); assert.equal(ready.targetExists, true);
  await fs.writeFile(store.lyricPath(audio), "external edit");
  await assert.rejects(service.commit({ confirmationId: ready.confirmationId, replaceExisting: true }), error => error.code === "EXTERNAL_CHANGE");
  ready = await prepare();
  const replaced = await service.commit({ confirmationId: ready.confirmationId, replaceExisting: true });
  assert.equal(replaced.status, "committed");
  assert.equal((await service.undo(replaced.transactionId)).status, "undone");
  assert.equal(await fs.readFile(store.lyricPath(audio), "utf8"), "external edit");
  await fs.unlink(store.lyricPath(audio));
  const sibling = audio.replace(/\.mp3$/, ".lrc"); await fs.writeFile(sibling, "legacy lyric");
  assert.equal((await lyricFileLocation(store, audio)).filePath, sibling);
  await fs.unlink(sibling); assert.equal((await lyricFileLocation(store, audio)).filePath, "");
  assert.equal(await fs.readFile(audio, "utf8"), "audio-original");
});


test("real local parser/registry/lookup/save supports wrong audio title with correct embedded title or no embedded title", async t => {
  const { LocalLyricSourceResolver } = require("../lyrics/local-source-resolver");
  const { LyricProviderRegistry } = require("../lyrics/provider-registry");
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "flowave-embedded-correction-"));
  t.after(() => fs.rm(folder, { recursive:true, force:true, maxRetries:3, retryDelay:30 }));
  const audio = path.join(folder, "Example Artist - New Song.mp3"); await fs.writeFile(audio, "test audio");
  const resolver = new LocalLyricSourceResolver();
  let text = "[ti:New Song]\n[ar:Example Artist]\n[00:01.00]First line\n[00:03.00]Next line";
  const registry = new LyricProviderRegistry();
  registry.register(createLocalLibraryLyricProvider({ resolve: request => resolver.resolve({ ...request, embedded:[{text}] }) }), {allowLocalContext:true});
  const query = new LyricLookupService({ registry, getMeta:async()=>({title:"Wrong Tag",artists:["Example Artist"],duration:135}) });
  const store = new LyricSidecarStore({snapshotRoot:path.join(folder,"backups"),resolveAudioRoot:()=>folder});
  const save = new LyricSaveService({store});
  const request = {trackPath:audio,onlyMissing:false,manualIdentity:true,searchTitle:"New Song",searchArtist:"Example Artist",lyricSources:["embedded"]};
  for (const withTitle of [true,false]) {
    if (!withTitle) text = "[00:01.00]First line\n[00:03.00]Next line";
    const result = await query.query(request);
    assert.equal(result.current.title,"Wrong Tag");
    assert.equal(result.candidates[0].recommendation,"medium");
    if (withTitle) assert.equal(result.candidates[0].candidate.title,"New Song");
    const staged = save.stageQueryResult({requestId:String(withTitle),trackPath:audio,result,isSaveApproved:id=>registry.canSave(id)});
    assert.ok(staged.candidates[0].lyricSaveToken);
    const ready = await save.prepare({candidateToken:staged.candidates[0].lyricSaveToken});
    const committed = await save.commit({confirmationId:ready.confirmationId,replaceExisting:true});
    assert.ok(["committed","unchanged"].includes(committed.status));
  }
  text="[ti:Unrelated Song]\n[ar:Someone Else]\n[00:01.00]Wrong lyrics";
  assert.equal((await query.query(request)).candidates[0].recommendation,"none");
});
