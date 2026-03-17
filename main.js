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
const { scoreInsight, shouldShowInsight } = require('./intelligence')

// ─── Crash protection ─────────────────────────────────────────────────────────
const logFile = path.join(app.getPath('userData'), 'covexy-error.log')
process.on('uncaughtException', (err) => {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ERROR: ${err.message}\n`)
  } catch {}
})
process.on('unhandledRejection', (reason) => {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] REJECTION: ${reason}\n`)
  } catch {}
})

// ─── Single instance lock ─────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// ─── Constants ────────────────────────────────────────────────────────────────
const MODEL          = 'google/gemini-2.0-flash-001'
const ANALYST_MODEL  = 'deepseek/deepseek-r1'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const ANALYST_INTERVAL  = 2 * 60 * 60 * 1000   // Analyst runs every 2 hours
const OBSERVER_MAXLOG   = 200               // Max activity entries kept in memory
const APP_VERSION    = '3.0.0'
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://covexy.com', 'X-Title': 'Covexy' }

// ─── Dock ─────────────────────────────────────────────────────────────────────
// dock visible intentionally

// ─── Runtime state ────────────────────────────────────────────────────────────
let toastWindow     = null
let mainWindow      = null
let onboardingWindow = null
let tray            = null
let isProcessing    = false
let isPaused        = false
let lastNotifTime   = 0   // ms — enforces 10-min cooldown between overlays
let scanTimer          = null
let analystTimer       = null
let analystRunning     = false
let watchlistTimer     = null
let isWatchlistScanning = false
let whisperAvailable   = false

// ─── In-memory data ────────────────────────────────────────────────────────────
let apiKey          = null
let profile         = null
let memory          = []
let settings        = { scanInterval: 180000, memoryDays: 7 }
let todayActivity      = []
let observerLog        = []
let todayChatHistory = []

// ─── File paths (populated after app.getPath is available) ───────────────────
let DATA_DIR, PROFILE_PATH, MEMORY_PATH, SETTINGS_PATH, KEYS_PATH

