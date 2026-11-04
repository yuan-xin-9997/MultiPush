'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('multipushDesktop', Object.freeze({
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  testServer: (value) => ipcRenderer.invoke('desktop:test-server', value),
  connect: (value) => ipcRenderer.invoke('desktop:connect', value),
  openExternal: (value) => ipcRenderer.invoke('desktop:open-external', value),
  quit: () => ipcRenderer.invoke('desktop:quit'),
}))
