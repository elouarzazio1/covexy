'use strict'

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage,
  desktopCapturer, safeStorage, dialog
} = require('electron')
const path   = require('path')
const axios  = require('axios')
const fs     = require('fs')
const zlib   = require('zlib')
const screenshot = require('screenshot-desktop') // fallback capturer

// ─── Constants ────────────────────────────────────────────────────────────────
const MODEL          = 'google/gemini-3-flash-preview'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const APP_VERSION    = '3.0.0'
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://covexy.com', 'X-Title': 'Covexy' }

// ─── Dock ─────────────────────────────────────────────────────────────────────
if (process.platform === 'darwin' && app.dock) app.dock.hide()

// ─── Runtime state ────────────────────────────────────────────────────────────
let overlayWindow   = null
let mainWindow      = null
let onboardingWindow = null
let tray            = null
let isProcessing    = false
let isPaused        = false
let lastNotifTime   = 0   // ms — enforces 10-min cooldown between overlays
let scanTimer       = null

// ─── In-memory data ────────────────────────────────────────────────────────────
let apiKey          = null
let profile         = null
let memory          = []
let settings        = { scanInterval: 180000, memoryDays: 7 }
let todayActivity   = []
let todayChatHistory = []

// ─── File paths (populated after app.getPath is available) ───────────────────
let DATA_DIR, PROFILE_PATH, MEMORY_PATH, SETTINGS_PATH, KEY_PATH

function initPaths () {
  DATA_DIR      = app.getPath('userData')
  PROFILE_PATH  = path.join(DATA_DIR, 'covexy-profile.json')
  MEMORY_PATH   = path.join(DATA_DIR, 'covexy-memory.json')
  SETTINGS_PATH = path.join(DATA_DIR, 'covexy-settings.json')
  KEY_PATH      = path.join(DATA_DIR, 'covexy-key.bin')
}

function todayStr () { return new Date().toISOString().split('T')[0] }
function chatFile   (d = todayStr()) { return path.join(DATA_DIR, `covexy-chat-${d}.json`) }
function actFile    (d = todayStr()) { return path.join(DATA_DIR, `covexy-activity-${d}.json`) }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uid () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9) }
function safeRead (p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}
function safeWrite (p, data) {
  try { fs.writeFileSync(p, JSON.stringify(data, null, 2)) } catch (e) {
    console.error('[Covexy] Write error:', e.message)
  }
}

// ─── API Key ──────────────────────────────────────────────────────────────────
function saveApiKey (key) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(KEY_PATH, safeStorage.encryptString(key))
    } else {
      fs.writeFileSync(KEY_PATH, key, 'utf8')
    }
    apiKey = key
  } catch (e) { console.error('[Covexy] saveApiKey error:', e.message) }
}

function loadApiKey () {
  try {
    if (!fs.existsSync(KEY_PATH)) return null
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(fs.readFileSync(KEY_PATH))
    }
    return fs.readFileSync(KEY_PATH, 'utf8')
  } catch { return null }
}

// ─── Profile ──────────────────────────────────────────────────────────────────
function loadProfile  () { profile = safeRead(PROFILE_PATH) }
function saveProfile  (data) { profile = data; safeWrite(PROFILE_PATH, data) }