function initPaths () {
  DATA_DIR      = app.getPath('userData')
  PROFILE_PATH  = path.join(DATA_DIR, 'covexy-profile.json')
  MEMORY_PATH   = path.join(DATA_DIR, 'covexy-memory.json')
  SETTINGS_PATH = path.join(DATA_DIR, 'covexy-settings.json')
  KEYS_PATH     = path.join(DATA_DIR, 'covexy-keys.json')
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

// ─── Key storage — covexy-keys.json ──────────────────────────────────────────
// All API keys stored in one JSON file. Each entry: { enc: bool, data: string }
// enc=true  → data is base64-encoded safeStorage encrypted buffer
// enc=false → data is plain text (fallback when encryption unavailable)

function saveKeyEntry (name, value) {
  try {
    const keys = safeRead(KEYS_PATH, {})
    if (safeStorage.isEncryptionAvailable()) {
      keys[name] = { enc: true, data: safeStorage.encryptString(value).toString('base64') }
    } else {
      keys[name] = { enc: false, data: value }
    }
    safeWrite(KEYS_PATH, keys)
  } catch (e) { console.error('[Covexy] saveKeyEntry error:', e.message) }
}

function loadKeyEntry (name) {
  try {
    const keys = safeRead(KEYS_PATH, {})
    const entry = keys[name]
    if (!entry) return null
    if (entry.enc) return safeStorage.decryptString(Buffer.from(entry.data, 'base64'))
    return entry.data
  } catch { return null }
}

function saveApiKey (key)    { saveKeyEntry('openRouterKey', key); apiKey = key }
function loadApiKey ()       { return loadKeyEntry('openRouterKey') }
function saveTavilyKey (key) { saveKeyEntry('tavilyKey', key) }
function loadTavilyKey ()    { return loadKeyEntry('tavilyKey') }

// ─── Tavily monthly usage counter (stored as plain fields in covexy-keys.json) ─
function useTavilyCredit () {
  // Returns true and increments counter if under the 1000/month cap.
  // Returns false silently when cap is reached; resets counter on new month.
  try {
    const keys       = safeRead(KEYS_PATH, {})
    const now        = new Date().toISOString().slice(0, 7)   // YYYY-MM
    const isNewMonth = keys.tavilyMonthlyReset !== now
    const count      = isNewMonth ? 0 : (keys.tavilyMonthlyCount || 0)
    if (count >= 1000) {
      console.log('[Covexy] Tavily monthly cap (1000) reached — using fallback')
      return false
    }
    safeWrite(KEYS_PATH, { ...keys, tavilyMonthlyCount: count + 1, tavilyMonthlyReset: now })
    return true
  } catch { return true }
}

function getTavilyMonthlyUsage () {
  try {
    const keys       = safeRead(KEYS_PATH, {})
    const now        = new Date().toISOString().slice(0, 7)
    const isNewMonth = keys.tavilyMonthlyReset !== now
    return { count: isNewMonth ? 0 : (keys.tavilyMonthlyCount || 0), limit: 1000 }
  } catch { return { count: 0, limit: 1000 } }
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
  // Dedup: skip proactive_insight if last 3 entries share category + >3 words in common
  if (entry.type === 'proactive_insight' && entry.content) {
    const last3 = memory.slice(0, 3).filter(m => m.type === 'proactive_insight')
    const newWords = new Set(entry.content.toLowerCase().split(/\W+/).filter(w => w.length > 3))
    const isDupe = last3.some(m => {
      if (m.category !== entry.category) return false
      const oldWords = m.content.toLowerCase().split(/\W+/).filter(w => w.length > 3)
      const common = oldWords.filter(w => newWords.has(w))
      return common.length > 3
    })
    if (isDupe) {
      console.log('[Covexy] 🔁 Dedup: skipping repeat insight (same category + overlapping content)')
      return false
    }
  }
  const item = { id: uid(), timestamp: new Date().toISOString(), ...entry }
  memory.unshift(item)
  if (memory.length > 500) memory = memory.slice(0, 500)
  safeWrite(MEMORY_PATH, { entries: memory })
  push('memory-update', memory.slice(0, 60))
  return true
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

  // Observer: also push to in-memory log for the Analyst to read
  observerLog.push({ timestamp: new Date().toISOString(), description })
  if (observerLog.length > OBSERVER_MAXLOG) observerLog = observerLog.slice(-OBSERVER_MAXLOG)
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
        try { console.log(`[Covexy] 📸 desktopCapturer — ${(buf.length / 1024).toFixed(1)} KB`) } catch {}
        return buf.toString('base64')
      }
    }
  } catch (e) {
    try { console.log('[Covexy] desktopCapturer failed, using fallback:', e.message) } catch {}
  }

  // Fallback: screenshot-desktop → nativeImage → JPEG
  try {
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
    try { console.log(`[Covexy] 📸 fallback capturer — ${(buf.length / 1024).toFixed(1)} KB`) } catch {}
    return buf.toString('base64')
  } catch (e) {
    try { console.log('[Covexy] Fallback capturer error:', e.message) } catch {}
    throw e
  }
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
const PROACTIVE_SYSTEM = `You are Covexy, a silent AI assistant running on the user's Mac. You watch their screen every few minutes and speak up only when you have something genuinely worth their attention.

You are not a chatbot. You do not wait to be asked. You watch, think, and surface insights proactively.

USER CONTEXT (from their profile):
- Name: {{USER_NAME}}
- Role: {{USER_ROLE}}
- Current projects and priorities: {{USER_PROJECTS}}
- Focus apps (stay silent during these): {{FOCUS_APPS}}
- Communication style: {{COMM_STYLE}}

YOUR JOB:
Look at the current screenshot and answer this single question: Is there something this person does not know right now that would genuinely help them in the next 10 minutes?

TO ANSWER THAT QUESTION, THINK THROUGH THESE:
1. What is the user working on or looking at?
2. Does their memory or past context connect to this?
3. Is there a risk, opportunity, or gap visible that they may not have noticed?
4. Is there external information (news, updates, competitor moves, tool changes) that would change what they do next?
5. Is this worth interrupting them for?

WHEN TO STAY SILENT - respond SKIP if:
- The screen shows a focus app: {{FOCUS_APPS}}
- The screen is a blank desktop, screensaver, or lock screen
- The screen shows only a browser homepage or empty tab
- What you would say is something they already know or can obviously see themselves
- What you would say is generic advice with no connection to what is on screen
- You are not at least 80% confident the insight is relevant and useful right now

THE BAR FOR SPEAKING UP:
Only surface an insight if the user would say "I did not know that" or "I was just thinking about that."
If they would say "yeah I know" or "why are you telling me this," stay silent.
Silence is correct behavior. Speaking up is the exception, not the rule.

WHEN YOU HAVE A REAL INSIGHT - respond in this exact format, nothing else:
INSIGHT: [One sentence. What the user should know.]
WHY NOW: [One sentence. Why this is relevant to what is on screen right now.]
ACTION: [One sentence. One concrete thing they could do with this.]
SEARCH: [3 to 5 keywords for a Tavily web search to get more context on this insight.]

RULES:
- Never describe what is on the screen
- Never give generic productivity tips
- Never start with "I can see" or "It looks like"
- Never use em dashes
- Always be direct and specific
- Match the user's communication style: {{COMM_STYLE}}
- If in doubt, respond SKIP`

