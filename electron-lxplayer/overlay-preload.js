const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lxOverlay", {
  onUpdate: (cb) => ipcRenderer.on("lx-lyric-overlay-update", (_, data) => cb?.(data || {})),
  onSettings: (cb) => ipcRenderer.on("lx-lyric-overlay-settings", (_, data) => cb?.(data || {})),
  onLock: (cb) => ipcRenderer.on("lx-lyric-overlay-lock", (_, data) => cb?.(data || {})),
  emitAction: (action, payload) => ipcRenderer.send("lx-lyric-overlay-action", { action, payload }),
});