function buildProfileText () {
  if (!profile) return 'Unknown user — no profile set.'
  return [
    profile.name        ? `Name: ${profile.name}`                                : null,
    profile.profession  ? `Profession: ${profile.profession}`                    : null,
    profile.projects    ? `Current priorities: ${profile.projects}`               : null,
    profile.ignore      ? `Do NOT interrupt about: ${profile.ignore}`             : null,
    profile.style       ? `Communication style: ${profile.style}`                 : null,
  ].filter(Boolean).join('\n')
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettings () {
  const s = safeRead(SETTINGS_PATH)
  if (s) settings = { ...settings, ...s }
}
function saveSettings (data) {
  settings = { ...settings, ...data }
  safeWrite(SETTINGS_PATH, settings)
}

// ─── Memory ───────────────────────────────────────────────────────────────────
function loadMemory () {
  const data = safeRead(MEMORY_PATH, { entries: [] })
  memory = data.entries || []
  pruneMemory(false)
}

function pruneMemory (save = true) {
  const cutoff = Date.now() - settings.memoryDays * 864e5
  memory = memory.filter(e => new Date(e.timestamp).getTime() > cutoff)
  if (save) safeWrite(MEMORY_PATH, { entries: memory })
}

function addMemoryEntry (entry) {
  const item = { id: uid(), timestamp: new Date().toISOString(), ...entry }
  memory.unshift(item)
  if (memory.length > 500) memory = memory.slice(0, 500)
  safeWrite(MEMORY_PATH, { entries: memory })
  push('memory-update', memory.slice(0, 60))
}

function getRecentMemory (n = 10) {
  return memory.slice(0, n).map(m => `[${m.category || m.type}] ${m.content}`).join('\n') || 'No memories yet.'
}

// ─── Activity log ─────────────────────────────────────────────────────────────
function loadTodayActivity () {
  todayActivity = safeRead(actFile(), [])
}

function addActivity (description, triggered = false) {
  todayActivity.push({ timestamp: new Date().toISOString(), description, triggered })
  safeWrite(actFile(), todayActivity)
}

function todayActivityText () {
  if (!todayActivity.length) return 'No screen activity recorded yet today.'
  return todayActivity.slice(-20)
    .map(a => `[${new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}] ${a.description}`)
    .join('\n')
}

// ─── Chat history ─────────────────────────────────────────────────────────────
function loadTodayChat () {
  todayChatHistory = safeRead(chatFile(), [])
}

function appendChat (role, content) {
  todayChatHistory.push({ role, content, ts: new Date().toISOString() })
  safeWrite(chatFile(), todayChatHistory)
}

// ─── Screenshot ───────────────────────────────────────────────────────────────
async function captureScreen () {
  // Try desktopCapturer first
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 800 }
    })
    if (sources.length) {
      const thumb = sources[0].thumbnail
      const sz    = thumb.getSize()
      let img = thumb
      if (sz.width > 1280) {
        img = thumb.resize({ width: 1280, height: Math.floor(sz.height * 1280 / sz.width) })
      }
      const buf = img.toJPEG(80)
      if (buf.length > 5000) {
        console.log(`[Covexy] 📸 desktopCapturer — ${(buf.length / 1024).toFixed(1)} KB`)
        return buf.toString('base64')
      }
    }
  } catch (e) {
    console.log('[Covexy] desktopCapturer failed, using fallback:', e.message)
  }

  // Fallback: screenshot-desktop → nativeImage → JPEG
  const tmp = path.join(app.getPath('temp'), 'covexy_snap.png')
  await screenshot({ filename: tmp })
  const stat = fs.existsSync(tmp) ? fs.statSync(tmp) : null
  if (!stat || stat.size < 1024) throw new Error('Screenshot blank — check Screen Recording permission')
  const img  = nativeImage.createFromPath(tmp)
  const sz   = img.getSize()
  let w = sz.width, h = sz.height
  if (w > 1280) { h = Math.floor(h * 1280 / w); w = 1280 }
  const resized = (w < sz.width) ? img.resize({ width: w, height: h }) : img
  const buf = resized.toJPEG(80)
  console.log(`[Covexy] 📸 fallback capturer — ${(buf.length / 1024).toFixed(1)} KB`)
  return buf.toString('base64')
}

// ─── OpenRouter helpers ───────────────────────────────────────────────────────
async function aiChat (messages, timeoutMs = 30000, key = apiKey) {
  const res = await axios.post(OPENROUTER_URL, { model: MODEL, messages }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...OPENROUTER_HEADERS },
    timeout: timeoutMs
  })
  return res.data.choices?.[0]?.message?.content?.trim() || ''
}

