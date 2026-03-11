window.electronAPI.onShowSuggestion((data) => {
  const insight  = typeof data === 'string' ? data : (data.insight || data.message || '')
  const category = typeof data === 'object' ? (data.category || '').toLowerCase() : ''
  const action   = typeof data === 'object' ? (data.action || '').trim() : ''

  document.getElementById('message').textContent = insight

  const actionEl = document.getElementById('action-hint')
  if (action && action.toUpperCase() !== 'NONE' && action !== '') {
    actionEl.textContent = '→ ' + action
    actionEl.style.display = 'block'
  } else {
    actionEl.style.display = 'none'
  }

  const badge = document.getElementById('badge')
  if (category) {
    badge.textContent = category.toUpperCase()
    badge.className = `category-badge ${category}`
    badge.style.display = 'inline-block'
  } else {
    badge.style.display = 'none'
  }
})

function sendAction (action) {
  window.electronAPI.sendAction(action)
}
