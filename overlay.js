window.electronAPI.onShowSuggestion((data) => {
  const message = typeof data === 'string' ? data : data.message
  const category = typeof data === 'object' ? data.category : null

  document.getElementById('message').textContent = message

  const badge = document.getElementById('badge')
  if (category) {
    badge.textContent = category.toUpperCase()
    badge.className = `category-badge ${category}`
    badge.style.display = 'inline-block'
  } else {
    badge.style.display = 'none'
  }
})

function sendAction(action) {
  window.electronAPI.sendAction(action)
}