async function testApiKey (key) {
  const reply = await aiChat([{ role: 'user', content: 'Reply with only the word OK.' }], 20000, key)
  return reply.toLowerCase().includes('ok')
}

// ─── Proactive system prompt ──────────────────────────────────────────────────
const PROACTIVE_SYSTEM = `You are Covexy, a silent AI that runs on Othmane's Mac. Every 3 minutes you see a screenshot of his screen. You have one job: notice something genuinely useful that Othmane would thank you for surfacing.

You are not a notification machine. You fire rarely and only when it matters. If you are not certain the insight is valuable, respond SKIP.

WHO OTHMANE IS:
{{PROFILE}}

WHAT YOU HAVE NOTICED RECENTLY:
{{MEMORY}}

WHAT MAKES A GOOD INSIGHT — only trigger for these:
- An email or message thread visible on screen that looks important and unanswered for more than a few hours
- A document being edited that has an obvious gap, missing section, or weak argument Othmane might not have noticed
- Multiple tabs or windows on the same topic suggesting deep research — offer to synthesize
- Content directly related to mention.ma, Inference Watch, GEO, AI market intelligence, or Othmane's stated priorities — surface a connection or next step
- A deadline, meeting, or task visible on screen that appears at risk
- A repeated pattern across recent screenshots — same app, same stuck point — surface the pattern gently
- Something Othmane was working on earlier today that appears abandoned — a gentle reminder if it seems important

WHAT NEVER TRIGGERS A NOTIFICATION:
- Terminal, code editors, developer tools, Claude Code
- Any AI assistant interface (ChatGPT, Claude, Perplexity)
- File manager, system preferences, OS dialogs
- Screensaver, lock screen, blank screen, desktop
- Active video playback or podcast listening (do not interrupt)
- News browsing or casual reading (log it silently, do not interrupt)
- Anything matching the user's ignore list: {{IGNORE_LIST}}
- Any insight you already surfaced in the last 45 minutes

QUALITY BAR:
Before responding with an insight, ask yourself: would Othmane thank me for interrupting him with this right now? If the answer is not a clear yes, respond SKIP.

If nothing qualifies, respond:
SKIP: [one sentence describing what you see on screen — this is logged privately, not shown to Othmane]

Otherwise use this exact format:
CATEGORY: [EMAIL / TASK / RESEARCH / IDEA / FOCUS / ALERT / WRITING]
INSIGHT: [one sentence, max 20 words, direct, specific, no "I notice" or "It seems"]
ACTION: [optional: one follow-up action, max 10 words]
CONFIDENCE: [HIGH / MEDIUM] — only HIGH confidence insights are shown as notifications; MEDIUM is logged silently to memory for chat context`

// ─── Chat system prompt ───────────────────────────────────────────────────────
const CHAT_SYSTEM = `You are Covexy, the user's personal AI assistant. You are not a generic chatbot. You know this person, you have been watching their day, and you are here to help them work better, think clearer, and do more.

USER PROFILE:
{{PROFILE}}

WHAT COVEXY SAW TODAY (screen activity log):
{{TODAY_ACTIVITY}}

RECENT MEMORY ABOUT THIS USER:
{{MEMORY}}

YOUR CAPABILITIES IN CHAT:
- Summarize articles, videos, or documents the user pastes or describes
- Write or improve LinkedIn posts, emails, blog articles in the user's voice
- Explain concepts clearly and teach the user things they are curious about
- Connect dots between things seen on screen today and the user's projects
- Draft replies to emails based on context
- Suggest what to focus on next based on what you know about their day
- Answer any professional or personal question directly and intelligently

TONE AND STYLE:
- Write exactly as specified in the user's profile communication preference
- Be direct. No filler sentences. No "Great question!" No "Certainly!"
- When writing content for the user (posts, emails, drafts), match their voice — not a generic AI voice
- When teaching or explaining, be clear and specific, use concrete examples
- Always add value. Every response should give the user something they did not have before.

WEB SEARCH CAPABILITY:
When the user's message requires current information, live search results will be prepended as [Web context: ...]. Always prefer these searched facts over your training data assumptions. When you see web context, reference it directly and naturally.

IMPORTANT: You have context about what the user has been doing today from the screen activity log. Use this naturally — refer to what they were reading, working on, or researching without making it feel creepy. Act like a colleague who was in the room.`

