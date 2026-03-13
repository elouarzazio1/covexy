// ── State ────────────────────────────────────────────────────────────────────
const isEditMode = window.covexy.isEditMode()
let apiKeyTested = false
let profileStep  = 0   // 0-4 = 5 profile questions
let profileData  = {}
let selectedStyle = null

const PROFILE_STEPS = [
  {
    title: 'What is your name?',
    sub: 'How should Covexy address you?',
    key: 'name', type: 'text', placeholder: 'Your name'
  },
  {
    title: 'What do you do professionally?',
    sub: 'This helps Covexy understand your context and priorities.',
    key: 'profession', type: 'text', placeholder: 'e.g. Founder, Designer, Engineer'
  },
  {
    title: 'What are your current main projects or priorities?',
    sub: 'Covexy will watch for anything related to these.',
    key: 'projects', type: 'textarea', placeholder: 'Describe your work, goals, or what you are focused on right now...'
  },
  {
    title: 'What should I always watch for?',
    sub: 'Covexy will search these topics every few hours, even when you are away.',
    key: 'watchlist', type: 'watchlist'
  },
  {
    title: 'Focus apps',
    sub: 'Covexy stays quiet while you use these apps. It still watches context, but holds notifications until you switch away.',
    key: 'ignore', type: 'textarea', placeholder: 'e.g. Netflix, YouTube, Spotify'
  },
  {
    title: 'How should I communicate with you?',
    sub: 'Covexy will match this style in all suggestions and responses.',
    key: 'style', type: 'style'
  }
]

// ── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  if (isEditMode) {
    // Skip API key step, go straight to profile
    const existing = await window.covexy.getProfile()
    if (existing) profileData = { ...existing }
    apiKeyTested = true // not needed but keeps flow consistent
    showProfileStep(0)
  }
})

// ── Welcome step ──────────────────────────────────────────────────────────────
function startOnboarding () {
  document.getElementById('step-welcome').classList.remove('active')
  document.getElementById('step-api').classList.add('active')
}

// ── API Key step ──────────────────────────────────────────────────────────────
function onApiInput () {
  const val = document.getElementById('api-input').value.trim()
  document.getElementById('test-btn').disabled = val.length < 10
  document.getElementById('test-status').textContent = ''
  document.getElementById('test-status').className = 'test-status'
  apiKeyTested = false
}

function togglePw () {
  const inp = document.getElementById('api-input')
  inp.type = inp.type === 'password' ? 'text' : 'password'
}

async function doTest () {
  const key = document.getElementById('api-input').value.trim()
  const btn = document.getElementById('test-btn')
  const status = document.getElementById('test-status')

  btn.disabled = true
  btn.innerHTML = '<div class="spinner"></div> Testing…'
  status.textContent = ''
  status.className = 'test-status loading'

  const { ok, error } = await window.covexy.testApiKey(key)

  if (ok) {
    status.textContent = '✓ Connected, Covexy AI is ready'
    status.className = 'test-status ok'
    apiKeyTested = true
    btn.innerHTML = '✓ Connected, Continue'
    btn.onclick = async () => {
      await window.covexy.saveApiKey(key)
      showTavilyStep()
    }
    btn.disabled = false
  } else {
    status.textContent = error ? `Error: ${error}` : 'Connection failed, check your API key'
    status.className = 'test-status err'
    btn.innerHTML = 'Test connection'
    btn.disabled = false
  }
}

// ── Tavily step ───────────────────────────────────────────────────────────────
function showTavilyStep () {
  document.getElementById('step-api').classList.remove('active')
  document.getElementById('step-tavily').classList.add('active')
}

function toggleTavilyPw () {
  const inp = document.getElementById('tavily-input')
  inp.type = inp.type === 'password' ? 'text' : 'password'
}

async function skipTavily () {
  document.getElementById('step-tavily').classList.remove('active')
  showProfileStep(0)
}

async function continueTavily () {
  const key = document.getElementById('tavily-input').value.trim()
  if (key.length > 5) {
    await window.covexy.saveTavilyKey(key)
  }
  document.getElementById('step-tavily').classList.remove('active')
  showProfileStep(0)
}

