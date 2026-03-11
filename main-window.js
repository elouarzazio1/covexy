// ── State ─────────────────────────────────────────────────────────────────────
let history = []
let currentTab = 'insights'
let msgCounter = 0

// ── Category config ───────────────────────────────────────────────────────────
const CAT = {
  email:    { icon: '✉', cls: 'email'    },
  tabs:     { icon: '⊞', cls: 'tabs'     },
  error:    { icon: '⚠', cls: 'error'    },
  task:     { icon: '✓', cls: 'task'     },
  deadline: { icon: '◷', cls: 'deadline' },
  focus:    { icon: '◉', cls: 'focus'    },
  other:    { icon: '◈', cls: 'other'    },
}

function catFor(item) {
  if (item.category && CAT[item.category]) return CAT[item.category]
  const t = (item.text || '').toLowerCase()
  if (t.includes('email') || t.includes('reply') || t.includes('message')) return CAT.email
  if (t.includes('tab') || t.includes('browser') || t.includes('bookmark')) return CAT.tabs
  if (t.includes('error') || t.includes('warning') || t.includes('debug')) return CAT.error
  if (t.includes('deadline') || t.includes('calendar') || t.includes('meeting')) return CAT.deadline
  return CAT.task
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isToday(iso) {
  return new Date(iso).toDateString() === new Date().toDateString()
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function fmtDay(dateStr) {
  const d = new Date(dateStr)
  if (d.toDateString() === new Date().toDateString()) return 'Today'
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}

function esc(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
  document.getElementById(`panel-${tab}`).classList.add('active')
  document.getElementById(`nav-${tab}`).classList.add('active')
}

// ── Render insights ───────────────────────────────────────────────────────────
function renderInsights() {
  const today = history.filter(h => isToday(h.time))
  const list = document.getElementById('insights-list')
  const sub  = document.getElementById('insights-sub')
  const badge = document.getElementById('insights-badge')

  if (today.length === 0) {
    sub.textContent = 'Nothing flagged yet today'
    badge.style.display = 'none'
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">⬡</div>
        <div class="empty-title">All clear for now</div>
        <div class="empty-body">Covexy watches silently and only surfaces insights when there's something genuinely worth your attention.</div>
      </div>`
    return
  }

  sub.textContent = `${today.length} insight${today.length !== 1 ? 's' : ''} today`
  badge.textContent = today.length
  badge.style.display = 'flex'

  list.innerHTML = today.map(item => {
    const c = catFor(item)
    return `
      <div class="insight">
        <div class="insight-icon ${c.cls}">${c.icon}</div>
        <div class="insight-body">
          <div class="insight-text">${esc(item.text)}</div>
          <div class="insight-time">${fmtTime(item.time)}</div>
        </div>
      </div>`
  }).join('')
}

// ── Render memory ─────────────────────────────────────────────────────────────
function renderMemory() {
  const list = document.getElementById('memory-list')

  if (history.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">◇</div>
        <div class="empty-title">No memories yet</div>
        <div class="empty-body">Insights from the past 7 days will appear here, grouped by day.</div>
      </div>`
    return
  }

  // Group by day
  const groups = {}
  history.forEach(item => {
    const key = new Date(item.time).toDateString()
    if (!groups[key]) groups[key] = []
    groups[key].push(item)
  })

  list.innerHTML = Object.entries(groups).map(([key, items]) => `
    <div class="day-group">
      <div class="day-label">${fmtDay(key)}</div>
      ${items.map(item => `
        <div class="memory-item">
          <div class="mem-dot"></div>
          <div class="mem-text">${esc(item.text)}</div>
        </div>`).join('')}
    </div>`
  ).join('')
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function autoResize(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendChat()
  } else {
    autoResize(e.target)
  }
}

function addMsg(role, content, isTyping = false) {
  const id = `msg-${++msgCounter}`
  const messages = document.getElementById('chat-messages')
  const div = document.createElement('div')
  div.className = `msg ${role}`
  div.id = id

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

function removeMsg(id) {
  document.getElementById(id)?.remove()
}

async function sendChat() {
  const input = document.getElementById('chat-input')
  const btn   = document.getElementById('send-btn')
  const text  = input.value.trim()
  if (!text) return

  input.value = ''
  input.style.height = '40px'
  btn.disabled = true

  addMsg('user', text)
  const typingId = addMsg('assistant', '', true)

  try {
    const reply = await window.electronAPI.sendChatMessage(text)
    removeMsg(typingId)
    addMsg('assistant', reply)
  } catch (e) {
    removeMsg(typingId)
    addMsg('assistant', 'I had trouble connecting to the local AI model. Make sure Ollama is running.')
  }

  btn.disabled = false
  document.getElementById('chat-messages').scrollTop = 99999
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
window.electronAPI.onHistoryUpdate((newHistory) => {
  history = newHistory
  renderInsights()
  renderMemory()
})

window.electronAPI.getHistory().then((h) => {
  history = h || []
  renderInsights()
  renderMemory()
})