// ─── Web search ───────────────────────────────────────────────────────────────
async function webSearch (query) {
  const res = await axios.get('https://api.duckduckgo.com/', {
    params: { q: query, format: 'json', no_redirect: 1, no_html: 1 },
    timeout: 8000
  })
  return res.data.AbstractText ||
         res.data.RelatedTopics?.[0]?.Text ||
         ''
}

const SEARCH_RE = /mention\.ma|inferencewatch|inference\s*watch|\bgeo\b|competitor|market\s*share|news|latest|recent|funding|launch|announc|valuation|startup|growth\s*rate|trend/i

function shouldSearchForMessage (msg) {
  return SEARCH_RE.test(msg)
}

async function enrichProfileContext () {
  // Run once per install — skip if profile_context already in memory
  if (memory.some(m => m.type === 'profile_context')) return
  console.log('[Covexy] 🔍 Running profile enrichment searches...')
  const queries = [
    { q: 'mention.ma GEO AI referencing',            tag: 'mention_ma'    },
    { q: 'inferencewatch.com AI inference tracking', tag: 'inferencewatch' },
  ]
  for (const { q, tag } of queries) {
    try {
      const result = await webSearch(q)
      if (result && result.length > 30) {
        addMemoryEntry({ type: 'profile_context', content: result.slice(0, 300), category: 'CONTEXT', tags: ['profile_context', tag] })
        console.log(`[Covexy] 🔍 Enriched context: ${tag}`)
      }
    } catch { /* non-critical */ }
    await new Promise(r => setTimeout(r, 700))
  }
}

