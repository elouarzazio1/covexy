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
// dock visible intentionally

// ─── Runtime state ────────────────────────────────────────────────────────────
let toastWindow     = null
let mainWindow      = null
let onboardingWindow = null
let tray            = null
let isProcessing    = false
let isPaused        = false
let lastNotifTime   = 0   // ms — enforces 10-min cooldown between overlays
let scanTimer       = null
let whisperAvailable = false

// ─── In-memory data ────────────────────────────────────────────────────────────
let apiKey          = null
let profile         = null
let memory          = []
let settings        = { scanInterval: 180000, memoryDays: 7 }
let todayActivity   = []
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
const PROACTIVE_SYSTEM = `RULE ZERO: If your insight describes, references, or is triggered by something the user is actively looking at on their screen right now — respond SKIP. No exceptions.

RULE ONE: Never fire more than one notification about the same topic within 90 minutes. Check {{MEMORY}} — if the last 3 entries contain the same subject, respond SKIP regardless of how important it seems.

You are Covexy. You are a silent AI that lives with the user.
You are not an assistant they talk to. You are a presence
that thinks on their behalf — continuously, quietly, and
always with their life in mind.

You know this person:
Name: {{NAME}}
What they do: {{ROLE}}
What matters to them right now: {{PROJECTS}}
What you have learned about their life: {{MEMORY}}
What you have seen them do today: {{TODAY_ACTIVITY}}
What they never want interrupted: {{IGNORE_LIST}}
How they want to be spoken to: {{TONE}}

WHO YOU ARE:
You are the most attentive presence in this person's life.
You remember everything. You notice patterns they miss.
You think ahead so they don't have to.
You are not here to describe their screen.
You are not here to state the obvious.
You are not here to interrupt them with noise.
You are not here to mention tools, apps, or software
they are using — they can see their own screen.
You are here for the moment when something genuinely
matters to their life — and they would not have
caught it themselves.

HOW YOU THINK — ALWAYS IN THREE DIMENSIONS:

THE PAST — what do you know about this person's life?
- What have they been working on consistently?
- What patterns have you noticed across days and weeks?
- What did they start and not finish?
- What do they care about deeply based on everything observed?
- What relationships, plans, trips, and commitments
  have appeared in their life?

THE PRESENT — what is happening right now?
- What context does this moment have that they may
  not be fully aware of?
- Is there something in the world right now — news,
  weather, events, market movements — that directly
  affects what they are doing or planning?
- Is there a connection between what they are doing
  now and something from their past they have not made?

THE FUTURE — what is coming that they should know about?
- What is approaching — trips, deadlines, events,
  commitments — that they should be thinking about now?
- If they continue on their current path, what is the
  likely outcome — and is it the one they want?
- What could you prepare for them now that they
  will need later?

WHAT MAKES A PERFECT INSIGHT:
A perfect insight is one the person could not have
produced themselves in that moment. It is specific
to their life — not generic advice anyone could Google.
It is timely. It is actionable. It sometimes comes
with something already prepared — a draft, a summary,
an idea — so they get a gift, not just a notification.

Real examples of what Covexy should sound like:
For someone traveling next week:
"Paris has a transit strike Tuesday to Thursday —
consider arriving Monday or adjusting your schedule."
For someone who blogs daily and has not written today:
"You have posted every day this week. Today has no
post yet — a draft is waiting in chat based on
what you read this afternoon."
For someone planning a dinner on WhatsApp:
"You are hosting friends Saturday. Here are three
recipes and two topics they would enjoy."
For a shop owner:
"Rain all weekend in your area — foot traffic will
be low. Good moment for an online promotion."

WHEN TO USE WEB SEARCH:
Before generating any insight involving travel,
weather, local events, news, market movements,
a person or company the user mentioned, or anything
time-sensitive — search the web first.
Ground every insight in real facts, not assumptions.

WHEN TO STAY SILENT:
- You would be describing what they can already see
- You have nothing that passes the quality gate
- You surfaced something similar in the last 60 minutes
- They are clearly in deep focus, watching something,
  or in a meeting
- You are not confident the insight is accurate
- The insight is about any tool, app, or software
  usage — this is never worth an insight
Silence is not failure. Silence is respect.
The value of Covexy is not volume of notifications.
It is the quality of the rare moments when it speaks.

QUALITY GATE — all five must be yes before speaking:
1. Is this specific to this person's life — not
   something anyone could Google?
2. Would they genuinely not have thought of this
   themselves right now?
3. Is the timing right — is this the moment for
   this insight?
4. Is it grounded in real facts — searched or
   observed — not assumptions?
5. Does it give them something they can use now?

If all five yes — speak.
If any one is no — SKIP.

OUTPUT FORMAT — use exactly this or respond SKIP:
CATEGORY: [LIFE / WORK / TRAVEL / HEALTH / SOCIAL / CREATIVE / FINANCE / ALERT / IDEA]
INSIGHT: [one sentence, max 25 words, direct, warm, specific to their life, never mention apps or tools]
ACTION: [one concrete next step, max 10 words]
PREPARED: [optional: "Draft waiting in chat" or "Recipe saved" or leave blank]
CONFIDENCE: HIGH`

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

  if (tavilyKey) {
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
    let recorder, file

    try {
      const recLib = require('node-record-lpcm16')
      file = fs.createWriteStream(audioPath)
      recorder = recLib.record({ sampleRate: 16000, channels: 1, audioType: 'wav' })
      recording = recorder.stream().pipe(file)
    } catch (e) {
      console.log('[Covexy] Audio record start error:', e.message)
      return resolve(null)
    }

    setTimeout(() => {
      try { recorder.stop(); file.end() } catch { /* ignore */ }

      setTimeout(async () => {
        try {
          const { execSync } = require('child_process')
          execSync(
            `whisper "${audioPath}" --model tiny --output_format txt --output_dir "${app.getPath('userData')}" --language auto`,
            { timeout: 30000, encoding: 'utf8' }
          )
          const txtPath = audioPath.replace('.wav', '.txt')
          if (fs.existsSync(txtPath)) {
            const transcript = fs.readFileSync(txtPath, 'utf8').trim()
            try { fs.unlinkSync(txtPath) } catch { /* ignore */ }
            try { fs.unlinkSync(audioPath) } catch { /* ignore */ }
            if (transcript.length > 10) {
              console.log('[Covexy] 🎤 Audio:', transcript.slice(0, 80))
              return resolve(transcript)
            }
          }
          resolve(null)
        } catch (e) {
          console.log('[Covexy] Whisper error:', e.message)
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
      .replace('{{NAME}}',           profile?.name        || 'the user')
      .replace('{{ROLE}}',           profile?.profession  || 'not specified')
      .replace('{{PROJECTS}}',       profile?.projects    || 'not specified')
      .replace('{{IGNORE_LIST}}',    profile?.ignore      || 'nothing specified')
      .replace('{{TONE}}',           profile?.style       || 'direct and concise')
      .replace('{{MEMORY}}',         getRecentMemory(10))
      .replace('{{TODAY_ACTIVITY}}', activityText)

    // Inject audio transcript before output format when available
    if (audioTranscript) {
      systemPrompt = systemPrompt.replace(
        'OUTPUT FORMAT',
        `WHAT THE USER IS CURRENTLY HEARING/WATCHING:\n${audioTranscript}\nUse this to understand what content they are consuming and connect it to their life context.\n\nOUTPUT FORMAT`
      )
    }

    console.log('[Covexy] 👁  Sending for analysis...')

    const raw = await aiChat([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: 'text', text: liveContextPrefix + 'Analyze this screenshot according to your instructions.' }
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
    const prepMatch   = raw.match(/PREPARED:\s*(.+)/i)
    const confMatch   = raw.match(/CONFIDENCE:\s*(HIGH|MEDIUM)/i)

    const category   = (catMatch?.[1] || 'IDEA').trim().toUpperCase()
    const insight    = insMatch?.[1]?.trim()
    const action     = actMatch?.[1]?.trim() || ''
    const prepared   = prepMatch?.[1]?.trim() || ''
    const confidence = (confMatch?.[1] || 'HIGH').trim().toUpperCase()

    if (!insight || insight.length < 5) {
      console.log('[Covexy] ⏭  Unparseable response — logging')
      addActivity('Screen scanned — unclear AI response', false)
      isProcessing = false
      return
    }

    // Always log to memory and activity regardless of confidence
    // Returns false if dedup check fires — skip notification in that case
    const saved = addMemoryEntry({ type: 'proactive_insight', content: insight, category, action, prepared, tags: [category.toLowerCase()], confidence })
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
    showToast({ category, insight, action })

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

function showToast ({ category, insight, action }) {
  if (!toastWindow || toastWindow.isDestroyed()) createToastWindow()
  const { screen } = require('electron')
  const { width } = screen.getPrimaryDisplay().workAreaSize
  toastWindow.setPosition(width - 316, 16)
  toastWindow.webContents.send('show-toast', { category, insight, action })
  toastWindow.show()
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
    const response = await axios.post(
      'https://api.tavily.com/search',
      {
        api_key: key,
        query: 'test',
        search_depth: 'basic',
        max_results: 1,
        include_answer: true
      },
      { timeout: 8000 }
    )
    if (response.status === 200) {
      saveTavilyKey(key)
      return { ok: true }
    }
    return { ok: false, error: 'Unexpected response' }
  } catch (e) {
    return { ok: false, error: e.response?.data?.message || e.message }
  }
})

// Whisper status
ipcMain.handle('get-whisper-status', () => ({ available: whisperAvailable }))

// ─── Boot ─────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
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
    execSync('whisper --version', { timeout: 3000 })
    whisperAvailable = true
    console.log('[Covexy] Whisper: available')
  } catch (e) {
    console.log('[Covexy] Whisper: not found, audio disabled')
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
