const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ENCRYPTED_QRC_MAGIC,
  LocalLyricSourceResolver,
  decodeLyricBufferDetailed,
  classifyIdentity,
} = require("../lyrics/local-source-resolver");

test("local identity accepts title annotations and artist readings while preserving conflicts", () => {
  const evidence = { title: "Song", artists: ["Singer"], album: "", versionTerms: [], fileBase: "Singer - Song" };
  const decide = (title, artist) => classifyIdentity({ sourceType: "external", fileName: "Singer - Song.lrc", evidence, metadata: { title, artists: [artist], album: "" } });
  assert.equal(decide("Song (作品说明)", "Singer (读音)").identityLevel, "strong");
  assert.equal(decide("別名 (Song)", "Singer").identityLevel, "strong");
  assert.equal(decide("Other (作品说明)", "Singer").identityLevel, "reject");
  assert.equal(decide("Song (Live)", "Singer").identityReason, "version_conflict");
  assert.equal(decide("Song", "Different Artist").identityLevel, "reject");
});

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-local-lyrics-"));
  const music = path.join(root, "music");
  const external = path.join(root, "ktv");
  await fs.promises.mkdir(music, { recursive: true });
  await fs.promises.mkdir(external, { recursive: true });
  const trackPath = path.join(music, "Singer - Blue Sky.mp3");
  await fs.promises.writeFile(trackPath, "audio", "utf8");
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return { root, music, external, trackPath };
}

const evidence = {
  title: "Blue Sky",
  artists: ["Singer"],
  album: "Album",
  durationSeconds: 180,
};

test("exact sidecar identity beats a finer but conflicting external lyric", async (t) => {
  const { external, trackPath } = await fixture(t);
  await fs.promises.writeFile(trackPath.replace(/\.mp3$/i, ".lrc"), "[00:01.00]Correct line", "utf8");
  await fs.promises.writeFile(
    path.join(external, "Another Singer - Blue Sky.lrc"),
    "[ti:Blue Sky]\n[ar:Another Singer]\n[00:01.000]A[00:01.500]B[00:02.000]",
    "utf8",
  );
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({ trackPath, evidence });

  assert.equal(result.status, "selected");
  assert.equal(result.selected.sourceType, "sidecar");
  assert.match(result.selected.legacyText, /Correct line/);
});

test("filename direction is scored both ways instead of assuming artist first", async (t) => {
  const { external, trackPath } = await fixture(t);
  await fs.promises.writeFile(path.join(external, "Blue Sky - Singer.lrc"), "[00:01.00]Line", "utf8");
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.equal(result.status, "selected");
  assert.equal(result.selected.identityLevel, "medium");
  assert.equal(result.selected.identityReason, "title-artist");
});

test("online track evidence can match the configured KTV library without a local audio path", async (t) => {
  const { external } = await fixture(t);
  await fs.promises.writeFile(
    path.join(external, "Singer - Blue Sky.lrc"),
    "[ti:Blue Sky]\n[ar:Singer]\n[al:Album]\n[00:01.00]Online KTV line",
    "utf8",
  );
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolveExternal({ evidence });

  assert.equal(result.status, "selected");
  assert.equal(result.selected.sourceType, "external");
  assert.equal(result.selected.identityLevel, "strong");
  assert.match(result.selected.legacyText, /Online KTV line/);
});

test("online KTV matching refuses indistinguishable lyrics with different content", async (t) => {
  const { external } = await fixture(t);
  await fs.promises.mkdir(path.join(external, "first"));
  await fs.promises.mkdir(path.join(external, "second"));
  await fs.promises.writeFile(
    path.join(external, "first", "Singer - Blue Sky.lrc"),
    "[ti:Blue Sky]\n[ar:Singer]\n[00:01.00]First online lyric",
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(external, "second", "Singer - Blue Sky.lrc"),
    "[ti:Blue Sky]\n[ar:Singer]\n[00:01.00]Second online lyric",
    "utf8",
  );
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolveExternal({ evidence });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.selected, null);
  assert.equal(result.alternatives.length, 2);
});

test("different indistinguishable external lyrics return ambiguity instead of scan-order selection", async (t) => {
  const { external, trackPath } = await fixture(t);
  await fs.promises.mkdir(path.join(external, "a"));
  await fs.promises.mkdir(path.join(external, "b"));
  await fs.promises.writeFile(path.join(external, "a", "Singer - Blue Sky.lrc"), "[00:01.00]First", "utf8");
  await fs.promises.writeFile(path.join(external, "b", "Singer - Blue Sky.lrc"), "[00:01.00]Second", "utf8");
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.selected, null);
  assert.equal(result.alternatives.length, 2);
});

