const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const screenshot = require('screenshot-desktop')
const axios = require('axios')
const fs = require('fs')
const zlib = require('zlib')

// ─── Hide dock icon immediately (menu bar app) ──────────────────────────────
if (process.platform === 'darwin' && app.dock) app.dock.hide()

// ─── State ──────────────────────────────────────────────────────────────────
let overlayWindow = null
let mainWindow = null
let tray = null
let isProcessing = false
let isPaused = false
let history = []
const historyPath = path.join(app.getPath('userData'), 'covexy-history.json')

// ─── History ────────────────────────────────────────────────────────────────
function loadHistory() {
  try {
    if (fs.existsSync(historyPath)) {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf8'))
      // Keep only last 7 days
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      history = history.filter(h => new Date(h.time).getTime() > cutoff)
    }
  } catch (e) {
    history = []
  }
}

function saveHistory() {
  try { fs.writeFileSync(historyPath, JSON.stringify(history, null, 2)) } catch (e) {}
}

function addToHistory(text, category) {
  const entry = { text, time: new Date().toISOString() }
  if (category) entry.category = category
  history.unshift(entry)
  if (history.length > 200) history = history.slice(0, 200)
  saveHistory()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history-update', history)
  }
}

// ─── PNG Icon Generator (no external deps) ──────────────────────────────────
function makeCRCTable() {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
}
const CRC_TABLE = makeCRCTable()

function crc32(data) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ data[i]) & 0xFF]
  return (c ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crcVal])
}

// Creates a ring/circle icon (22×22 RGBA PNG) — white for template image
function createTrayIconBuffer(size = 22) {
  const pixels = Buffer.alloc(size * size * 4, 0)
  const cx = size / 2, cy = size / 2
  const outerR = size * 0.42, innerR = size * 0.24

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= outerR && d >= innerR) {
        const i = (y * size + x) * 4
        pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; pixels[i + 3] = 255
      }
    }
  }

  const rows = []
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]))
    rows.push(pixels.slice(y * size * 4, (y + 1) * size * 4))
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ─── Tray ────────────────────────────────────────────────────────────────────
function createTray() {
  const buf = createTrayIconBuffer(22)
  const icon = nativeImage.createFromBuffer(buf, { scaleFactor: 1 })
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('Covexy – Silent AI')
  tray.on('click', () => showMainWindow())
  updateTrayMenu()
}

function updateTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'Show Covexy', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: isPaused ? '▶  Resume Watching' : '⏸  Pause Watching',
      click: () => { isPaused = !isPaused; updateTrayMenu() }
    },
    { type: 'separator' },
    {
      label: 'Quit Covexy',
      click: () => { tray?.destroy(); app.exit(0) }
    }
  ])
  tray.setContextMenu(menu)
}

// ─── Windows ─────────────────────────────────────────────────────────────────
function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 420,
    height: 148,
    x: 40,
    y: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  })
  overlayWindow.loadFile('overlay.html')
  overlayWindow.hide()
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 560,
    minWidth: 700,
    minHeight: 460,
    frame: false,
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'main-window-preload.js'),
      contextIsolation: true
    },
    show: false
  })
  mainWindow.loadFile('main-window.html')
  mainWindow.on('close', (e) => { e.preventDefault(); mainWindow.hide() })
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    mainWindow.once('ready-to-show', () => {
      mainWindow.show()
      mainWindow.webContents.send('history-update', history)
    })
  } else if (!mainWindow.isVisible()) {
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('history-update', history)
  } else {
    mainWindow.focus()
  }
}

function showOverlay(message, category) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.webContents.send('show-suggestion', { message, category })
  overlayWindow.show()
  setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
  }, 12000)
}

// ─── AI Analysis ─────────────────────────────────────────────────────────────
const BRAIN_PROMPT = `You are Covexy, a friendly macOS screen-watching assistant. Look at what's on screen and share ONE short, useful observation or tip.

Screen: "{CONTEXT}"

Be generous — respond whenever you see anything interesting, including:
- Any app, document, code, or task the user is working on
- Browser tabs or web content worth noting
- Emails, messages, or notifications
- Errors, warnings, or terminal output
- A deadline, calendar event, or meeting
- Anything worth a friendly nudge or reminder

Only respond SKIP if the screen is completely blank, just a desktop with nothing open, or a screensaver/lock screen.

Respond on ONE line in this exact format:
CATEGORY|Your observation or tip in 10–18 words

CATEGORY must be one of: EMAIL | TABS | ERROR | TASK | DEADLINE | FOCUS | TIP

Good examples:
TIP|Looks like you have been coding for a while — remember to take a break
FOCUS|Deep in that document — consider saving a draft before switching tabs
EMAIL|Gmail is open with unread messages — worth a quick check
ERROR|Terminal output has a red error — might be worth investigating
TABS|Several browser tabs open — could be a good time to close finished ones
SKIP`

