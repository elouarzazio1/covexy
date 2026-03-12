const { contextBridge, ipcRenderer, shell } = require('electron')

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
  saveOpenRouterKey: (key)  => ipcRenderer.invoke('save-openrouter-key', key),
  clearMemory:       ()     => ipcRenderer.invoke('clear-memory'),
  openProfileEditor: ()     => ipcRenderer.send('open-profile-editor'),
  closeWindow:       ()     => ipcRenderer.send('close-main-window'),
  minimizeWindow:    ()     => ipcRenderer.send('minimize-main-window'),
  getApiKeyStatus:    ()    => ipcRenderer.invoke('get-api-key-status'),
  getTavilyKeyStatus: ()    => ipcRenderer.invoke('get-tavily-key-status'),
  saveTavilyKey:     (key)  => ipcRenderer.invoke('save-tavily-key', key),
  testTavilyKey:     (key)  => ipcRenderer.invoke('test-tavily-key', key),
  getWhisperStatus:  ()     => ipcRenderer.invoke('get-whisper-status'),
  openExternal:      (url)  => shell.openExternal(url),
  rateInsight:       (ts, r) => ipcRenderer.invoke('rate-insight', ts, r),

  // ── Push subscriptions ───────────────────────────────────────
  onSwitchTab:       (cb) => ipcRenderer.on('switch-tab',       (_, d) => cb(d)),
  onInsightsUpdate:  (cb) => ipcRenderer.on('insights-update',   (_, d) => cb(d)),
  onMemoryUpdate:    (cb) => ipcRenderer.on('memory-update',     (_, d) => cb(d)),
  onSettingsUpdate:  (cb) => ipcRenderer.on('settings-update',   (_, d) => cb(d)),
  onProfileUpdate:   (cb) => ipcRenderer.on('profile-update',    (_, d) => cb(d)),
  onShowChatContext: (cb) => ipcRenderer.on('show-chat-context', (_, d) => cb(d)),
})
