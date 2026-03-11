const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getHistory: () => ipcRenderer.invoke('get-history'),
  onHistoryUpdate: (cb) => ipcRenderer.on('history-update', (_, data) => cb(data)),
  sendChatMessage: (msg) => ipcRenderer.invoke('chat-message', msg),
  closeWindow: () => ipcRenderer.send('close-main-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-main-window')
})
