const { contextBridge, ipcRenderer } = require('electron');
const { makeBridge } = require('./core/bridge');

contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('screen:state'),
  setEncoder: (id) => ipcRenderer.invoke('screen:set-encoder', id),
  forget: () => ipcRenderer.invoke('screen:forget'),
  onState: (cb) => ipcRenderer.on('screen:state', (e, s) => cb(s)),
  quit: () => ipcRenderer.send('app-quit'),
});

// Pasek okna, ustawienia, folder danych i aktualizacje — wspólne z innymi aplikacjami (Pitaya Core)
contextBridge.exposeInMainWorld('pitayaBridge', makeBridge(ipcRenderer));