// ─── Proactive analysis ───────────────────────────────────────────────────────
async function analyzeScreen () {
  if (isProcessing || isPaused || !apiKey) return
  isProcessing = true

  try {
    const base64 = await captureScreen()

    const systemPrompt = PROACTIVE_SYSTEM
      .replace('{{PROFILE}}',     buildProfileText())
      .replace('{{MEMORY}}',      getRecentMemory(10))
      .replace('{{IGNORE_LIST}}', profile?.ignore || 'nothing specified')

    console.log('[Covexy] 👁  Sending for analysis...')

    const raw = await aiChat([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: 'text', text: 'Analyze this screenshot according to your instructions.' }
        ]
      }
    ], 60000)

    console.log('[Covexy] 💬 Response:', raw.slice(0, 150))

    // SKIP — parse optional description for the activity log
    if (!raw || /^SKIP/i.test(raw.trim())) {
      const skipDesc = raw.replace(/^SKIP:?\s*/i, '').trim() || 'nothing noteworthy on screen'
      console.log('[Covexy] ⏭  Skip:', skipDesc.slice(0, 80))
      addActivity(skipDesc, false)
      isProcessing = false
      return
    }

    // Parse structured response
    const catMatch    = raw.match(/CATEGORY:\s*(.+)/i)
    const insMatch    = raw.match(/INSIGHT:\s*(.+)/i)
    const actMatch    = raw.match(/ACTION:\s*(.+)/i)
    const confMatch   = raw.match(/CONFIDENCE:\s*(HIGH|MEDIUM)/i)

    const category   = (catMatch?.[1] || 'FOCUS').trim().toUpperCase()
    const insight    = insMatch?.[1]?.trim()
    const action     = actMatch?.[1]?.trim() || ''
    const confidence = (confMatch?.[1] || 'HIGH').trim().toUpperCase()

    if (!insight || insight.length < 5) {
      console.log('[Covexy] ⏭  Unparseable response — logging')
      addActivity('Screen scanned — unclear AI response', false)
      isProcessing = false
      return
    }

    // Always log to memory and activity regardless of confidence
    addMemoryEntry({ type: 'proactive_insight', content: insight, category, action, tags: [category.toLowerCase()], confidence })
    addActivity(`${category}: ${insight}`, confidence === 'HIGH')
    push('insights-update', getInsights())

    // MEDIUM — log silently, no toast
    if (confidence === 'MEDIUM') {
      console.log(`[Covexy] 💡 Medium confidence [${category}]: ${insight} — logged silently`)
      isProcessing = false
      return
    }

    // HIGH — enforce 45-minute cooldown between toasts
    if (Date.now() - lastNotifTime < 45 * 60 * 1000) {
      console.log('[Covexy] ⏭  Cooldown active — skipping toast')
      isProcessing = false
      return
    }

    console.log(`[Covexy] ✅ HIGH confidence [${category}]: ${insight}`)
    lastNotifTime = Date.now()
    showOverlay({ category, insight, action })

  } catch (err) {
    console.log('[Covexy] ❌ Scan error:', err.message)
    addActivity(`Scan error: ${err.message}`, false)
  }

  isProcessing = false
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
async function sendChatMessage (userMessage) {
  // Auto-search when the message is about current events / products
  let contextPrefix = ''
  if (shouldSearchForMessage(userMessage)) {
    try {
      const snippet = await webSearch(userMessage.slice(0, 120))
      if (snippet && snippet.length > 30) {
        contextPrefix = `[Web context: ${snippet.slice(0, 400)}]\n\n`
        console.log('[Covexy] 🔍 Web context prepended to chat message')
      }
    } catch { /* non-critical — proceed without search */ }
  }

  const systemPrompt = CHAT_SYSTEM
    .replace('{{PROFILE}}',        buildProfileText())
    .replace('{{TODAY_ACTIVITY}}', todayActivityText())
    .replace('{{MEMORY}}',         getRecentMemory(10))

  const historyMsgs = todayChatHistory.slice(-20).map(({ role, content }) => ({ role, content }))

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyMsgs,
    { role: 'user', content: contextPrefix + userMessage }
  ]

  const reply = await aiChat(messages, 30000)

  appendChat('user', userMessage)
  appendChat('assistant', reply)

  // Fire-and-forget memory extraction
  extractChatMemory(userMessage, reply)

  return reply
}

async function extractChatMemory (userMsg, aiReply) {
  try {
    const prompt = `User said: "${userMsg}"\nAI said: "${aiReply.slice(0, 300)}"\n\nDid this exchange reveal a meaningful fact about the user (preference, project detail, opinion, or decision)? If yes, write ONE short sentence summarizing it. If no, write NOTHING.`
    const result = await aiChat([{ role: 'user', content: prompt }], 15000)
    if (result && result.trim().toUpperCase() !== 'NOTHING' && result.length > 8) {
      addMemoryEntry({ type: 'chat_learning', content: result.trim(), category: 'LEARNING', tags: ['chat'] })
    }
  } catch { /* silent — memory extraction is non-critical */ }
}

function getInsights () {
  return memory.filter(m => m.type === 'proactive_insight').slice(0, 60)
}

// ─── Scanner lifecycle ────────────────────────────────────────────────────────
function startScanner () {
  if (scanTimer) clearInterval(scanTimer)
  console.log(`[Covexy] 🔁 Scanner started — every ${settings.scanInterval / 1000}s`)
  setTimeout(() => {
    analyzeScreen()
    scanTimer = setInterval(analyzeScreen, settings.scanInterval)
  }, 15000)
}

function restartScanner () {
  if (scanTimer) clearInterval(scanTimer)
  scanTimer = setInterval(analyzeScreen, settings.scanInterval)
}

