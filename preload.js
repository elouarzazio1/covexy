const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onShowSuggestion: (callback) => {
    ipcRenderer.on('show-suggestion', (event, message) => {
      callback(message)
    })
  },
  sendAction: (action) => {
    ipcRenderer.send('overlay-action', action)
  }
})
