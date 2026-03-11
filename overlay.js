window.addEventListener('message-from-main', (e) => {
  document.getElementById('message').textContent = e.detail
})

window.electronAPI.onShowSuggestion((message) => {
  document.getElementById('message').textContent = message
})

function sendAction(action) {
  window.electronAPI.sendAction(action)
}