// ─── Push helper (send to main window if open) ────────────────────────────────
function push (channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

// ─── PNG tray icon (no external deps) ────────────────────────────────────────
function makeCRCTable () {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
}
const CRC = makeCRCTable()
function crc32 (d) { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = (c >>> 8) ^ CRC[(c ^ d[i]) & 0xFF]; return (c ^ 0xFFFFFFFF) >>> 0 }
function pngChunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
function makeTrayIcon (size = 22) {
  const px = Buffer.alloc(size * size * 4, 0)
  const cx = size / 2, cy = size / 2
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.sqrt((x + .5 - cx) ** 2 + (y + .5 - cy) ** 2)
    if (d <= size * .42 && d >= size * .24) { const i = (y * size + x) * 4; px[i] = px[i+1] = px[i+2] = px[i+3] = 255 }
  }
  const rows = []; for (let y = 0; y < size; y++) { rows.push(Buffer.from([0])); rows.push(px.slice(y * size * 4, (y+1) * size * 4)) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))])
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray () {
  if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null } // prevent duplicate on hot-reload
  const icon = nativeImage.createFromBuffer(makeTrayIcon(22), { scaleFactor: 1 })
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Covexy – Your silent AI')
  tray.on('click', () => showMainWindow())
  updateTrayMenu()
}

function updateTrayMenu () {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Covexy',            click: showMainWindow },
    { type: 'separator' },
    { label: isPaused ? '▶  Resume Watching' : '⏸  Pause Watching',
      click: () => { isPaused = !isPaused; updateTrayMenu() } },
    { type: 'separator' },
    { label: 'Quit', click: () => { tray?.destroy(); app.exit(0) } }
  ]))
}

// ─── Overlay window ───────────────────────────────────────────────────────────
function createOverlayWindow () {
  overlayWindow = new BrowserWindow({
    width: 300, height: 150, frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    focusable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  })
  overlayWindow.loadFile('overlay.html')
  overlayWindow.hide()
}

function showOverlay ({ category, insight, action }) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  // Position top-right, 16px from each edge — re-evaluated each show in case resolution changed
  const { screen } = require('electron')
  const { width } = screen.getPrimaryDisplay().workAreaSize
  overlayWindow.setPosition(width - 316, 16)
  overlayWindow.webContents.send('show-suggestion', { category, insight, action })
  overlayWindow.show()
  // Auto-dismiss is handled entirely by overlay.js countdown timer
}

// ─── Onboarding window ────────────────────────────────────────────────────────
function createOnboardingWindow (editMode = false) {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) { onboardingWindow.focus(); return }
  onboardingWindow = new BrowserWindow({
    width: 780, height: 540, frame: false, transparent: true,
    resizable: false, center: true,
    webPreferences: { preload: path.join(__dirname, 'onboarding-preload.js'), contextIsolation: true }
  })
  onboardingWindow.loadFile('onboarding.html', editMode ? { query: { edit: '1' } } : {})
  onboardingWindow.on('closed', () => { onboardingWindow = null })
}

// ─── Main window ──────────────────────────────────────────────────────────────
function createMainWindow () {
  mainWindow = new BrowserWindow({
    width: 900, height: 600, minWidth: 720, minHeight: 480,
    frame: false, transparent: true, vibrancy: 'under-window',
    visualEffectState: 'active', hasShadow: true,
    webPreferences: { preload: path.join(__dirname, 'main-window-preload.js'), contextIsolation: true },
    show: false
  })
  mainWindow.loadFile('main-window.html')
  mainWindow.on('close', e => { e.preventDefault(); mainWindow.hide() })
}

function showMainWindow () {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    mainWindow.once('ready-to-show', () => {
      mainWindow.show()
      pushAllData()
    })
  } else if (!mainWindow.isVisible()) {
    mainWindow.show(); mainWindow.focus(); pushAllData()
  } else {
    mainWindow.focus()
  }
}

function pushAllData () {
  push('insights-update',  getInsights())
  push('memory-update',    memory.slice(0, 60))
  push('chat-history',     todayChatHistory)
  push('settings-update',  settings)
  push('profile-update',   profile)
  push('version',          APP_VERSION)
}

