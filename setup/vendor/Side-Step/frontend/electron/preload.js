const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sidestepElectron", {
  getToken: () => ipcRenderer.invoke("get-token"),
  notify: (title, body) => ipcRenderer.invoke("notify", { title, body }),
  onBootError: (msg) => ipcRenderer.send("boot-error", String(msg)),
  onCloseRequested: (cb) => ipcRenderer.on("close-requested", () => cb()),
  confirmClose: () => ipcRenderer.send("confirm-close"),
});
