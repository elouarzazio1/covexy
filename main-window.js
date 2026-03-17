// ── State ─────────────────────────────────────────────────────────────────────
let insights        = []
let memoryData      = []
let currentTab      = 'insights'
let msgCounter      = 0
let isChatLoading   = false
let currentSettings = {}
const expandedCards = new Set()

// ── Category config ───────────────────────────────────────────────────────────
const CAT = {
  // New categories
  life:     { icon: '◎', cls: 'life'     },
  work:     { icon: '◈', cls: 'work'     },
  travel:   { icon: '✈', cls: 'travel'   },
  health:   { icon: '♡', cls: 'health'   },
  social:   { icon: '◇', cls: 'social'   },
  creative: { icon: '✦', cls: 'creative' },
  finance:  { icon: '◐', cls: 'finance'  },
  alert:    { icon: '⚠', cls: 'alert'    },
  idea:     { icon: '◈', cls: 'idea'     },
  // Legacy categories
  email:    { icon: '✉', cls: 'email'    },
  task:     { icon: '✓', cls: 'task'     },
  research: { icon: '⊞', cls: 'research' },
  focus:    { icon: '◉', cls: 'focus'    },
  writing:  { icon: '✍', cls: 'writing'  },
}

function catFor (item) {
  const raw = (item.category || item.tags?.[0] || '').toLowerCase().trim()
  return CAT[raw] || CAT.focus
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isToday (iso) {
  return new Date(iso).toDateString() === new Date().toDateString()
}

function fmtTime (iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function fmtDay (dateStr) {
  const d = new Date(dateStr)
  if (d.toDateString() === new Date().toDateString()) return 'Today'
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}

function esc (str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab (tab) {
  currentTab = tab
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
  document.getElementById(`panel-${tab}`).classList.add('active')
  document.getElementById(`nav-${tab}`).classList.add('active')
  if (tab === 'insights') renderInsights()
  if (tab === 'memory')   renderMemory()
}

// ── Render insights ───────────────────────────────────────────────────────────
function openSource (el) {
  const url = el.getAttribute('data-href')
  if (url) window.electronAPI.openExternal(url)
}

function rateInsight (cardId, rating, event) {
  event.stopPropagation()
  const today = insights.filter(h => isToday(h.timestamp))
  const item  = today.find(h => 'c' + String(h.timestamp).replace(/[^a-zA-Z0-9]/g, '') === cardId)
  if (!item) return
  item.rating = (item.rating === rating) ? 0 : rating   // toggle off if same button clicked
  renderInsights()
  window.electronAPI.rateInsight(item.timestamp, item.rating) // persist in background
}

function toggleCard (id) {
  const card = document.querySelector(`.insight-card[data-card-id="${id}"]`)
  if (!card) return
  if (expandedCards.has(id)) {
    expandedCards.delete(id)
    card.classList.remove('expanded')
  } else {
    expandedCards.add(id)
    card.classList.add('expanded')
  }
}

function renderInsights () {
  const today = insights.filter(h => isToday(h.timestamp))
  const list  = document.getElementById('insights-list')
  const sub   = document.getElementById('insights-sub')
  const badge = document.getElementById('insights-badge')

  if (today.length === 0) {
    sub.textContent = 'Nothing flagged yet today'
    badge.style.display = 'none'
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">✦</div>
        <div class="empty-title">Your feed is empty for now</div>
        <div class="empty-body">Covexy is watching your screen and will surface something when it matters.</div>
      </div>`
    return
  }

  sub.textContent = `${today.length} insight${today.length !== 1 ? 's' : ''} today`
  badge.textContent = today.length
  badge.style.display = 'flex'

  list.innerHTML = today.map(item => {
    const cardId = 'c' + String(item.timestamp).replace(/[^a-zA-Z0-9]/g, '')
    const c      = catFor(item)

    const actionHtml = item.action
      ? `<div class="insight-action-line">→ ${esc(item.action)}</div>`
      : ''

    const whyNowHtml = item.whyNow
      ? `<div class="insight-why-now">${esc(item.whyNow)}</div>`
      : ''

    let sourcesHtml = ''
    if (item.sources && item.sources.length > 0) {
      const sourceItems = item.sources.map(s => `
        <div class="insight-source-item">
          <a class="insight-source-link" data-href="${esc(s.url || '')}" onclick="openSource(this);return false;" href="#">${esc(s.title || s.url || 'Source')}</a>
          ${s.description ? `<div class="insight-source-desc">${esc(s.description)}</div>` : ''}
        </div>`).join('')
      sourcesHtml = `<div class="insight-sources-title">Sources</div><div class="insight-sources-list">${sourceItems}</div>`
    } else {
      sourcesHtml = `<div class="insight-no-sources">No sources found</div>`
    }

    const upClass   = item.rating === 1  ? 'active' : (item.rating === -1 ? 'faded' : '')
    const downClass = item.rating === -1 ? 'active' : (item.rating === 1  ? 'faded' : '')

    const watchlistLabelHtml = item.watchlistTopic
      ? `<div style="font-size:10px;color:#777777;font-weight:500;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">${esc(item.watchlistTopic)}</div>`
      : ''

    return `
      <div class="insight-card" data-card-id="${cardId}" onclick="toggleCard('${cardId}')">
        <div class="insight-card-header">
          <div class="insight-icon ${c.cls}">${c.icon}</div>
          <div style="flex:1;min-width:0;">
            ${watchlistLabelHtml}
            <div class="insight-text">${esc(item.content)}</div>
            ${actionHtml}
            <div class="insight-time">${fmtTime(item.timestamp)}</div>
          </div>
          <div class="insight-chevron">▾</div>
        </div>
        <div class="insight-feedback" onclick="event.stopPropagation()">
          <button class="fb-btn ${upClass}"   onclick="rateInsight('${cardId}',  1, event)" title="Useful">↑</button>
          <button class="fb-btn ${downClass}" onclick="rateInsight('${cardId}', -1, event)" title="Not useful">↓</button>
        </div>
        <div class="insight-expanded-body">
          ${whyNowHtml}
          <hr class="insight-divider">
          ${sourcesHtml}
          <button class="insight-show-less" onclick="event.stopPropagation();toggleCard('${cardId}')">Show less ▴</button>
        </div>
      </div>`
  }).join('')

  // Restore expanded state after re-render
  expandedCards.forEach(id => {
    const card = document.querySelector(`.insight-card[data-card-id="${id}"]`)
    if (card) card.classList.add('expanded')
  })
}

// ── Render memory ─────────────────────────────────────────────────────────────
function renderMemory () {
  const list = document.getElementById('memory-list')
  const sub  = document.getElementById('memory-sub')

  if (memoryData.length === 0) {
    sub.textContent = 'No memories yet'
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">◇</div>
        <div class="empty-title">No memories yet</div>
        <div class="empty-body">Insights and learnings from the past 7 days will appear here, grouped by day.</div>
      </div>`
    return
  }

  sub.textContent = `${memoryData.length} entr${memoryData.length !== 1 ? 'ies' : 'y'}`

  const groups = {}
  memoryData.forEach(item => {
    const key = new Date(item.timestamp).toDateString()
    if (!groups[key]) groups[key] = []
    groups[key].push(item)
  })

  list.innerHTML = Object.entries(groups).map(([key, items]) => `
    <div class="day-group">
      <div class="day-label">${fmtDay(key)}</div>
      ${items.map(item => `
        <div class="memory-item">
          <div class="mem-dot"></div>
          <div class="mem-text">${esc(item.content)}</div>
        </div>`).join('')}
    </div>`).join('')
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function autoResize (el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

function handleChatKey (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendChat()
  } else {
    autoResize(e.target)
  }
}

function addMsg (role, content, isTyping = false) {
  const id       = `msg-${++msgCounter}`
  const messages = document.getElementById('chat-messages')
  const div      = document.createElement('div')
  div.className  = `msg ${role}`
  div.id         = id

  const avatar = role === 'assistant' ? 'C' : 'U'
  const bubble = isTyping
    ? `<div class="typing-dots"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`
    : esc(content)

  div.innerHTML = `
    <div class="msg-avatar">${avatar}</div>
    <div class="msg-bubble">${bubble}</div>`

  messages.appendChild(div)
  messages.scrollTop = messages.scrollHeight
  return id
}

function removeMsg (id) {
  document.getElementById(id)?.remove()
}

function loadChatHistory (history) {
  if (!history || history.length === 0) return
  // Clear welcome message, restore real history
  document.getElementById('chat-messages').innerHTML = ''
  history.forEach(({ role, content }) => addMsg(role, content))
}

async function sendChat () {
  const input = document.getElementById('chat-input')
  const btn   = document.getElementById('send-btn')
  const text  = input.value.trim()
  if (!text || isChatLoading) return

  input.value = ''
  input.style.height = '40px'
  isChatLoading = true
  btn.disabled  = true

  addMsg('user', text)
  const typingId = addMsg('assistant', '', true)

  try {
    const result = await window.electronAPI.sendChat(text)
    removeMsg(typingId)
    if (result.ok) {
      addMsg('assistant', result.reply)
    } else {
      addMsg('assistant', `Sorry, something went wrong: ${result.error || 'Unknown error'}`)
    }
  } catch (e) {
    removeMsg(typingId)
    addMsg('assistant', 'Connection failed. Check your API key in Settings.')
  }

  isChatLoading = false
  btn.disabled  = false
  document.getElementById('chat-messages').scrollTop = 99999
}

function quickAction (prompt) {
  const input = document.getElementById('chat-input')
  input.value = prompt
  autoResize(input)
  if (currentTab !== 'chat') switchTab('chat')
  sendChat()
}

// ── Settings ──────────────────────────────────────────────────────────────────
const MASKED_KEY = '........................................'

function loadSettingsUI (s) {
  if (!s) return
  currentSettings = s

  loadWhisperStatus()

  // Mask both key fields if keys are already saved
  window.electronAPI.getApiKeyStatus().then(({ hasKey }) => {
    const keyInput = document.getElementById('settings-api-key')
    if (keyInput) keyInput.value = hasKey ? MASKED_KEY : ''
  })
  window.electronAPI.getTavilyKeyStatus().then(({ hasKey }) => {
    const tavilyInput = document.getElementById('tavily-api-key')
    if (tavilyInput) tavilyInput.value = hasKey ? MASKED_KEY : ''
  })

  const intervalEl = document.getElementById('scan-interval')
  const daysEl     = document.getElementById('memory-days')

  if (intervalEl && s.scanInterval) {
    const opt = intervalEl.querySelector(`option[value="${s.scanInterval}"]`)
    if (opt) opt.selected = true
  }
  if (daysEl && s.memoryDays) {
    const opt = daysEl.querySelector(`option[value="${s.memoryDays}"]`)
    if (opt) opt.selected = true
  }

  // Auto-detect and display timezone
  const tz    = Intl.DateTimeFormat().resolvedOptions().timeZone
  const tzEl  = document.getElementById('settings-timezone')
  if (tzEl) tzEl.textContent = `${tz} (auto-detected)`

  // Populate watchlist fields from saved profile
  window.electronAPI.getProfile().then(prof => {
    const wl = prof?.watchlist || []
    for (let i = 0; i < 5; i++) {
      const el = document.getElementById(`wl-settings-${i}`)
      if (el) el.value = wl[i] || ''
    }
  }).catch(() => {})

  // Show Tavily monthly usage
  window.electronAPI.getTavilyUsage().then(({ count, limit }) => {
    const el = document.getElementById('tavily-usage')
    if (!el) return
    if (count >= limit) {
      el.textContent = 'Limit reached, using fallback search'
      el.style.color = '#EF4444'
    } else {
      el.textContent = `Tavily searches this month: ${count} / ${limit}`
      el.style.color = ''
    }
  }).catch(() => {})
}

async function saveSettings () {
  const interval = parseInt(document.getElementById('scan-interval').value)
  const days     = parseInt(document.getElementById('memory-days').value)
  const tz       = Intl.DateTimeFormat().resolvedOptions().timeZone

  const btn = document.querySelector('.settings-save-btn')
  btn.textContent = 'Saving…'
  btn.disabled = true

  await window.electronAPI.saveSettings({ scanInterval: interval, memoryDays: days })
  window.electronAPI.saveTimezone(tz)   // persist detected timezone into profile

  btn.textContent = '✓ Saved'
  setTimeout(() => { btn.textContent = 'Save Settings'; btn.disabled = false }, 1500)
}

async function saveWatchlist () {
  const topics = []
  for (let i = 0; i < 5; i++) {
    const val = (document.getElementById(`wl-settings-${i}`)?.value || '').trim()
    if (val) topics.push(val)
  }
  const btn    = document.getElementById('watchlist-save-btn')
  const status = document.getElementById('watchlist-status')
  btn.textContent = 'Saving…'
  btn.disabled = true
  await window.electronAPI.saveWatchlist(topics)
  if (status) { status.textContent = '✓ Saved'; status.className = 'settings-status ok' }
  btn.textContent = 'Save Watchlist'
  btn.disabled = false
  setTimeout(() => { if (status) { status.textContent = ''; status.className = 'settings-status' } }, 2000)
}

async function reTestApiKey () {
  const input  = document.getElementById('settings-api-key')
  const btn    = document.getElementById('retest-btn')
  const status = document.getElementById('retest-status')
  const key    = input.value.trim()

  // When dots are showing, send null so IPC loads the saved key
  const keyToSend = (key === MASKED_KEY) ? null : key

  if (!keyToSend && key !== MASKED_KEY) {
    status.textContent = 'Enter an API key first'
    status.className = 'settings-status err'
    return
  }

  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>Testing…'
  status.textContent = 'Connecting…'
  status.className = 'settings-status loading'

  const result = await window.electronAPI.reTestApiKey(keyToSend)

  if (result.ok) {
    status.textContent = '✓ Connected'
    status.className = 'settings-status ok'
    btn.textContent = '✓ OK'
    setTimeout(() => { btn.textContent = 'Test'; btn.disabled = false }, 2500)
  } else {
    status.textContent = result.error ? `Error: ${result.error}` : 'Failed, check your key'
    status.className = 'settings-status err'
    btn.textContent = 'Test'
    btn.disabled = false
  }
}

async function saveOpenRouterKey () {
  const input  = document.getElementById('settings-api-key')
  const btn    = document.getElementById('save-openrouter-btn')
  const status = document.getElementById('retest-status')
  const key    = input.value.trim()

  if (key === MASKED_KEY) {
    status.textContent = 'Key already saved, paste a new key to replace it'
    status.className = 'settings-status'
    return
  }

  if (!key) {
    status.textContent = 'Enter an API key first'
    status.className = 'settings-status err'
    return
  }

  btn.disabled = true
  btn.textContent = 'Saving…'
  await window.electronAPI.saveOpenRouterKey(key)
  status.textContent = '✓ Key saved'
  status.className = 'settings-status ok'
  input.value = MASKED_KEY
  btn.textContent = '✓ Saved'
  setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false }, 1500)
}

// ── Tavily Search ─────────────────────────────────────────────────────────────
async function testTavilyKey () {
  const input  = document.getElementById('tavily-api-key')
  const btn    = document.getElementById('tavily-test-btn')
  const status = document.getElementById('tavily-status')
  const key    = input.value.trim()

  // When dots are showing, send null so IPC loads the saved key
  const keyToSend = (key === MASKED_KEY) ? null : key

  if (!keyToSend && key !== MASKED_KEY) {
    status.textContent = 'Enter a Tavily API key first'
    status.className = 'settings-status err'
    return
  }

  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>Testing…'
  status.textContent = 'Connecting…'
  status.className = 'settings-status loading'

  const result = await window.electronAPI.testTavilyKey(keyToSend)

  if (result.ok) {
    status.textContent = '✓ Connected'
    status.className = 'settings-status ok'
    btn.textContent = '✓ OK'
    setTimeout(() => { btn.textContent = 'Test'; btn.disabled = false }, 2500)
  } else {
    status.textContent = result.error ? `Error: ${result.error}` : 'Failed, check your key'
    status.className = 'settings-status err'
    btn.textContent = 'Test'
    btn.disabled = false
  }
}

async function saveTavilyKeyUI () {
  const input  = document.getElementById('tavily-api-key')
  const btn    = document.getElementById('tavily-save-btn')
  const status = document.getElementById('tavily-status')
  const key    = input.value.trim()

  if (key === MASKED_KEY) {
    status.textContent = 'Key already saved, paste a new key to replace it'
    status.className = 'settings-status'
    return
  }

  if (!key) {
    status.textContent = 'Enter a Tavily API key first'
    status.className = 'settings-status err'
    return
  }

  btn.disabled = true
  btn.textContent = 'Saving…'
  await window.electronAPI.saveTavilyKey(key)
  status.textContent = '✓ Key saved'
  status.className = 'settings-status ok'
  input.value = MASKED_KEY
  btn.textContent = '✓ Saved'
  setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false }, 1500)
}

