const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // ── One-time data fetch ──────────────────────────────────────
  getInsights:    ()    => ipcRenderer.invoke('get-insights'),
  getMemory:      ()    => ipcRenderer.invoke('get-memory'),
  getChatHistory: ()    => ipcRenderer.invoke('get-chat-history'),
  getSettings:    ()    => ipcRenderer.invoke('get-settings'),
  getProfile:     ()    => ipcRenderer.invoke('get-profile'),
  getVersion:     ()    => ipcRenderer.invoke('get-version'),

  // ── Actions ─────────────────────────────────────────────────
  sendChat:          (msg)  => ipcRenderer.invoke('send-chat', msg),
  saveSettings:      (data) => ipcRenderer.invoke('save-settings', data),
  reTestApiKey:      (key)  => ipcRenderer.invoke('re-test-api-key', key),
  clearMemory:       ()     => ipcRenderer.invoke('clear-memory'),
  openProfileEditor: ()     => ipcRenderer.send('open-profile-editor'),
  closeWindow:       ()     => ipcRenderer.send('close-main-window'),
  minimizeWindow:    ()     => ipcRenderer.send('minimize-main-window'),
  getBraveKeyStatus: ()     => ipcRenderer.invoke('get-brave-key-status'),
  saveBraveKey:      (key)  => ipcRenderer.invoke('save-brave-key', key),
  testBraveKey:      (key)  => ipcRenderer.invoke('test-brave-key', key),

  // ── Push subscriptions ───────────────────────────────────────
  onInsightsUpdate:  (cb) => ipcRenderer.on('insights-update',   (_, d) => cb(d)),
  onMemoryUpdate:    (cb) => ipcRenderer.on('memory-update',     (_, d) => cb(d)),
  onSettingsUpdate:  (cb) => ipcRenderer.on('settings-update',   (_, d) => cb(d)),
  onProfileUpdate:   (cb) => ipcRenderer.on('profile-update',    (_, d) => cb(d)),
  onShowChatContext: (cb) => ipcRenderer.on('show-chat-context', (_, d) => cb(d)),
})
