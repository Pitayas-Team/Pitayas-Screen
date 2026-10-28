const { contextBridge, ipcRenderer } = require('electron');
const { makeBridge } = require('./core/bridge');

contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('screen:state'),
  setEncoder: (id) => ipcRenderer.invoke('screen:set-encoder', id),
  forget: () => ipcRenderer.invoke('screen:forget'),
  vddInstall: () => ipcRenderer.invoke('screen:vdd-install'),
  vddUninstall: () => ipcRenderer.invoke('screen:vdd-uninstall'),
  vddExtend: () => ipcRenderer.invoke('screen:vdd-extend'),
  setMonitor: (dev) => ipcRenderer.invoke('screen:set-monitor', dev),
  openUrl: (url) => ipcRenderer.invoke('screen:open-url', url),
  onState: (cb) => ipcRenderer.on('screen:state', (e, s) => cb(s)),
  quit: () => ipcRenderer.send('app-quit'),
});

// Pasek okna, ustawienia, folder danych i aktualizacje — wspólne z innymi aplikacjami (Pitaya Core)
contextBridge.exposeInMainWorld('pitayaBridge', makeBridge(ipcRenderer));
