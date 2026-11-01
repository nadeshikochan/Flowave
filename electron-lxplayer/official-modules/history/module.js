// Official listening statistics. Original media clock and persistence stay in the host.
(function(root){'use strict';
const LISTENING_HISTORY_DAYS = 30;
const historySearchFields = new WeakMap();
const historyTitleCollator = new Intl.Collator("zh-Hans-CN");
root.FlowaveHistoryModule={hostApi:1,methods:{
  setListeningHistoryQuery(value) {
    this.listeningHistoryKeyword = String(value || "").trim();
    this.listeningHistoryPage = 1;
    if (this.$refs.historyTableBody) this.$refs.historyTableBody.scrollTop = 0;
  },
  changeListeningHistoryPage(page) {
    this.listeningHistoryPage = Math.max(1, Math.min(this.listeningHistoryPageCount, page));
    if (this.$refs.historyTableBody) this.$refs.historyTableBody.scrollTop = 0;
  },
  addListeningSeconds(path, seconds, startedAtMs) {
    if(this.featureEnabled?.('history')===false)return;
    const amount = Math.max(0, Number(seconds || 0));
    if (!path || amount <= 0) return;
    const hist = this.listeningHistory || this.getEmptyListeningHistory();
    const item = this.ensureListeningTrack(path);
    item.listenedSeconds += amount;
    item.lastPlayedAt = Date.now();
    hist.totalSeconds = Math.max(0, Number(hist.totalSeconds || 0)) + amount;
    this.addListeningSecondsByDay(amount, startedAtMs || Date.now());
  },
  addListeningSecondsByDay(seconds, startedAtMs) {
    let remain = Math.max(0, Number(seconds || 0));
    let cursor = Number(startedAtMs || Date.now());
    while (remain > 0) {
      const dayKey = this.formatLocalDateKey(cursor);
      const nextDay = new Date(cursor);
      nextDay.setHours(24, 0, 0, 0);
      const chunk = Math.min(remain, Math.max(0.001, (nextDay.getTime() - cursor) / 1000));
      this.listeningHistory.days[dayKey] = Math.max(0, Number(this.listeningHistory.days[dayKey] || 0)) + chunk;
      remain -= chunk;
      cursor += chunk * 1000;
    }
  },
  maybeCountListeningPlay(session) {
    if(this.featureEnabled?.('history')===false)return;
    if (!session || session.counted || !session.path) return;
    const item = this.ensureListeningTrack(session.path);
    const duration = Math.max(0, Number(item.duration || this.duration || 0));
    if (!duration || !Number.isFinite(duration)) return;
    const credited = Math.max(
      0,
      Number(session.creditedMediaSeconds ?? session.listenedSeconds ?? 0)
    );
    if (credited + 0.01 < duration * 0.5) return;
    item.playCount = Math.max(0, Math.floor(Number(item.playCount || 0))) + 1;
    item.lastCountedAt = Date.now();
    this.listeningHistory.totalPlays = Math.max(0, Math.floor(Number(this.listeningHistory.totalPlays || 0))) + 1;
    session.counted = true;
  },
  getListeningDayBars() {
    const today = new Date();
    const days = [];
    for (let i = LISTENING_HISTORY_DAYS - 1; i >= 0; i -= 1) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = this.formatLocalDateKey(d.getTime());
      const seconds = Number(this.listeningHistory?.days?.[key] || 0);
      days.push({
        key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        seconds,
      });
    }
    const max = Math.max(1, ...days.map((d) => d.seconds));
    return days.map((d) => ({
      ...d,
      percent: d.seconds > 0 ? Math.max(2, Math.round((d.seconds / max) * 100)) : 0,
      timeText: this.formatDurationLong(d.seconds),
    }));
  },
  getListeningHistoryRows() {
    const kw = String(this.listeningHistoryKeyword || "").trim().toLowerCase();
    const rows = Object.values(this.listeningHistory?.tracks || {}).filter((item) => (
      Math.max(0, Number(item?.playCount || 0)) > 0
      || Math.max(0, Number(item?.listenedSeconds || 0)) > 0
    )).filter((item) => {
      if (!kw) return true;
      const fields = [item.title || "", item.artist || "", item.album || "", item.path || ""];
      let cached = historySearchFields.get(item);
      if (!cached || fields.some((field, i) => cached.fields[i] !== field)) {
        cached = { fields, text: fields.join(" ").toLowerCase() };
        historySearchFields.set(item, cached);
      }
      return cached.text.includes(kw);
    });
    const sort = String(this.listeningHistorySort || "playCount");
    rows.sort((a, b) => {
      if (sort === "listenedSeconds") return (b.listenedSeconds || 0) - (a.listenedSeconds || 0);
      if (sort === "lastPlayedAt") return (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0);
      if (sort === "title") return historyTitleCollator.compare(String(a.title || ""), String(b.title || ""));
      return (b.playCount || 0) - (a.playCount || 0) || (b.listenedSeconds || 0) - (a.listenedSeconds || 0);
    });
    return rows;
  },
  formatDurationLong(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds || 0)));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}小时${String(m).padStart(2, "0")}分`;
    if (m > 0) return `${m}分${String(s).padStart(2, "0")}秒`;
    return `${s}秒`;
  },
  formatHistoryDate(ts) {
    const n = Number(ts || 0);
    if (!n) return "-";
    const d = new Date(n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  },
}};
})(window);
