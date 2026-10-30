(function initSearchUtils(global) {
  const root = typeof globalThis !== "undefined" ? globalThis : global;
  const CJK_VARIANT_MAP = {
    岡: "冈",
    眞: "真",
    櫻: "樱",
    濱: "滨",
    澤: "泽",
    邊: "边",
    邉: "边",
    齋: "斋",
    齊: "齐",
    髙: "高",
    﨑: "崎",
    崎: "崎",
    龍: "龙",
    亞: "亚",
    來: "来",
  };

  const SEARCH_ALIASES = {
    "岡崎律子": ["冈崎律子", "okazaki ritsuko", "ritsuko okazaki"],
    "冈崎律子": ["岡崎律子", "okazaki ritsuko", "ritsuko okazaki"],
  };

  function uniq(list) {
    const out = [];
    const seen = new Set();
    (list || []).forEach((value) => {
      const text = String(value || "").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      out.push(text);
    });
    return out;
  }

  function normalizeBasic(text) {
    return String(text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/[’‘`´]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[‐‑‒–—―]/g, "-")
      .replace(/[·・･]/g, " ")
      .replace(/[_/\\|,，、。.:：;；!！?？()[\]{}【】《》〈〉「」『』~～^+*=#@$%&]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function compact(text) {
    return normalizeBasic(text).replace(/\s+/g, "");
  }

  function mapCjkVariants(text) {
    return String(text || "").replace(/[岡眞櫻濱澤邊邉齋齊髙﨑崎龍亞來]/g, (ch) => CJK_VARIANT_MAP[ch] || ch);
  }

  function openCcVariants(text) {
    const raw = String(text || "");
    const out = [raw, mapCjkVariants(raw)];
    try {
      const OpenCC = global.OpenCC || global.OpenCCJS || global.opencc || root.OpenCC || root.OpenCCJS || root.opencc;
      if (OpenCC && typeof OpenCC.Converter === "function") {
        const toHans = OpenCC.Converter({ from: "tw", to: "cn" });
        const toHant = OpenCC.Converter({ from: "cn", to: "tw" });
        if (typeof toHans === "function") out.push(toHans(raw));
        if (typeof toHant === "function") out.push(toHant(raw));
      }
    } catch {
      // optional dependency; fallback variants above still work
    }
    return uniq(out);
  }

  function kanaRomajiVariants(text) {
    const raw = String(text || "");
    const wk = global.wanakana || root.wanakana;
    if (!wk) return [];
    const out = [];
    try {
      if (typeof wk.toRomaji === "function") out.push(wk.toRomaji(raw));
      if (typeof wk.toHiragana === "function") out.push(wk.toHiragana(raw));
      if (typeof wk.toKatakana === "function") out.push(wk.toKatakana(raw));
    } catch {
      // optional dependency
    }
    return uniq(out);
  }

  function pinyinVariants(text) {
    const raw = String(text || "");
    const pp = global.pinyinPro || global.pinyinpro || global.PinyinPro || root.pinyinPro || root.pinyinpro || root.PinyinPro;
    if (!pp) return [];
    const pinyin = typeof pp.pinyin === "function" ? pp.pinyin : null;
    if (!pinyin) return [];
    const out = [];
    try {
      out.push(pinyin(raw, { toneType: "none", type: "array" }).join(" "));
      out.push(pinyin(raw, { toneType: "none", type: "array" }).join(""));
      out.push(pinyin(raw, { pattern: "first", toneType: "none", type: "array" }).join(""));
    } catch {
      // optional dependency
    }
    return uniq(out);
  }

  function aliasesFor(text) {
    const raw = String(text || "").trim();
    const mapped = mapCjkVariants(raw);
    return uniq([...(SEARCH_ALIASES[raw] || []), ...(SEARCH_ALIASES[mapped] || [])]);
  }

  function variantsFor(text) {
    const source = String(text || "").trim();
    const candidates = [];
    openCcVariants(source).forEach((v) => candidates.push(v));
    aliasesFor(source).forEach((v) => candidates.push(v));
    kanaRomajiVariants(source).forEach((v) => candidates.push(v));
    pinyinVariants(source).forEach((v) => candidates.push(v));
    const normalized = [];
    candidates.forEach((v) => {
      normalized.push(normalizeBasic(v));
      normalized.push(compact(v));
    });
    return uniq(normalized);
  }

  function buildField(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    if (fieldCache.has(raw)) return fieldCache.get(raw);
    const result = uniq([normalizeBasic(raw), compact(raw), ...variantsFor(raw)]).join(" ");
    if (fieldCache.size >= 4096) fieldCache.delete(fieldCache.keys().next().value);
    fieldCache.set(raw, result);
    return result;
  }

  const fieldCache = new Map();
  const tokenCache = new WeakMap();
  const titleCollator = new Intl.Collator("zh-Hans-CN");

  function fieldTokens(doc, field) {
    let fields = tokenCache.get(doc);
    if (!fields) {
      fields = new Map();
      tokenCache.set(doc, fields);
    }
    const text = String(doc[field] || "");
    let entry = fields.get(field);
    if (!entry || entry.text !== text) {
      entry = { text, tokens: new Set(text.split(/\s+/)) };
      fields.set(field, entry);
    }
    return entry.tokens;
  }

  function buildTrackDoc(track, helpers) {
    const t = track || {};
    const extractName = helpers && typeof helpers.extractName === "function" ? helpers.extractName : ((p) => String(p || ""));
    const title = t.title || t.name || extractName(t.path);
    const artist = t.artist || "";
    const album = t.album || "";
    const filename = extractName(t.path);
    const titleSearch = buildField(title);
    const artistSearch = buildField(artist);
    const albumSearch = buildField(album);
    const fileSearch = buildField(filename);
    const allSearch = uniq([titleSearch, artistSearch, albumSearch, fileSearch]).join(" ");
    return {
      path: t.path || t.token || "",
      title,
      artist,
      album,
      filename,
      titleSearch,
      artistSearch,
      albumSearch,
      fileSearch,
      allSearch,
    };
  }

  function prepareQuery(query) {
    const raw = String(query || "").trim();
    const expanded = uniq([normalizeBasic(raw), compact(raw), ...variantsFor(raw)]);
    return { raw, normalized: normalizeBasic(raw), compact: compact(raw), expanded };
  }

  function fieldScore(field, query, weight, tokens) {
    const text = String(field || "");
    if (!text || !query.expanded.length) return 0;
    let best = 0;
    query.expanded.forEach((q) => {
      if (!q) return;
      if (text === q) best = Math.max(best, 1000 * weight);
      else if (tokens.has(q)) best = Math.max(best, 820 * weight);
      else if (text.startsWith(q)) best = Math.max(best, 760 * weight);
      else if (text.includes(q)) best = Math.max(best, 520 * weight);
    });
    return best;
  }

  function businessScore(doc, query) {
    return Math.max(
      fieldScore(doc.titleSearch, query, 1.0, fieldTokens(doc, "titleSearch")),
      fieldScore(doc.artistSearch, query, 0.82, fieldTokens(doc, "artistSearch")),
      fieldScore(doc.albumSearch, query, 0.42, fieldTokens(doc, "albumSearch")),
      fieldScore(doc.fileSearch, query, 0.28, fieldTokens(doc, "fileSearch")),
      fieldScore(doc.allSearch, query, 0.18, fieldTokens(doc, "allSearch"))
    );
  }

  function createFuse(docs) {
    const Fuse = global.Fuse || root.Fuse;
    if (!Fuse || typeof Fuse !== "function") return null;
    return new Fuse(docs || [], {
      includeScore: true,
      ignoreLocation: true,
      threshold: 0.38,
      minMatchCharLength: 1,
      keys: [
        { name: "titleSearch", weight: 0.46 },
        { name: "artistSearch", weight: 0.34 },
        { name: "albumSearch", weight: 0.12 },
        { name: "fileSearch", weight: 0.08 },
      ],
    });
  }

  function search(docs, fuse, keyword, options) {
    const query = prepareQuery(keyword);
    if (!query.raw) return (docs || []).map((doc) => ({ doc, score: 0 }));
    const fuzzy = options ? options.fuzzy !== false : true;
    const byPath = new Map((docs || []).map((doc) => [doc.path, doc]));
    const scored = new Map();

    (docs || []).forEach((doc) => {
      const score = businessScore(doc, query);
      if (score > 0) scored.set(doc.path, { doc, score, fuseScore: 0 });
    });

    if (fuzzy && fuse) {
      fuse.search(query.expanded.join(" ")).forEach((item) => {
        const doc = item.item;
        const existing = scored.get(doc.path);
        const fuseScore = Math.max(0, 260 * (1 - Math.min(1, Number(item.score || 0))));
        if (existing) {
          existing.score += fuseScore;
          existing.fuseScore = fuseScore;
        } else if (byPath.has(doc.path)) {
          scored.set(doc.path, { doc, score: fuseScore, fuseScore });
        }
      });
    }

    return Array.from(scored.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return titleCollator.compare(String(a.doc.title || ""), String(b.doc.title || ""));
    });
  }

  global.KumikoSearch = {
    normalizeBasic,
    compact,
    buildTrackDoc,
    prepareQuery,
    createFuse,
    search,
  };
})(window);
