const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('covexy', {
  testApiKey:     key  => ipcRenderer.invoke('test-api-key', key),
  saveApiKey:     key  => ipcRenderer.invoke('save-api-key', key),
  saveProfile:    data => ipcRenderer.invoke('onboarding-save-profile', data),
  getProfile:     ()   => ipcRenderer.invoke('get-edit-profile'),
  done:           ()   => ipcRenderer.send('onboarding-complete'),
  profileEditDone:()   => ipcRenderer.send('profile-edit-done'),
  isEditMode:     ()   => new URLSearchParams(window.location.search).get('edit') === '1'
})
