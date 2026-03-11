const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onShowSuggestion: (cb) => ipcRenderer.on('show-suggestion', (_, data) => cb(data)),
  sendAction: (action) => ipcRenderer.send('overlay-action', action)
})
