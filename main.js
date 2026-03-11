const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const screenshot = require('screenshot-desktop')
const axios = require('axios')
const fs = require('fs')

let overlayWindow = null
let isProcessing = false

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 420,
    height: 140,
    x: 20,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  })
  overlayWindow.loadFile('overlay.html')
  overlayWindow.hide()
}

async function analyzeScreen() {
  if (isProcessing) return
  isProcessing = true

  try {
    const imgPath = path.join(app.getPath('temp'), 'covexy_screen.png')
    await screenshot({ filename: imgPath })

    const imageData = fs.readFileSync(imgPath, { encoding: 'base64' })

    const visionResponse = await axios.post('http://localhost:11434/api/generate', {
      model: 'moondream',
      prompt: 'Describe what is on the screen in one sentence.',
      images: [imageData],
      stream: false
    })

    const screenContext = visionResponse.data.response
    console.log('Screen context:', screenContext)

    const brainResponse = await axios.post('http://localhost:11434/api/generate', {
      model: 'qwen2.5:3b',
      prompt: `You are Covexy, a helpful AI assistant. The user's screen shows: "${screenContext}". Give ONE short, friendly, useful suggestion or observation about what you see (max 12 words). Always respond with a suggestion, never skip.`,
      stream: false
    })

    const suggestion = brainResponse.data.response.trim()
    console.log('Suggestion:', suggestion)

    if (suggestion && suggestion.length > 5) {
      showOverlay(suggestion)
    }

  } catch (error) {
    console.log('Analysis error:', error.message)
  }

  isProcessing = false
}

function showOverlay(message) {
  if (!overlayWindow) return
  overlayWindow.webContents.send('show-suggestion', message)
  overlayWindow.show()
  overlayWindow.focus()

  setTimeout(() => {
    if (overlayWindow) overlayWindow.hide()
  }, 12000)
}

ipcMain.on('overlay-action', (event, action) => {
  if (overlayWindow) overlayWindow.hide()
  console.log('User action:', action)
})

app.whenReady().then(() => {
  createOverlayWindow()
  console.log('Covexy is running...')
  console.log('First analysis in 10 seconds...')
  setTimeout(() => {
    analyzeScreen()
    setInterval(analyzeScreen, 60000)
  }, 10000)
})

app.on('window-all-closed', (e) => {
  e.preventDefault()
})