test("identical duplicate external lyrics use a stable path without false ambiguity", async (t) => {
  const { external, trackPath } = await fixture(t);
  await fs.promises.mkdir(path.join(external, "b"));
  await fs.promises.mkdir(path.join(external, "a"));
  const lyrics = "[ti:Blue Sky]\n[ar:Singer]\n[00:01.00]Same";
  await fs.promises.writeFile(path.join(external, "b", "Singer - Blue Sky.lrc"), lyrics, "utf8");
  await fs.promises.writeFile(path.join(external, "a", "Singer - Blue Sky.lrc"), lyrics, "utf8");
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.equal(result.status, "selected");
  assert.match(result.selected.relativePath.replace(/\\/g, "/"), /^a\//);
});

test("damaged or oversized external files do not hide a valid candidate", async (t) => {
  const { external, trackPath } = await fixture(t);
  await fs.promises.writeFile(path.join(external, "Singer - Blue Sky.lrc"), Buffer.from([0xff, 0xfe, 0x00, 0x00]));
  await fs.promises.writeFile(
    path.join(external, "Blue Sky - Singer.lrc"),
    "[ti:Blue Sky]\n[ar:Singer]\n[00:01.00]Valid",
    "utf8",
  );
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.equal(result.status, "selected");
  assert.match(result.selected.legacyText, /Valid/);
});

test("UTF-16 BOM lyrics are decoded without replacement characters", async (t) => {
  const { external, trackPath } = await fixture(t);
  const content = "[ti:Blue Sky]\n[ar:Singer]\n[00:01.00]你好";
  await fs.promises.writeFile(
    path.join(external, "Singer - Blue Sky.lrc"),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]),
  );
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.equal(result.status, "selected");
  assert.match(result.selected.legacyText, /你好/);
  assert.doesNotMatch(result.selected.legacyText, /�/);
});

test("no-BOM GB18030 lyrics decode only when the legacy signal is clear", async (t) => {
  const { external, trackPath } = await fixture(t);
  const prefix = Buffer.from("[ti:Blue Sky]\n[ar:Singer]\n[00:01.00]", "ascii");
  const chinese = Buffer.from("c4e3bac3", "hex");
  await fs.promises.writeFile(
    path.join(external, "Singer - Blue Sky.lrc"),
    Buffer.concat([prefix, chinese]),
  );
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.equal(result.status, "selected");
  assert.match(result.selected.legacyText, /你好/);
  assert.equal(result.selected.encoding, "gb18030");
});

test("no-BOM Shift-JIS lyrics use kana evidence without mojibake", async (t) => {
  const { external, trackPath } = await fixture(t);
  const prefix = Buffer.from("[ti:Blue Sky]\n[ar:Singer]\n[00:01.00]", "ascii");
  const japanese = Buffer.from("82b182f182c982bf82cd", "hex");
  await fs.promises.writeFile(
    path.join(external, "Singer - Blue Sky.lrc"),
    Buffer.concat([prefix, japanese]),
  );
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.equal(result.status, "selected");
  assert.match(result.selected.legacyText, /こんにちは/);
  assert.equal(result.selected.encoding, "shift_jis");
});

test("ambiguous no-BOM legacy bytes return an encoding error instead of mojibake", () => {
  assert.throws(
    () => decodeLyricBufferDetailed(Buffer.from("8140", "hex")),
    (error) => error?.code === "LYRIC_ENCODING_AMBIGUOUS",
  );
});

test("plaintext QRC is a local candidate while encrypted QRC is isolated", async (t) => {
  const { external, trackPath } = await fixture(t);
  await fs.promises.writeFile(
    path.join(external, "Singer - Blue Sky.qrc"),
    Buffer.concat([ENCRYPTED_QRC_MAGIC, Buffer.from([0, 1, 2, 3])]),
  );
  await fs.promises.writeFile(
    path.join(external, "Blue Sky - Singer.qrc"),
    "<QrcInfos><LyricInfo><Lyric_1 LyricType=\"1\" LyricContent=\"[ti:Blue Sky]&#10;[ar:Singer]&#10;[1000,800]Q(1000,400)R(1400,400)\"/></LyricInfo></QrcInfos>",
    "utf8",
  );
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.equal(result.status, "selected");
  assert.equal(result.selected.qualityLevel, "word_with_end");
  assert.equal(result.selected.model.lines[0].main.text, "QR");
});

test("embedded lyrics remain strong and preserve their declared channel role", async (t) => {
  const { trackPath } = await fixture(t);
  const resolver = new LocalLyricSourceResolver();
  const result = await resolver.resolve({
    trackPath,
    evidence,
    sources: ["embedded"],
    embedded: [{ id: "sylt:ja", role: "main", language: "ja", text: "[00:01.00]内嵌歌词" }],
  });

  assert.equal(result.status, "selected");
  assert.equal(result.selected.sourceType, "embedded");
  assert.equal(result.selected.model.channels.main.language, "ja");
});

