"use strict";

const {
  buildUnifiedLyric,
  parseLyricChannel,
} = require("./unified-lyric");

const NETEASE_CHANNEL_PRIORITY = Object.freeze({
  main: Object.freeze(["yrc", "lrc"]),
  translation: Object.freeze(["ytlrc", "tlyric"]),
  romanization: Object.freeze(["yromalrc", "romalrc"]),
});

function lyricText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return typeof value.lyric === "string" ? value.lyric.trim() : "";
}

function channelFormat(field) {
  return field === "yrc" ? "yrc" : "lrc";
}

function selectParsedChannel(payload, role, fields) {
  const diagnostics = [];
  for (const field of fields) {
    const text = lyricText(payload?.[field]);
    if (!text) continue;
    try {
      const channel = parseLyricChannel(text, {
        role,
        format: channelFormat(field),
        sourceId: `online:netease:${field}`,
        wordTimeMode: field === "yrc" ? "auto" : undefined,
      });
      if (Array.isArray(channel.lines) && channel.lines.length) {
        return { field, channel, diagnostics };
      }
      diagnostics.push({ field, code: "empty_after_parse" });
    } catch (error) {
      diagnostics.push({
        field,
        code: String(error?.code || "parse_failed"),
      });
    }
  }
  return { field: "", channel: null, diagnostics };
}

function adaptNeteaseLyricPayload(payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const selected = {
    main: selectParsedChannel(source, "main", NETEASE_CHANNEL_PRIORITY.main),
    translation: selectParsedChannel(source, "translation", NETEASE_CHANNEL_PRIORITY.translation),
    romanization: selectParsedChannel(source, "romanization", NETEASE_CHANNEL_PRIORITY.romanization),
  };
  const channelFields = Object.fromEntries(
    Object.entries(selected).map(([role, entry]) => [role, entry.field || null])
  );
  const channelDiagnostics = Object.fromEntries(
    Object.entries(selected)
      .filter(([, entry]) => entry.diagnostics.length)
      .map(([role, entry]) => [role, entry.diagnostics])
  );
  if (!Object.values(selected).some((entry) => entry.channel)) {
    return {
      lyricsModel: null,
      provenance: {
        provider: "netease",
        channelFields,
        channelDiagnostics,
      },
    };
  }

  const channels = {};
  for (const role of ["main", "translation", "romanization"]) {
    if (selected[role].channel) channels[role] = selected[role].channel;
  }
  const lyricsModel = buildUnifiedLyric(channels, {
    identityReason: "online_song_id",
    toleranceMs: 80,
  });
  lyricsModel.provenance = {
    ...(lyricsModel.provenance || {}),
    provider: "netease",
    channelFields,
    channelDiagnostics,
  };
  return {
    lyricsModel,
    provenance: {
      provider: "netease",
      channelFields,
      channelDiagnostics,
    },
  };
}

module.exports = {
  NETEASE_CHANNEL_PRIORITY,
  adaptNeteaseLyricPayload,
  lyricText,
  selectParsedChannel,
};