// ─── Chat system prompt ───────────────────────────────────────────────────────
const CHAT_SYSTEM = `You are Covexy, the user's personal AI assistant. You are not a generic chatbot. You know this person, you have been watching their day, and you are here to help them work better, think clearer, and do more.

WHO YOU ARE TALKING TO:
Name: {{NAME}}
Role: {{ROLE}}
Current projects and priorities: {{PROJECTS}}
How they want to be spoken to: {{TONE}}

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

// ─── Web search (Tavily + DDG fallback) ──────────────────────────────────────
async function webSearch (query) {
  const tavilyKey = loadTavilyKey()

  if (tavilyKey && useTavilyCredit()) {
    try {
      const response = await axios.post(
        'https://api.tavily.com/search',
        {
          api_key: tavilyKey,
          query: query,
          search_depth: 'basic',
          max_results: 3,
          include_answer: true
        },
        { timeout: 8000 }
      )
      if (response.data.answer) {
        return response.data.answer
      }
      const results = response.data.results || []
      return results
        .slice(0, 3)
        .map(r => r.content || r.title)
        .filter(Boolean)
        .join(' | ')
    } catch (e) {
      console.log('[Covexy] Tavily search failed:', e.message)
    }
  }

  // DuckDuckGo fallback if no Tavily key
  try {
    const response = await axios.get(
      'https://api.duckduckgo.com/',
      {
        params: {
          q: query,
          format: 'json',
          no_redirect: 1,
          no_html: 1
        },
        timeout: 5000
      }
    )
    return response.data.AbstractText ||
      response.data.RelatedTopics?.[0]?.Text || ''
  } catch (e) {
    return ''
  }
}

async function webSearchFull (query) {
  const tavilyKey = loadTavilyKey()
  if (tavilyKey && useTavilyCredit()) {
    try {
      const response = await axios.post(
        'https://api.tavily.com/search',
        { api_key: tavilyKey, query, search_depth: 'basic', max_results: 3, include_answer: true },
        { timeout: 8000 }
      )
      const results = response.data.results || []
      const sources = results.slice(0, 3).map(r => ({
        title:       r.title || '',
        url:         r.url   || '',
        description: (r.content || '').slice(0, 120)
      })).filter(s => s.title || s.url)
      const text = response.data.answer ||
        sources.map(s => s.description).filter(Boolean).join(' | ')
      return { text, sources }
    } catch (e) {
      console.log('[Covexy] Tavily search failed:', e.message)
    }
  }
  // DuckDuckGo fallback (no structured sources)
  try {
    const response = await axios.get(
      'https://api.duckduckgo.com/',
      { params: { q: query, format: 'json', no_redirect: 1, no_html: 1 }, timeout: 5000 }
    )
    const text = response.data.AbstractText ||
      response.data.RelatedTopics?.[0]?.Text || ''
    return { text, sources: [] }
  } catch (e) {
    return { text: '', sources: [] }
  }
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

// ─── Audio capture (Whisper) ──────────────────────────────────────────────────
async function captureAudio () {
  if (!whisperAvailable) return null

  return new Promise((resolve) => {
    const audioPath = path.join(app.getPath('userData'), 'temp-audio.wav')
    let recorder, file, recording

    try {
      const recLib = require('node-record-lpcm16')
      file = fs.createWriteStream(audioPath)
      recorder = recLib.record({ sampleRate: 16000, channels: 1, audioType: 'wav' })
      recording = recorder.stream().pipe(file)
    } catch (e) {
      try { console.log('[Covexy] Audio record start error:', e.message) } catch {}
      return resolve(null)
    }

    setTimeout(() => {
      try { recorder.stop(); file.end() } catch { /* ignore */ }

      setTimeout(async () => {
        try {
          const { execSync } = require('child_process')
          execSync(
            `whisper "${audioPath}" --model tiny --output_format txt --output_dir "${app.getPath('userData')}" --language en`,
            { timeout: 30000, encoding: 'utf8' }
          )
          const txtPath = audioPath.replace('.wav', '.txt')
          if (fs.existsSync(txtPath)) {
            const transcript = fs.readFileSync(txtPath, 'utf8').trim()
            try { fs.unlinkSync(txtPath) } catch { /* ignore */ }
            try { fs.unlinkSync(audioPath) } catch { /* ignore */ }
            if (transcript.length > 10) {
              try { console.log('[Covexy] 🎤 Audio:', transcript.slice(0, 80)) } catch {}
              return resolve(transcript)
            }
          }
          resolve(null)
        } catch (e) {
          try { console.log('[Covexy] Whisper error:', e.message) } catch {}
          resolve(null)
        }
      }, 1000)
    }, 30000) // record for 30 seconds
  })
}

// ─── Proactive analysis ───────────────────────────────────────────────────────
async function analyzeScreen () {
  if (isProcessing || isPaused || !apiKey) return
  isProcessing = true

  try {
    const [base64, audioTranscript] = await Promise.all([
      captureScreen(),
      captureAudio()
    ])

    // Save audio to activity log so chat also knows what user was listening to
    if (audioTranscript) {
      addActivity(`[Audio] ${audioTranscript.slice(0, 200)}`, false)
    }

    const activityText = todayActivityText()

    // Proactive web search: fire when activity log mentions time-sensitive topics
    const PROACTIVE_SEARCH_RE = /\b(travel|trip|flight|hotel|weather|news|market|competitor|launch|event|conference|meeting|deadline|paris|morocco|london|tokyo|dubai|berlin|amsterdam|singapore|sydney|toronto|montreal|cairo|lisbon|madrid|barcelona|rome)\b/i
    let liveContextPrefix = ''
    const activityMatch = activityText.match(PROACTIVE_SEARCH_RE)
    if (activityMatch) {
      try {
        const snippet = await webSearch(`${activityMatch[0]} latest news today`)
        if (snippet && snippet.length > 30) {
          liveContextPrefix = `[Live web context: ${snippet.slice(0, 400)}]\n\n`
          console.log('[Covexy] 🌐 Live context added for:', activityMatch[0])
        }
      } catch { /* non-critical */ }
    }

    let systemPrompt = PROACTIVE_SYSTEM
      .replace('{{USER_NAME}}',           profile?.name        || 'the user')
      .replace('{{USER_ROLE}}',           profile?.profession  || 'not specified')
      .replace('{{USER_PROJECTS}}',       profile?.projects    || 'not specified')
      .replace(/\{\{FOCUS_APPS\}\}/g,     profile?.ignore      || 'none specified')
      .replace(/\{\{COMM_STYLE\}\}/g,     profile?.style       || 'direct and concise')

    // Inject audio transcript before job instructions when available
    if (audioTranscript) {
      systemPrompt = systemPrompt.replace(
        'YOUR JOB:',
        `WHAT THE USER IS CURRENTLY HEARING/WATCHING:\n${audioTranscript}\nUse this to understand what content they are consuming and connect it to their life context.\n\nYOUR JOB:`
      )
    }

    // Inject feedback calibration from rated insights
    const ratedInsights = memory
      .filter(m => m.type === 'proactive_insight' && (m.rating === 1 || m.rating === -1))
      .slice(0, 20)
    if (ratedInsights.length > 0) {
      const good = ratedInsights.filter(m => m.rating === 1).map(m => `- ${m.content}`).join('\n')
      const bad  = ratedInsights.filter(m => m.rating === -1).map(m => `- ${m.content}`).join('\n')
      let feedbackBlock = '\n\nFEEDBACK HISTORY:\nThe user rated these past insights:'
      if (good) feedbackBlock += `\nGOOD:\n${good}`
      if (bad)  feedbackBlock += `\nNOT USEFUL:\n${bad}`
      feedbackBlock += '\nUse this to calibrate. Surface more like the good ones. Avoid patterns similar to the not useful ones.'
      systemPrompt += feedbackBlock
    }

    // Log injected profile values for debugging
    console.log('[Covexy] Profile at scan time — name:', profile?.name, '| role:', profile?.profession, '| projects:', profile?.projects?.slice?.(0, 60))
    console.log('[Covexy] Prompt:', systemPrompt)
    console.log('[Covexy] 👁  Sending for analysis...')

    const raw = await aiChat([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: 'text', text: liveContextPrefix + 'Look at this screenshot. Your ONLY job is to log what the user is doing in one short sentence. Do NOT generate an insight. Do NOT give advice. Just describe the activity so it can be logged. If the screen is blank, a screensaver, or a browser homepage respond with SKIP.' }
        ]
      }
    ], 60000)

    console.log('[Covexy] 💬 Response:', raw.slice(0, 150))

    // Observer only logs activity — Analyst generates insights
    if (!raw || /^SKIP/i.test(raw.trim())) {
      console.log('[Covexy] 👁  Observer: blank screen — skipping')
      isProcessing = false
      return
    }

    // Log what the user is doing and return — no insight generation here
    const activityDescription = raw.replace(/^SKIP:?\s*/i, '').trim()
    console.log('[Covexy] 👁  Observer logged:', activityDescription.slice(0, 80))
    addActivity(activityDescription, false)
    isProcessing = false
    return

    // Parse structured response
    const catMatch    = raw.match(/CATEGORY:\s*(.+)/i)
    const insMatch    = raw.match(/INSIGHT:\s*(.+)/i)
    const whyMatch    = raw.match(/WHY NOW:\s*(.+)/i)
    const actMatch    = raw.match(/ACTION:\s*(.+)/i)
    const prepMatch   = raw.match(/PREPARED:\s*(.+)/i)
    const confMatch   = raw.match(/CONFIDENCE:\s*(HIGH|MEDIUM)/i)
    const searchMatch = raw.match(/SEARCH:\s*(.+)/i)

    const category    = (catMatch?.[1]  || 'IDEA').trim().toUpperCase()
    const insight     = insMatch?.[1]?.trim()
    const whyNow      = whyMatch?.[1]?.trim()  || ''
    const action      = actMatch?.[1]?.trim()  || ''
    const prepared    = prepMatch?.[1]?.trim() || ''
    const confidence  = (confMatch?.[1] || 'HIGH').trim().toUpperCase()
    const searchTerms = searchMatch?.[1]?.trim() || ''

    if (!insight || insight.length < 5) {
      console.log('[Covexy] ⏭  Unparseable response — logging')
      addActivity('Screen scanned — unclear AI response', false)
      isProcessing = false
      return
    }

    // Run Tavily search BEFORE saving so sources are persisted with the insight
    let searchResult  = ''
    let searchSources = []
    if (searchTerms) {
      try {
        const found = await webSearchFull(searchTerms)
        if (found.text)    searchResult  = found.text
        if (found.sources) searchSources = found.sources
        console.log('[Covexy] 🔍 Search enrichment attached:', searchTerms)
      } catch { /* non-critical */ }
    }

    // Relevance scoring — only show if score is 8 or above
    const { score, reason } = await scoreInsight({ insight, whyNow, action, category }, profile, aiChat)
    if (!shouldShowInsight(score)) {
      console.log(`[Covexy] 🚫 Insight scored ${score}/10 — below threshold, logging silently`)
      addMemoryEntry({ type: 'proactive_insight', content: insight, category, action, prepared, whyNow, search: searchTerms, sources: searchSources, tags: [category.toLowerCase()], confidence, score, scoreReason: reason })
      isProcessing = false
      return
    }

    const saved = addMemoryEntry({ type: 'proactive_insight', content: insight, category, action, prepared, whyNow, search: searchTerms, sources: searchSources, tags: [category.toLowerCase()], confidence, score, scoreReason: reason })
    if (!saved) {
      console.log('[Covexy] 🔁 Duplicate insight suppressed — skipping notification')
      isProcessing = false
      return
    }
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
    showToast({ category, insight, whyNow, action, searchResult, sources: searchSources })

  } catch (err) {
    console.log('[Covexy] ❌ Scan error:', err.message)
    addActivity(`Scan error: ${err.message}`, false)
  }

  isProcessing = false
}

// ─── Watchlist scanner ────────────────────────────────────────────────────────
const WATCHLIST_SYSTEM = `You are Covexy, a concise AI briefing assistant. The user tracks a topic and you have new search results about it. Write a short structured update.