// ─── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('overlay-action', (_, action) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
})

ipcMain.on('overlay-feedback', (_, { type, insight }) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
  if (type === 'thumbs-up') {
    addMemoryEntry({ type: 'feedback_positive', content: `Helpful: ${insight}`, category: 'FEEDBACK', tags: ['feedback', 'positive'] })
    console.log('[Covexy] 👍 Positive feedback saved')
  } else {
    addMemoryEntry({ type: 'feedback_negative', content: `Not useful — avoid repeating: ${insight}`, category: 'FEEDBACK', tags: ['feedback', 'negative'] })
    console.log('[Covexy] 👎 Negative feedback saved')
  }
})

ipcMain.on('overlay-open-chat', (_, { insight }) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
  showMainWindow()
  setTimeout(() => push('show-chat-context', insight), 350)
})

ipcMain.on('close-main-window',    () => mainWindow?.hide())
ipcMain.on('minimize-main-window', () => mainWindow?.minimize())
ipcMain.on('onboarding-complete',  () => {
  onboardingWindow?.close()
  apiKey = loadApiKey()
  showMainWindow()
  startScanner()
})
ipcMain.on('profile-edit-done', () => {
  onboardingWindow?.close()
  pushAllData()
})

// Onboarding
ipcMain.handle('test-api-key', async (_, key) => {
  try { return { ok: await testApiKey(key) } }
  catch (e) { return { ok: false, error: e.message } }
})
ipcMain.handle('save-api-key', (_, key) => {
  saveApiKey(key); return true
})
ipcMain.handle('onboarding-save-profile', (_, data) => {
  saveProfile(data); return true
})
ipcMain.handle('get-edit-profile', () => profile)

// Main window data
ipcMain.handle('get-insights',      () => getInsights())
ipcMain.handle('get-memory',        () => memory.slice(0, 60))
ipcMain.handle('get-chat-history',  () => todayChatHistory)
ipcMain.handle('get-settings',      () => settings)
ipcMain.handle('get-profile',       () => profile)
ipcMain.handle('get-version',       () => APP_VERSION)

ipcMain.handle('send-chat', async (_, msg) => {
  try { return { ok: true, reply: await sendChatMessage(msg) } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('save-settings', (_, data) => {
  saveSettings(data)
  if (data.scanInterval && data.scanInterval !== settings.scanInterval) restartScanner()
  return true
})

ipcMain.handle('save-profile-from-settings', (_, data) => {
  saveProfile(data); pushAllData(); return true
})

ipcMain.handle('re-test-api-key', async (_, key) => {
  try {
    const ok = await testApiKey(key)
    if (ok) saveApiKey(key)
    return { ok }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('clear-memory', () => {
  memory = []; safeWrite(MEMORY_PATH, { entries: [] })
  push('memory-update', [])
  return true
})

ipcMain.on('open-profile-editor', () => createOnboardingWindow(true))

// ─── Boot ─────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  initPaths()
  loadSettings()
  apiKey = loadApiKey()
  loadProfile()
  loadMemory()
  loadTodayActivity()
  loadTodayChat()

  createOverlayWindow()
  createTray()

  // Midnight pruner
  const msToMidnight = () => { const n = new Date(); const m = new Date(n); m.setHours(24,0,5,0); return m - n }
  const schedulePrune = () => setTimeout(() => { pruneMemory(); schedulePrune() }, msToMidnight())
  schedulePrune()

  if (!apiKey || !profile) {
    console.log('[Covexy] First launch — showing onboarding')
    createOnboardingWindow()
  } else {
    console.log('[Covexy] ✅ Ready — showing main window, starting scanner')
    showMainWindow()
    startScanner()
    setTimeout(() => enrichProfileContext(), 6000) // enrich after UI settles
  }
})

app.on('window-all-closed', e => e.preventDefault())