// ── Profile steps ─────────────────────────────────────────────────────────────
function showProfileStep (idx) {
  profileStep = idx
  document.getElementById('step-welcome')?.classList.remove('active')
  document.getElementById('step-api').classList.remove('active')
  document.getElementById('step-profile').classList.add('active')

  const s = PROFILE_STEPS[idx]
  document.getElementById('profile-title').textContent = s.title
  document.getElementById('profile-sub').textContent   = s.sub

  // Progress dots
  const dots = document.getElementById('progress-dots')
  dots.innerHTML = PROFILE_STEPS.map((_, i) =>
    `<div class="progress-dot ${i < idx ? 'done' : i === idx ? 'active' : ''}"></div>`
  ).join('')

  // Input area
  const area = document.getElementById('profile-input-area')
  if (s.type === 'text') {
    area.innerHTML = `<input type="text" id="profile-field" placeholder="${s.placeholder}" value="${esc(profileData[s.key] || '')}">`
    setTimeout(() => document.getElementById('profile-field')?.focus(), 50)
  } else if (s.type === 'textarea') {
    area.innerHTML = `<textarea id="profile-field" placeholder="${s.placeholder}">${esc(profileData[s.key] || '')}</textarea>`
    setTimeout(() => document.getElementById('profile-field')?.focus(), 50)
  } else if (s.type === 'watchlist') {
    const existing = Array.isArray(profileData.watchlist) ? profileData.watchlist : []
    const placeholders = [
      'e.g. industry trends',
      'e.g. competitor news',
      'e.g. AI model pricing',
      'e.g. your main tool updates',
      'e.g. your market keyword'
    ]
    area.innerHTML = `<div class="watchlist-inputs">${[0,1,2,3,4].map(i => `
      <div class="watchlist-item">
        <div class="watchlist-label">Topic ${i + 1}</div>
        <input type="text" id="wl-${i}" placeholder="${placeholders[i]}" value="${esc(existing[i] || '')}">
      </div>`).join('')}</div>`
    setTimeout(() => document.getElementById('wl-0')?.focus(), 50)
  } else if (s.type === 'style') {
    selectedStyle = profileData.style || null
    area.innerHTML = `
      <div class="style-options">
        <button class="style-btn ${selectedStyle === 'direct' ? 'selected' : ''}" onclick="selectStyle('direct', this)">
          <span class="style-label">Direct &amp; concise</span>
          <span class="style-desc">No fluff. Give me the point immediately.</span>
        </button>
        <button class="style-btn ${selectedStyle === 'friendly' ? 'selected' : ''}" onclick="selectStyle('friendly', this)">
          <span class="style-label">Friendly &amp; warm</span>
          <span class="style-desc">Conversational, encouraging, human.</span>
        </button>
        <button class="style-btn ${selectedStyle === 'formal' ? 'selected' : ''}" onclick="selectStyle('formal', this)">
          <span class="style-label">Formal &amp; professional</span>
          <span class="style-desc">Polished, structured, businesslike.</span>
        </button>
      </div>`
  }

  // Back/Next labels
  document.getElementById('back-btn').style.display = (idx === 0 && !isEditMode) ? 'none' : 'flex'
  document.getElementById('next-btn').textContent = idx === PROFILE_STEPS.length - 1 ? (isEditMode ? 'Save changes' : 'Finish setup') : 'Next'

  // Skip link — show on non-essential steps (profession=1, watchlist=3, focus apps=4)
  const skipLink = document.getElementById('skip-link')
  if (skipLink) {
    skipLink.style.display = [1, 3, 4].includes(idx) ? 'block' : 'none'
  }
}

function selectStyle (val, el) {
  selectedStyle = val
  document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('selected'))
  el.classList.add('selected')
}

function profileBack () {
  if (profileStep === 0 && !isEditMode) {
    document.getElementById('step-profile').classList.remove('active')
    document.getElementById('step-tavily').classList.add('active')
  } else if (profileStep > 0) {
    showProfileStep(profileStep - 1)
  }
}

async function profileNext () {
  const s = PROFILE_STEPS[profileStep]

  // Save current step
  if (s.type === 'style') {
    profileData.style = selectedStyle || 'direct'
  } else if (s.type === 'watchlist') {
    profileData.watchlist = [0,1,2,3,4]
      .map(i => (document.getElementById(`wl-${i}`)?.value || '').trim())
      .filter(Boolean)
  } else {
    const field = document.getElementById('profile-field')
    profileData[s.key] = field?.value?.trim() || ''
  }

  if (profileStep < PROFILE_STEPS.length - 1) {
    showProfileStep(profileStep + 1)
  } else {
    // Final step — save and finish
    await window.covexy.saveProfile(profileData)
    if (isEditMode) {
      window.covexy.profileEditDone()
    } else {
      window.covexy.done()
    }
  }
}

function esc (s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

// ── Safe external URL opener ───────────────────────────────────────────────────
function openUrl (url) {
  console.log('[covexy] openExternal available:', typeof window.covexy?.openExternal)
  if (window.covexy && typeof window.covexy.openExternal === 'function') {
    window.covexy.openExternal(url)
  }
}

// ── Skip profile step ─────────────────────────────────────────────────────────
function skipProfileStep () {
  const s = PROFILE_STEPS[profileStep]
  if (s.type === 'watchlist') {
    profileData.watchlist = []
  } else {
    profileData[s.key] = ''
  }
  if (profileStep < PROFILE_STEPS.length - 1) {
    showProfileStep(profileStep + 1)
  }
}

// Keyboard nav
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    const welcomeActive = document.getElementById('step-welcome').classList.contains('active')
    const profileActive = document.getElementById('step-profile').classList.contains('active')
    const apiActive     = document.getElementById('step-api').classList.contains('active')
    if (welcomeActive) {
      startOnboarding()
    } else if (profileActive) {
      const s = PROFILE_STEPS[profileStep]
      if (s.type !== 'textarea') profileNext()
    } else if (apiActive && apiKeyTested) {
      // handled by button onclick
    }
  }
})