Respond in EXACTLY this format (no other text):
CATEGORY: [WORK|RESEARCH|IDEA|ALERT|LIFE]
INSIGHT: [One clear sentence describing what is new or notable]
WHY NOW: [One sentence on why this matters right now]
ACTION: [One concrete step the user could take]

Be specific. Use the search data. Be direct. No filler.`

async function scanWatchlistTopic (topic) {
  // Part 4 — 24h dedup: skip if a watchlist insight for this topic exists in the last 24h
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000
  const recentSameDay = memory.filter(m =>
    m.watchlistTopic === topic &&
    new Date(m.timestamp).getTime() > cutoff24h
  )
  if (recentSameDay.length > 0) {
    console.log(`[Covexy] 🔭 Watchlist: recent insight for "${topic}" — skipping`)
    return
  }

  // Fetch latest results
  const { text: searchText, sources } = await webSearchFull(topic)
  if (!searchText || searchText.length < 30) {
    console.log(`[Covexy] 🔭 Watchlist: no useful results for "${topic}"`)
    return
  }

  // Ask AI to format a structured insight from the search results
  const raw = await aiChat([
    { role: 'system', content: WATCHLIST_SYSTEM },
    { role: 'user',   content: `Watchlist topic: "${topic}"\n\nUser context:\n- Name: ${profile?.name || 'the user'}\n- Role: ${profile?.profession || 'professional'}\n- Projects: ${profile?.projects || 'not specified'}\n\nLatest search results:\n${searchText.slice(0, 800)}` }
  ])
  if (!raw || raw.trim().length < 20) return

  // Parse structured response
  const catMatch = raw.match(/CATEGORY:\s*(.+)/i)
  const insMatch = raw.match(/INSIGHT:\s*(.+)/i)
  const whyMatch = raw.match(/WHY NOW:\s*(.+)/i)
  const actMatch = raw.match(/ACTION:\s*(.+)/i)

  const category = (catMatch?.[1] || 'RESEARCH').trim().toUpperCase()
  const insight  = insMatch?.[1]?.trim()
  const whyNow   = whyMatch?.[1]?.trim() || ''
  const action   = actMatch?.[1]?.trim() || ''
  if (!insight || insight.length < 5) return

  // Part 4 — word-overlap dedup against last 20 entries for this topic
  const priorForTopic = memory.filter(m => m.watchlistTopic === topic).slice(0, 20)
  const newWords = new Set(insight.toLowerCase().split(/\W+/).filter(w => w.length > 3))
  const tooSimilar = priorForTopic.some(m => {
    const old = m.content.toLowerCase().split(/\W+/).filter(w => w.length > 3)
    return old.filter(w => newWords.has(w)).length > 3
  })
  if (tooSimilar) {
    console.log(`[Covexy] 🔭 Watchlist: duplicate insight for "${topic}" — skipping`)
    return
  }

  const saved = addMemoryEntry({
    type: 'proactive_insight', content: insight, category,
    action, whyNow, search: topic, sources,
    watchlistTopic: topic,
    tags: [category.toLowerCase(), 'watchlist'], confidence: 'HIGH'
  })

  if (saved) {
    addActivity(`Watchlist [${topic}]: ${insight}`, true)
    push('insights-update', getInsights())
    console.log(`[Covexy] 🔭 Watchlist insight saved: [${topic}] ${insight.slice(0, 60)}`)
  }
}

async function runWatchlistScan () {
  if (isWatchlistScanning) return
  const watchlist = (profile?.watchlist || []).filter(Boolean)
  if (watchlist.length === 0) return
  if (!loadApiKey()) return

  isWatchlistScanning = true
  console.log(`[Covexy] 🔭 Watchlist scan starting — ${watchlist.length} topic(s)`)
  for (const topic of watchlist) {
    try {
      await scanWatchlistTopic(topic)
      await new Promise(r => setTimeout(r, 3000)) // space out API calls
    } catch (e) {
      console.log('[Covexy] Watchlist scan error:', e.message)
    }
  }
  console.log('[Covexy] 🔭 Watchlist scan complete')
  isWatchlistScanning = false
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
    .replace('{{NAME}}',           profile?.name       || 'the user')
    .replace('{{ROLE}}',           profile?.profession || 'not specified')
    .replace('{{PROJECTS}}',       profile?.projects   || 'not specified')
    .replace('{{TONE}}',           profile?.style      || 'direct and concise')
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

// ─── Analyst Engine ───────────────────────────────────────────────────────────
const ANALYST_SYSTEM = `You are the intelligence core of Covexy, a proactive AI assistant running on the user's Mac.