async function loadWhisperStatus () {
  const el = document.getElementById('whisper-status')
  if (!el) return
  try {
    const { available } = await window.electronAPI.getWhisperStatus()
    if (available) {
      el.textContent = 'Audio transcription: Active'
      el.className = 'settings-status'
      el.style.color = '#F0F0F0'
    } else {
      el.textContent = 'Audio transcription: Not available — install Whisper to enable'
      el.className = 'settings-status'
      el.style.color = 'var(--text-dim)'
    }
  } catch {
    el.textContent = 'Audio transcription: Status unknown'
    el.className = 'settings-status'
  }
}

let clearConfirmPending = false
function clearMemoryConfirm () {
  const btn = document.querySelector('.settings-btn.danger')

  if (!clearConfirmPending) {
    clearConfirmPending = true
    btn.textContent = 'Tap again to confirm'
    btn.style.opacity = '0.7'
    setTimeout(() => {
      if (clearConfirmPending) {
        clearConfirmPending = false
        btn.textContent = '🗑 Clear Memory'
        btn.style.opacity = ''
      }
    }, 2500)
  } else {
    clearConfirmPending = false
    btn.textContent = 'Clearing…'
    window.electronAPI.clearMemory().then(() => {
      memoryData = []
      if (currentTab === 'memory') renderMemory()
      btn.textContent = '✓ Cleared'
      btn.style.opacity = ''
      setTimeout(() => { btn.textContent = '🗑 Clear Memory' }, 1500)
    })
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init () {
  const [ins, mem, chat, s, v] = await Promise.all([
    window.electronAPI.getInsights(),
    window.electronAPI.getMemory(),
    window.electronAPI.getChatHistory(),
    window.electronAPI.getSettings(),
    window.electronAPI.getVersion(),
  ])

  insights   = ins  || []
  memoryData = mem  || []

  renderInsights()
  renderMemory()
  loadChatHistory(chat)
  loadSettingsUI(s)

  if (v) {
    document.getElementById('settings-version').textContent = `Covexy v${v}`
    const aboutVersion = document.getElementById('about-version')
    if (aboutVersion) aboutVersion.textContent = `v${v}`
  }

  // Live push subscriptions
  window.electronAPI.onSwitchTab((tab) => {
    switchTab(tab)
  })

  window.electronAPI.onInsightsUpdate((d) => {
    insights = d || []
    if (currentTab === 'insights') {
      renderInsights()
    } else {
      // Update badge silently
      const today = insights.filter(h => isToday(h.timestamp))
      const badge = document.getElementById('insights-badge')
      if (today.length > 0) { badge.textContent = today.length; badge.style.display = 'flex' }
      else badge.style.display = 'none'
    }
  })

  window.electronAPI.onMemoryUpdate((d) => {
    memoryData = d || []
    if (currentTab === 'memory') renderMemory()
  })

  window.electronAPI.onSettingsUpdate((d) => {
    loadSettingsUI(d)
  })

  window.electronAPI.onShowChatContext((insight) => {
    switchTab('chat')
    const input = document.getElementById('chat-input')
    input.value = insight
    autoResize(input)
  })
}

init()