test("KTV source priority breaks an identity tie before lyric quality", async (t) => {
  const { external, trackPath } = await fixture(t);
  await fs.promises.writeFile(
    path.join(external, "Singer - Blue Sky.lrc"),
    "[ti:Blue Sky]\n[ar:Singer]\n[al:Album]\nPlain text only",
    "utf8",
  );
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({
    trackPath,
    evidence,
    embedded: [{ id: "sylt", text: "[00:01.00]Timed embedded lyric" }],
  });

  assert.equal(result.status, "selected");
  assert.equal(result.selected.sourceType, "external");
  assert.equal(result.selected.qualityLevel, "plain");
});

test("granular main timing safely separates a line-timed translation", async (t) => {
  const { external, trackPath } = await fixture(t);
  await fs.promises.writeFile(
    path.join(external, "Singer - Blue Sky.lrc"),
    [
      "[ti:Blue Sky]",
      "[ar:Singer]",
      "[00:01.000]A[00:01.300]B[00:01.600]",
      "[00:01.000]翻译[00:01.800]",
    ].join("\n"),
    "utf8",
  );
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.equal(result.status, "selected");
  assert.equal(result.selected.model.lines.length, 1);
  assert.equal(result.selected.model.lines[0].main.text, "AB");
  assert.equal(result.selected.model.lines[0].translation.text, "翻译");
  assert.equal(result.selected.model.lines[0].main.words.at(-1).endMs, 1600);
});

test("version conflicts are rejected even when title and artist match", async (t) => {
  const { external, trackPath } = await fixture(t);
  await fs.promises.writeFile(
    path.join(external, "Singer - Blue Sky.lrc"),
    "[ti:Blue Sky (Live)]\n[ar:Singer]\n[00:01.00]Wrong version",
    "utf8",
  );
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const result = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.equal(result.status, "missing");
});

test("external file changes invalidate the parsed content cache", async (t) => {
  const { external, trackPath } = await fixture(t);
  const sourcePath = path.join(external, "Singer - Blue Sky.lrc");
  await fs.promises.writeFile(sourcePath, "[00:01.00]Before", "utf8");
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const first = await resolver.resolve({ trackPath, evidence, sources: ["external"] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.promises.writeFile(sourcePath, "[00:01.00]After changed", "utf8");
  const second = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.match(first.selected.legacyText, /Before/);
  assert.match(second.selected.legacyText, /After changed/);
  assert.notEqual(first.selected.contentHash, second.selected.contentHash);
});

test("external index refresh finds additions and drops deleted files", async (t) => {
  const { external, trackPath } = await fixture(t);
  let now = 1000;
  const resolver = new LocalLyricSourceResolver({
    externalRoot: external,
    indexTtlMs: 20,
    now: () => now,
  });
  const first = await resolver.resolve({ trackPath, evidence, sources: ["external"] });
  assert.equal(first.status, "missing");

  const sourcePath = path.join(external, "Singer - Blue Sky.lrc");
  await fs.promises.writeFile(sourcePath, "[00:01.00]Added", "utf8");
  const beforeRefresh = await resolver.resolve({ trackPath, evidence, sources: ["external"] });
  assert.equal(beforeRefresh.status, "missing");

  now += 21;
  const afterRefresh = await resolver.resolve({ trackPath, evidence, sources: ["external"] });
  assert.equal(afterRefresh.status, "selected");
  assert.match(afterRefresh.selected.legacyText, /Added/);

  await fs.promises.unlink(sourcePath);
  now += 21;
  const afterDelete = await resolver.resolve({ trackPath, evidence, sources: ["external"] });
  assert.equal(afterDelete.status, "missing");
});

test("same-size replacement with restored mtime does not reuse stale text", async (t) => {
  const { external, trackPath } = await fixture(t);
  const sourcePath = path.join(external, "Singer - Blue Sky.lrc");
  await fs.promises.writeFile(sourcePath, "[00:01.00]First!", "utf8");
  const original = await fs.promises.stat(sourcePath);
  const resolver = new LocalLyricSourceResolver({ externalRoot: external });
  const first = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.promises.writeFile(sourcePath, "[00:01.00]Later!", "utf8");
  await fs.promises.utimes(sourcePath, original.atime, original.mtime);
  const second = await resolver.resolve({ trackPath, evidence, sources: ["external"] });

  assert.match(first.selected.legacyText, /First!/);
  assert.match(second.selected.legacyText, /Later!/);
  assert.notEqual(first.selected.contentHash, second.selected.contentHash);
});