Your job is NOT to describe what is on screen. Your job is to think like a senior analyst who has been watching this person work all day and has access to live external information about their industry.

USER PROFILE:
{{USER_PROFILE}}

WHAT THEY DID TODAY:
{{ACTIVITY_LOG}}

RECENT MEMORY:
{{RECENT_MEMORY}}

INSIGHTS ALREADY SHOWN — DO NOT REPEAT THESE:
{{ALREADY_SHOWN}}

USER FEEDBACK — learn from this:
{{FEEDBACK}}

FRESH EXTERNAL SIGNALS:
{{EXTERNAL_CONTEXT}}

YOUR TASK:
Find ONE insight that combines at least two of these:
- A pattern in their activity today that they have not noticed
- A connection between two different things they worked on
- External information they have not seen that is relevant to their specific projects
- A strategic opportunity or risk relevant to their business right now
- Something they started but did not finish that needs attention

THE BAR IS HIGH:
- The insight must be specific to THIS person and THEIR projects
- It must be something they do not already know
- It must not repeat anything in the ALREADY SHOWN list above
- Generic AI news scores 1 automatically
- If nothing passes this bar respond SKIP

SOMETIMES instead of just an insight you can prepare something for them:
- If they have been working on a content piece, draft the next section
- If they keep researching the same topic, prepare a short briefing
- If there is an action they should take, prepare the first step for them

When you prepare something proactively add this line:
PREPARED: [The draft, briefing, or first step you prepared for them. Keep it under 100 words.]

