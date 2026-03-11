const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onShowSuggestion: (cb)             => ipcRenderer.on('show-suggestion',  (_, d) => cb(d)),
  sendAction:       (action)         => ipcRenderer.send('overlay-action',  action),
  sendFeedback:     (type, insight)  => ipcRenderer.send('overlay-feedback', { type, insight }),
  openChat:         (insight)        => ipcRenderer.send('overlay-open-chat', { insight }),
})
