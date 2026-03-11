const CAT_COLORS = {
  email:    'rgba(90,200,250,0.65)',
  task:     'rgba(48,209,88,0.65)',
  research: 'rgba(255,159,10,0.65)',
  idea:     'rgba(191,90,242,0.65)',
  focus:    'rgba(255,214,10,0.65)',
  alert:    'rgba(255,69,58,0.65)',
  writing:  'rgba(90,200,250,0.65)',
}

let currentInsight = ''
let dismissTimer   = null

window.electronAPI.onShowSuggestion((data) => {
  const insight  = typeof data === 'string' ? data : (data.insight  || data.message || '')
  const category = typeof data === 'object' ? (data.category || '').toLowerCase() : ''

  currentInsight = insight

  // Populate content
  document.getElementById('message').textContent = insight

  const badge = document.getElementById('badge')
  if (category) {
    badge.textContent  = category.toUpperCase()
    badge.className    = `category-badge ${category}`
  }

  // Match progress bar color to category
  const bar = document.getElementById('progress-bar')
  bar.style.background = CAT_COLORS[category] || 'rgba(48,209,88,0.55)'

  // Reset container visibility (in case it was faded out)
  const container = document.querySelector('.container')
  container.style.transition = 'none'
  container.style.opacity   = '1'
  container.style.transform = 'translateY(0)'

  // Restart progress bar countdown animation
  bar.style.transition = 'none'
  bar.style.width = '100%'
  void bar.offsetWidth                          // force reflow
  bar.style.transition = 'width 10s linear'
  bar.style.width = '0%'

  // Auto-dismiss after 10 s
  clearTimeout(dismissTimer)
  dismissTimer = setTimeout(fadeOut, 10000)
})

function fadeOut () {
  clearTimeout(dismissTimer)
  const container = document.querySelector('.container')
  container.style.transition = 'opacity 0.38s ease, transform 0.38s ease'
  container.style.opacity   = '0'
  container.style.transform = 'translateY(-5px)'
  setTimeout(() => window.electronAPI.sendAction('dismiss'), 400)
}

function sendFeedback (type) {
  clearTimeout(dismissTimer)
  window.electronAPI.sendFeedback(type, currentInsight)
  fadeOut()
}

function openChat () {
  clearTimeout(dismissTimer)
  window.electronAPI.openChat(currentInsight)
  fadeOut()
}