WHEN YOU HAVE A REAL INSIGHT respond in this exact format:
CATEGORY: [WORK|RESEARCH|OPPORTUNITY|ALERT|PATTERN]
INSIGHT: [One sentence. Conversational. Specific to them.]
WHY NOW: [One sentence. Why this matters today.]
ACTION: [One sentence. The single most useful next step.]
PREPARED: [Optional. Only include if you actually prepared something.]
SEARCH: [3 to 5 keywords to verify this insight.]`

async function runAnalyst () {
  if (analystRunning || !apiKey || !profile) return
  analystRunning = true
  console.log('[Covexy] 🧠 Analyst running...')

  try {
    // STRUCTURED CONTEXT PACKAGE — better input = better output

    // 1. Who this person is
    const userProfile = [
      profile.name        ? `Name: ${profile.name}`                  : null,
      profile.profession  ? `Role: ${profile.profession}`            : null,
      profile.projects    ? `Projects: ${profile.projects}`          : null,
      profile.style       ? `Communication style: ${profile.style}`  : null,
    ].filter(Boolean).join('\n')

    // 2. What they did today
    const activitySummary = observerLog.length
      ? observerLog.slice(-50).map(e => `[${new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}] ${e.description}`).join('\n')
      : 'No activity recorded yet.'

    // 3. What insights have already been shown — do not repeat these
    const alreadyShown = memory
      .filter(m => m.type === 'proactive_insight' && m.content)
      .slice(0, 10)
      .map(m => `- ${m.content.slice(0, 80)}`)
      .join('\n') || 'None yet.'

    // 4. What the user found useful vs not useful
    const positiveFeedback = memory
      .filter(m => m.type === 'proactive_insight' && m.rating === 1)
      .slice(0, 5)
      .map(m => `GOOD: ${m.content.slice(0, 80)}`)
      .join('\n') || 'No positive feedback yet.'

    const negativeFeedback = memory
      .filter(m => m.type === 'proactive_insight' && m.rating === -1)
      .slice(0, 5)
      .map(m => `BAD: ${m.content.slice(0, 80)}`)
      .join('\n') || 'No negative feedback yet.'

    // 5. Fresh external signals — 3 specific searches not one generic one
    let externalContext = 'No external context available.'
    try {
      const specificQueries = [
        'mention.ma GEO generative engine optimization latest',
        'InferenceWatch AI model pricing benchmark 2026',
        'proactive AI ambient intelligence desktop 2026'
      ]
      const randomQuery = specificQueries[Math.floor(Math.random() * specificQueries.length)]
      const result = await webSearch(randomQuery)
      if (result && result.length > 30) {
        externalContext = result.slice(0, 600)
        console.log('[Covexy] 🧠 Analyst context search:', randomQuery)
      }
    } catch { /* non-critical */ }

    const systemPrompt = ANALYST_SYSTEM
      .replace('{{USER_PROFILE}}',    userProfile)
      .replace('{{ACTIVITY_LOG}}',    activitySummary)
      .replace('{{RECENT_MEMORY}}',   getRecentMemory(15))
      .replace('{{ALREADY_SHOWN}}',   alreadyShown)
      .replace('{{FEEDBACK}}',        positiveFeedback + '\n' + negativeFeedback)
      .replace('{{EXTERNAL_CONTEXT}}', externalContext)

    const raw = await axios.post(OPENROUTER_URL, {
      model: ANALYST_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: 'Analyze everything and surface the single most valuable insight right now. If nothing is worthy, respond SKIP.' }
      ]
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...OPENROUTER_HEADERS },
      timeout: 60000
    }).then(r => r.data.choices?.[0]?.message?.content?.trim() || '')

    console.log('[Covexy] 🧠 Analyst response:', raw.slice(0, 150))

    if (!raw || /^SKIP/i.test(raw.trim())) {
      console.log('[Covexy] 🧠 Analyst: nothing worthy — staying silent')
      analystRunning = false
      return
    }

    // Parse response
    const catMatch  = raw.match(/CATEGORY:\s*(.+)/i)
    const insMatch  = raw.match(/INSIGHT:\s*(.+)/i)
    const whyMatch  = raw.match(/WHY NOW:\s*(.+)/i)
    const actMatch  = raw.match(/ACTION:\s*(.+)/i)
    const prepMatch = raw.match(/PREPARED:\s*([\s\S]+?)(?=SEARCH:|$)/i)
    const srcMatch  = raw.match(/SEARCH:\s*(.+)/i)

    const category    = (catMatch?.[1] || 'RESEARCH').trim().toUpperCase()
    const insight     = insMatch?.[1]?.trim()
    const whyNow      = whyMatch?.[1]?.trim() || ''
    const action      = actMatch?.[1]?.trim() || ''
    const prepared    = prepMatch?.[1]?.trim() || ''
    const searchTerms = srcMatch?.[1]?.trim() || ''

    if (!insight || insight.length < 10) {
      console.log('[Covexy] 🧠 Analyst: unparseable response')
      analystRunning = false
      return
    }

    // Score the insight before doing anything with it
    const { score, reason } = await scoreInsight({ insight, whyNow, action, category }, profile, aiChat)
    console.log(`[Covexy] 🎯 Analyst insight scored ${score}/10 — ${reason}`)

    if (!shouldShowInsight(score)) {
      console.log(`[Covexy] 🚫 Analyst insight below threshold — logging silently`)
      addMemoryEntry({ type: 'proactive_insight', content: insight, category, action, whyNow, score, scoreReason: reason, source: 'analyst', tags: [category.toLowerCase()] })
      analystRunning = false
      return
    }

    // Run search enrichment + verification
    let searchResult  = ''
    let searchSources = []
    if (searchTerms) {
      try {
        // First search: enrich with context
        const found = await webSearchFull(searchTerms)
        if (found.text)    searchResult  = found.text
        if (found.sources) searchSources = found.sources
        console.log('[Covexy] 🔍 Analyst enrichment search done:', searchTerms)

        // Second search: verify the specific claim before showing it
        if (searchResult && searchResult.length > 30) {
          const verifyQuery = `${insight.slice(0, 80)} verify 2026`
          const verification = await webSearchFull(verifyQuery)
          console.log('[Covexy] 🔍 Analyst verification search done:', verifyQuery)

          if (!verification.text || verification.text.length < 30) {
            console.log('[Covexy] ⚠️ Insight could not be verified — adding disclaimer')
            searchResult = searchResult + ' [Note: limited verification available for this claim — please confirm before acting.]'
          } else {
            // Merge verification context into search result
            searchResult = searchResult + ' | Verified: ' + verification.text.slice(0, 200)
            if (verification.sources && verification.sources.length > 0) {
              searchSources = [...searchSources, ...verification.sources].slice(0, 4)
            }
            console.log('[Covexy] ✅ Insight verified successfully')
          }
        }
      } catch { /* non-critical */ }
    }

    // Save and notify
    const saved = addMemoryEntry({ type: 'proactive_insight', content: insight, category, action, whyNow, prepared, search: searchTerms, sources: searchSources, score, scoreReason: reason, source: 'analyst', tags: [category.toLowerCase()], confidence: 'HIGH' })

    if (saved) {
      addActivity(`[Analyst] ${category}: ${insight}`, true)
      push('insights-update', getInsights())

      if (Date.now() - lastNotifTime >= 2 * 60 * 60 * 1000) {
        lastNotifTime = Date.now()
        showToast({ category, insight, whyNow, action, searchResult, sources: searchSources })
        console.log(`[Covexy] 🧠 Analyst insight delivered: ${insight.slice(0, 80)}`)
      } else {
        console.log('[Covexy] 🧠 Analyst insight saved — cooldown active, no toast')
      }
    }

  } catch (e) {
    console.log('[Covexy] 🧠 Analyst error:', e.message)
  }

  analystRunning = false
}

// ─── Scanner lifecycle ────────────────────────────────────────────────────────
function startScanner () {
  if (!loadApiKey()) {
    console.log('[Covexy] Scanner waiting — paste API key in Settings')
    return
  }
  if (scanTimer) clearInterval(scanTimer)
  console.log(`[Covexy] 🔁 Observer started — every ${settings.scanInterval / 1000}s`)
  setTimeout(() => {
    if (loadApiKey()) {
      analyzeScreen()
      scanTimer = setInterval(analyzeScreen, settings.scanInterval)
    } else {
      console.log('[Covexy] Scanner waiting — paste API key in Settings')
    }
  }, 15000)

  // Analyst engine — runs every 30 minutes
  if (!analystTimer) {
    analystTimer = setInterval(runAnalyst, ANALYST_INTERVAL)
    setTimeout(runAnalyst, 10 * 60 * 1000) // first run 10 minutes after startup
    console.log('[Covexy] 🧠 Analyst armed — runs every 30 minutes')
  }

  // Watchlist scanner disabled — too noisy, removed from v1
  console.log('[Covexy] 🔭 Watchlist scanner disabled in this version')
}

function restartScanner () {
  if (!loadApiKey()) {
    console.log('[Covexy] Scanner waiting — no API key')
    return
  }
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
  if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null }
  const trayIconPath = path.join(__dirname, 'assets', 'covexy-icon-tr.png')
  let trayImage
  if (fs.existsSync(trayIconPath)) {
    trayImage = nativeImage.createFromPath(trayIconPath).resize({ width: 18, height: 18 })
  } else {
    trayImage = nativeImage.createEmpty()
  }
  // Do NOT call setTemplateImage — preserve original icon colors
  tray = new Tray(trayImage)
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

// ─── Toast window ─────────────────────────────────────────────────────────────
function createToastWindow () {
  const { screen } = require('electron')
  const { width } = screen.getPrimaryDisplay().workAreaSize

  toastWindow = new BrowserWindow({
    width: 300,
    height: 140,
    x: width - 316,
    y: 16,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  toastWindow.loadFile(path.join(__dirname, 'toast.html'))
  toastWindow.setAlwaysOnTop(true, 'floating')
  toastWindow.setVisibleOnAllWorkspaces(true)
  toastWindow.hide()
}

function showToast ({ category, insight, whyNow, action, searchResult }) {
  if (!toastWindow || toastWindow.isDestroyed()) createToastWindow()
  const { screen } = require('electron')
  const { width } = screen.getPrimaryDisplay().workAreaSize
  toastWindow.setPosition(width - 316, 16)
  toastWindow.webContents.send('show-toast', { category, insight, whyNow, action, searchResult })
  toastWindow.showInactive()   // never steals focus from the user's active app
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
    vibrancy: 'hud',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    transparent: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    hasShadow: true,
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
ipcMain.on('toast-dismiss', () => {
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.hide()
})

ipcMain.on('toast-feedback', (_, data) => {
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.hide()
  if (data.type === 'helpful') {
    addMemoryEntry({ type: 'feedback_positive', content: `Helpful: ${data.insight}`, category: 'FEEDBACK', tags: ['feedback', 'positive'] })
    console.log('[Covexy] 👍 Positive feedback saved')
  } else {
    addMemoryEntry({ type: 'feedback_negative', content: `Not useful — avoid repeating: ${data.insight}`, category: 'FEEDBACK', tags: ['feedback', 'negative'] })
    console.log('[Covexy] 👎 Negative feedback saved')
  }
})

ipcMain.on('toast-open-chat', (_, data) => {
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.hide()
  showMainWindow()
  setTimeout(() => push('show-chat-context', data.insight), 350)
})

ipcMain.on('close-main-window',    () => mainWindow?.hide())
ipcMain.on('open-external', (_, url) => { require('electron').shell.openExternal(url) })
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

ipcMain.handle('rate-insight', (_, timestamp, rating) => {
  const entry = memory.find(m => m.timestamp === timestamp && m.type === 'proactive_insight')
  if (!entry) return { ok: false }
  entry.rating = rating || 0
  safeWrite(MEMORY_PATH, memory)
  return { ok: true }
})

ipcMain.handle('save-timezone', (_, tz) => {
  if (!tz || !profile) return false
  profile.timezone = tz
  safeWrite(PROFILE_PATH, profile)
  return true
})

ipcMain.handle('save-watchlist', (_, topics) => {
  if (!profile) return false
  profile.watchlist = Array.isArray(topics) ? topics.filter(Boolean) : []
  safeWrite(PROFILE_PATH, profile)
  push('profile-update', profile)
  // Trigger a fresh watchlist scan soon so new topics show up quickly
  setTimeout(runWatchlistScan, 5000)
  return true
})

ipcMain.handle('get-tavily-usage', () => getTavilyMonthlyUsage())
ipcMain.handle('get-chat-history',  () => todayChatHistory)
ipcMain.handle('get-settings',        () => settings)
ipcMain.handle('get-profile',         () => profile)
ipcMain.handle('get-version',         () => APP_VERSION)
ipcMain.handle('get-api-key-status',  () => ({ hasKey: !!apiKey }))

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
    const testKey = key || loadApiKey()
    if (!testKey) return { ok: false, error: 'No API key saved' }
    const ok = await testApiKey(testKey)
    return { ok }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('save-openrouter-key', (_, key) => {
  saveApiKey(key)
  if (!scanTimer) startScanner()
  return true
})

ipcMain.handle('clear-memory', () => {
  memory = []; safeWrite(MEMORY_PATH, { entries: [] })
  push('memory-update', [])
  return true
})

ipcMain.on('open-profile-editor', () => createOnboardingWindow(true))

// Tavily Search
ipcMain.handle('get-tavily-key-status', () => {
  const key = loadTavilyKey()
  return { hasKey: !!key }
})

ipcMain.handle('save-tavily-key', (_, key) => {
  saveTavilyKey(key)
  return true
})

ipcMain.handle('test-tavily-key', async (_, key) => {
  try {
    const testKey = key || loadTavilyKey()
    if (!testKey) return { ok: false, error: 'No Tavily key saved' }
    const response = await axios.post(
      'https://api.tavily.com/search',
      {
        api_key: testKey,
        query: 'test',
        search_depth: 'basic',
        max_results: 1,
        include_answer: true
      },
      { timeout: 8000 }
    )
    if (response.status === 200) return { ok: true }
    return { ok: false, error: 'Unexpected response' }
  } catch (e) {
    return { ok: false, error: e.response?.data?.message || e.message }
  }
})

// Whisper status
ipcMain.handle('get-whisper-status', () => ({ available: whisperAvailable }))

// ─── Boot ─────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  console.log('[Covexy] userData path:', app.getPath('userData'))
  initPaths()
  loadSettings()
  apiKey = loadApiKey()
  console.log('[Covexy] API key loaded: ' + (apiKey ? 'YES' : 'NO'))
  loadProfile()
  loadMemory()
  loadTodayActivity()
  loadTodayChat()

  // Whisper availability check
  try {
    const { execSync } = require('child_process')
    execSync('whisper --help', { timeout: 3000 })
    whisperAvailable = true
    console.log('[Covexy] Whisper: available')
  } catch (e) {
    console.log('[Covexy] Whisper: not found, audio disabled')
  }

  // node-record-lpcm16 availability check
  if (whisperAvailable) {
    try {
      require('node-record-lpcm16')
    } catch (e) {
      whisperAvailable = false
      console.log('[Covexy] Audio disabled — run: npm install')
    }
  }

  if (process.platform === 'darwin' && app.dock) {
    const dockIconPath = path.join(__dirname, 'assets', 'covexy-dock.png')
    if (fs.existsSync(dockIconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(dockIconPath))
    } else {
      console.log('[Covexy] Dock icon not found at:', dockIconPath)
    }
  }

  createToastWindow()
  createTray()

  // Midnight pruner
  const msToMidnight = () => { const n = new Date(); const m = new Date(n); m.setHours(24,0,5,0); return m - n }
  const schedulePrune = () => setTimeout(() => { pruneMemory(); schedulePrune() }, msToMidnight())
  schedulePrune()

  if (!profile) {
    // No profile — first ever launch, run full onboarding
    console.log('[Covexy] No profile found — showing onboarding')
    createOnboardingWindow()
  } else if (!apiKey) {
    // Profile exists but no API key — show main window and open Settings
    console.log('[Covexy] Profile found, no API key — opening Settings')
    showMainWindow()
    setTimeout(() => push('switch-tab', 'settings'), 500)
  } else {
    // Profile + API key — full ready state
    console.log('[Covexy] ✅ Ready — showing main window, starting scanner')
    showMainWindow()
    startScanner()
    setTimeout(() => enrichProfileContext(), 6000) // enrich after UI settles
  }
})

app.on('window-all-closed', e => e.preventDefault())
