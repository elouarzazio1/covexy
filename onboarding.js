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
    key: 'profession', type: 'text', placeholder: 'e.g. entrepreneur, founder of mention.ma and Inference Watch'
  },
  {
    title: 'What are your current main projects or priorities?',
    sub: 'Covexy will watch for anything related to these.',
    key: 'projects', type: 'textarea', placeholder: 'Describe your active projects, goals, or areas of focus…'
  },
  {
    title: 'What topics or apps should I never interrupt you about?',
    sub: 'Covexy will stay silent when it sees these.',
    key: 'ignore', type: 'textarea', placeholder: 'e.g. gaming, personal social media browsing, Netflix'
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
    status.textContent = '✓ Connected to google/gemini-3-flash-preview via OpenRouter'
    status.className = 'test-status ok'
    apiKeyTested = true
    btn.innerHTML = '✓ Connected — Continue'
    btn.onclick = async () => {
      await window.covexy.saveApiKey(key)
      showProfileStep(0)
    }
    btn.disabled = false
  } else {
    status.textContent = error ? `Error: ${error}` : 'Connection failed — check your API key'
    status.className = 'test-status err'
    btn.innerHTML = 'Test connection'
    btn.disabled = false
  }
}

// ── Profile steps ─────────────────────────────────────────────────────────────
function showProfileStep (idx) {
  profileStep = idx
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
}

function selectStyle (val, el) {
  selectedStyle = val
  document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('selected'))
  el.classList.add('selected')
}

function profileBack () {
  if (profileStep === 0 && !isEditMode) {
    document.getElementById('step-profile').classList.remove('active')
    document.getElementById('step-api').classList.add('active')
  } else if (profileStep > 0) {
    showProfileStep(profileStep - 1)
  }
}

async function profileNext () {
  const s = PROFILE_STEPS[profileStep]

  // Save current step
  if (s.type === 'style') {
    profileData.style = selectedStyle || 'direct'
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

// Keyboard nav
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    const profileActive = document.getElementById('step-profile').classList.contains('active')
    const apiActive     = document.getElementById('step-api').classList.contains('active')
    if (profileActive) {
      const s = PROFILE_STEPS[profileStep]
      if (s.type !== 'textarea') profileNext()
    } else if (apiActive && apiKeyTested) {
      // handled by button onclick
    }
  }
})