async function analyzeScreen() {
  if (isProcessing || isPaused) return
  isProcessing = true

  try {
    // ── Step 1: Screenshot ───────────────────────────────────────────────────
    const imgPath = path.join(app.getPath('temp'), 'covexy_screen.png')
    await screenshot({ filename: imgPath })

    // Confirm the file landed and has real content
    const fileSize = fs.existsSync(imgPath) ? fs.statSync(imgPath).size : 0
    console.log(`[Covexy] 📸 Screenshot saved — ${(fileSize / 1024).toFixed(1)} KB at ${imgPath}`)
    if (fileSize < 1024) {
      console.log('[Covexy] ⚠️  Screenshot too small — likely blank/black (check Screen Recording permission in System Settings)')
      isProcessing = false
      return
    }

    // Read as base64 — Ollama images[] only accepts base64 strings, not file paths
    const imageData = fs.readFileSync(imgPath).toString('base64')

    // ── Step 2: Vision (moondream) ───────────────────────────────────────────
    console.log('[Covexy] 👁  Sending to moondream...')
    const visionRes = await axios.post('http://localhost:11434/api/generate', {
      model: 'moondream',
      prompt: 'What is on this screen?',
      images: [imageData],
      stream: false
    }, { timeout: 120000 })

    // visionRes.data may be a parsed object or a raw string depending on Ollama version
    const visionData = typeof visionRes.data === 'string'
      ? JSON.parse(visionRes.data.trim().split('\n').pop())
      : visionRes.data
    const screenContext = (visionData.response || '').trim()
    console.log('[Covexy] 🖥  Screen seen:', screenContext || '(empty — moondream returned nothing)')

    if (!screenContext) {
      console.log('[Covexy] ⚠️  Moondream gave an empty response — skipping brain call')
      isProcessing = false
      return
    }

    // ── Step 3: Brain (qwen2.5:3b) ───────────────────────────────────────────
    console.log('[Covexy] 🧠 Sending to qwen2.5:3b...')
    const brainRes = await axios.post('http://localhost:11434/api/generate', {
      model: 'qwen2.5:3b',
      prompt: BRAIN_PROMPT.replace('{CONTEXT}', screenContext),
      stream: false
    }, { timeout: 45000 })

    const raw = (brainRes.data.response || '').trim()
    console.log('[Covexy] 💬 Brain says:', raw || '(empty response)')

    if (!raw || raw === 'SKIP' || raw.toUpperCase().startsWith('SKIP')) {
      console.log('[Covexy] ⏭  Skipping — nothing interesting this scan')
      isProcessing = false
      return
    }

    // ── Step 4: Parse and show ────────────────────────────────────────────────
    const pipe = raw.indexOf('|')
    let category = null
    let suggestion = raw
    if (pipe > -1) {
      category = raw.slice(0, pipe).trim().toLowerCase()
      suggestion = raw.slice(pipe + 1).trim()
    }

    if (!suggestion || suggestion.length < 5) {
      console.log('[Covexy] ⏭  Parsed suggestion too short — skipping')
      isProcessing = false
      return
    }

    console.log(`[Covexy] ✅ Showing overlay — [${category || 'general'}] ${suggestion}`)
    addToHistory(suggestion, category)
    showOverlay(suggestion, category)

  } catch (err) {
    console.log('[Covexy] ❌ Error during analysis:', err.message)
  }

  isProcessing = false
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.on('overlay-action', (event, action) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
  if (action === 'help') showMainWindow()
})

ipcMain.on('close-main-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
})

ipcMain.on('minimize-main-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
})

ipcMain.handle('get-history', () => history)

ipcMain.handle('chat-message', async (event, message) => {
  const res = await axios.post('http://localhost:11434/api/generate', {
    model: 'qwen2.5:3b',
    prompt: `You are Covexy, a helpful macOS productivity AI. Be concise, friendly, and practical. User says: ${message}`,
    stream: false
  }, { timeout: 60000 })
  return res.data.response?.trim() || 'Sorry, I had trouble generating a response.'
})

// ─── Boot ─────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadHistory()
  createOverlayWindow()
  createTray()
  console.log('[Covexy] Running in menu bar. First scan in 15s, then every 3 minutes.')
  setTimeout(() => {
    analyzeScreen()
    setInterval(analyzeScreen, 180000)
  }, 15000)
})

app.on('window-all-closed', (e) => e.preventDefault())
