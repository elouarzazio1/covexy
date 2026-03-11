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
const BRAIN_PROMPT = `You are Covexy, a macOS screen-watching AI. Analyze the screen description and decide if the user needs a nudge.

Screen: "{CONTEXT}"

ONLY respond with a suggestion when you spot one of these SPECIFIC situations:
- An unanswered email or message clearly visible on screen
- Multiple browser tabs open exploring the same topic (research sprawl)
- A terminal or code error / warning message on screen
- A document or form with obviously incomplete required sections
- A meeting, calendar event, or deadline visible that needs action
- A clearly stalled task: blank doc, empty form, cursor blinking with nothing typed

If NONE of these clearly apply → respond with exactly: SKIP

If action IS needed, respond ONLY in this format (one line):
CATEGORY|Short actionable suggestion in 8–15 words

Where CATEGORY is one of: EMAIL | TABS | ERROR | TASK | DEADLINE | FOCUS

Good examples:
EMAIL|Reply to Sarah about the Q4 report – she's waiting on you
TABS|You have 8 tabs on TypeScript generics – save them and close?
ERROR|Python ModuleNotFoundError in terminal – run pip install to fix
TASK|Checkout form is half-filled – complete the shipping address
SKIP`

async function analyzeScreen() {
  if (isProcessing || isPaused) return
  isProcessing = true

  try {
    const imgPath = path.join(app.getPath('temp'), 'covexy_screen.png')
    await screenshot({ filename: imgPath })
    const imageData = fs.readFileSync(imgPath, { encoding: 'base64' })

    // Step 1: Vision — describe the screen precisely
    const visionRes = await axios.post('http://localhost:11434/api/generate', {
      model: 'moondream',
      prompt: 'List every visible app, window, and key text on screen. Include: app names, email subjects, error messages, tab titles, document names, any visible deadlines or names.',
      images: [imageData],
      stream: false
    }, { timeout: 30000 })

    const screenContext = visionRes.data.response?.trim()
    if (!screenContext) { isProcessing = false; return }
    console.log('[Covexy] Screen:', screenContext)

    // Step 2: Brain — decide if action is genuinely needed
    const brainRes = await axios.post('http://localhost:11434/api/generate', {
      model: 'qwen2.5:3b',
      prompt: BRAIN_PROMPT.replace('{CONTEXT}', screenContext),
      stream: false
    }, { timeout: 30000 })

    const raw = brainRes.data.response?.trim()
    console.log('[Covexy] Brain:', raw)

    if (!raw || raw === 'SKIP' || raw.startsWith('SKIP')) {
      console.log('[Covexy] No action needed — skipping')
      isProcessing = false; return
    }

    // Parse CATEGORY|suggestion
    const pipe = raw.indexOf('|')
    let category = null, suggestion = raw
    if (pipe > -1) {
      category = raw.slice(0, pipe).trim().toLowerCase()
      suggestion = raw.slice(pipe + 1).trim()
    }

    if (!suggestion || suggestion.length < 5 || suggestion.startsWith('SKIP')) {
      isProcessing = false; return
    }

    addToHistory(suggestion, category)
    showOverlay(suggestion, category)

  } catch (err) {
    console.log('[Covexy] Error:', err.message)
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
  console.log('[Covexy] Running in menu bar. First scan in 15s...')
  setTimeout(() => {
    analyzeScreen()
    setInterval(analyzeScreen, 60000)
  }, 15000)
})

app.on('window-all-closed', (e) => e.preventDefault())
