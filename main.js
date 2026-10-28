const { app, BrowserWindow, ipcMain, nativeImage, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

// Pitaya Core: dane w ~/.config/Pitayas/Screen, ustawienia, logi, aktualizacje, rejestr dla huba
const core = require('./core').create({
  id: 'screen',
  folder: 'Screen',
  name: 'Pitayas Screen',
  repo: 'Pitayas-Team/Pitayas-Screen',
  appDir: __dirname,
  defaults: { port: 8195, encoder: 'auto', restoreToken: '', monitor: '' },
});
const WIN = process.platform === 'win32';
// Linux: portal Wayland + GStreamer. Windows: wybrany/wirtualny monitor + FFmpeg (narzędzia pobierane przy pierwszym starcie)
const { createPortal } = WIN ? require('./win/portal') : require('./portal');
const detectEncoders = WIN ? require('./win/capture').detectEncoders : require('./stream').detectEncoders;
const tools = WIN ? require('./win/tools').createTools({ dataDir: core.paths.data, log: core.log, onStatus: (t) => { toolStatus = t; pushState(); } }) : null;
let toolStatus = '', monitors = [], adbPath = WIN ? null : 'adb';
let vdd = null;   // Windows: instalacja wirtualnego monitora (win/vdd.js)
const vddState = { installed: false, monitor: false, busy: false, message: '' };
const { createSession } = require('./session');
const usbmux = require('./usbmux');

const PORT = () => Number(core.settings.get('port')) || 8195;
let mainWindow = null, tray = null, isQuitting = false;
let encoders = [], session = null;
const cable = { android: [], iphone: [], adb: true, error: '' };   // podłączone telefony

const send = (ch, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data); };
const pushState = () => send('screen:state', state());
const state = () => ({
  port: PORT(), encoders: encoders.map((e) => ({ id: e.id, label: e.label })), encoder: core.settings.get('encoder'),
  cable, stream: session ? session.status() : {},
  platform: process.platform, tools: toolStatus,
  monitors, monitor: core.settings.get('monitor'),
  virtual: WIN ? monitors.some((m) => require('./win/portal').VIRTUAL.test(m.adapter)) : true,
  vdd: vddState,
});

function pickEncoder() {
  const want = core.settings.get('encoder');
  return encoders.find((e) => e.id === want) || encoders[0];
}

// ───── Android: tunel ADB przez kabel (adb reverse) — telefon łączy się z 127.0.0.1 ─────
const reversed = new Set();
function pollAdb() {
  if (!adbPath) return;
  execFile(adbPath, ['devices'], { timeout: 5000 }, (err, out) => {
    if (err) { cable.adb = false; cable.android = []; pushState(); return; }
    cable.adb = true;
    const list = String(out).split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[0] && p[1]);
    cable.android = list.map(([serial, st]) => ({ serial, state: st === 'device' ? 'ok' : st === 'unauthorized' ? 'unauthorized' : st }));
    for (const d of cable.android) {
      if (d.state !== 'ok' || reversed.has(d.serial)) continue;
      execFile(adbPath, ['-s', d.serial, 'reverse', `tcp:${PORT()}`, `tcp:${PORT()}`], { timeout: 5000 }, (e) => {
        if (!e) { reversed.add(d.serial); core.log.info(`ADB: tunel do ${d.serial}`); pushState(); }
      });
    }
    for (const s of [...reversed]) if (!cable.android.some((d) => d.serial === s)) reversed.delete(s);
    pushState();
  });
}

// ───── iPhone: usbmux — komputer łączy się przez kabel z przekaźnikiem w aplikacji Pitayas ─────
const iphoneLinks = new Map();   // deviceId → { ws, trying }
function connectIphone(id) {
  const link = iphoneLinks.get(id);
  if (!link || link.ws || link.trying) return;
  link.trying = true;
  usbmux.connectDevice(id, PORT()).then((sock) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT()}/`, { createConnection: () => sock, perMessageDeflate: false });
    ws.on('open', () => {
      link.ws = ws; link.trying = false; link.state = 'ok';
      ws.send(JSON.stringify({ role: 'pc' }));
      session.attach(ws, 'iPhone (kabel)');
      pushState();
    });
    const drop = () => { link.ws = null; link.trying = false; link.state = 'waiting'; pushState(); };
    ws.on('close', drop);
    ws.on('error', drop);
  }).catch((err) => {
    link.trying = false;
    link.state = 'waiting';
    link.error = err.message;
  });
}
function watchIphones() {
  usbmux.watchDevices((devices) => {
    for (const [id, d] of devices) if (!iphoneLinks.has(id)) iphoneLinks.set(id, { serial: d.serial, ws: null, trying: false, state: 'waiting' });
    for (const id of [...iphoneLinks.keys()]) if (!devices.has(id)) { const l = iphoneLinks.get(id); if (l.ws) l.ws.close(); iphoneLinks.delete(id); }
    cable.iphone = [...iphoneLinks.values()].map((l) => ({ serial: l.serial, state: l.state }));
    pushState();
  }, core.log);
  // Aplikacja na iPhonie słucha tylko przy otwartym module Screen — próbujemy co 2 s
  setInterval(() => {
    for (const id of iphoneLinks.keys()) connectIphone(id);
    cable.iphone = [...iphoneLinks.values()].map((l) => ({ serial: l.serial, state: l.state }));
  }, 2000);
}

// ───── Serwer tylko na 127.0.0.1 (Android przez ADB) — z sieci nikt się nie połączy ─────
function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ app: 'screen', name: 'Pitayas Screen', version: app.getVersion() }));
  });
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  wss.on('connection', (ws) => session.attach(ws, 'Android (kabel)'));
  server.on('error', (err) => { cable.error = `Port ${PORT()}: ${err.message}`; pushState(); });
  server.listen(PORT(), '127.0.0.1', () => core.log.info(`Serwer: 127.0.0.1:${PORT()}`));
}

// ───── Okno ─────
function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
function createWindow() {
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;
  mainWindow = new BrowserWindow({
    width: 560, height: 640, minWidth: 480, minHeight: 520, frame: false, title: 'Pitayas Screen', backgroundColor: '#121116', icon,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('close', (e) => { if (!isQuitting) { e.preventDefault(); mainWindow.hide(); } });
  if (!tray && icon) {
    tray = new Tray(icon.resize({ width: 22, height: 22 }));
    tray.setToolTip('Pitayas Screen');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Otwórz Pitayas Screen', click: showWindow },
      { type: 'separator' },
      { label: 'Zamknij aplikację całkowicie', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => (mainWindow.isVisible() ? mainWindow.hide() : showWindow()));
  }
}

if (core.singleInstance(showWindow)) {
  core.registerIpc({ beforeRestart: () => { isQuitting = true; } });
  app.whenReady().then(async () => {
    createWindow();
    if (WIN) {
      // FFmpeg i adb pobierają się w tle przy pierwszym starcie; potem są od razu
      try { encoders = detectEncoders(await tools.ensure('ffmpeg')); } catch (err) { cable.error = `FFmpeg: ${err.message}`; core.log.error(err); }
      tools.ensure('adb').then((p) => { adbPath = p; pollAdb(); }).catch((err) => { core.log.warn('adb:', err.message); cable.adb = false; pushState(); });
    } else encoders = detectEncoders();
    core.log.info(`Kodery: ${encoders.map((e) => e.id).join(', ') || 'brak'}`);
    let portal;
    try { portal = await createPortal({ log: core.log, appDir: __dirname, getMonitor: () => core.settings.get('monitor') }); }
    catch (err) { cable.error = `Portal: ${err.message}`; core.log.error(err); pushState(); return; }
    session = createSession({
      portal, log: core.log, getEncoder: pickEncoder,
      getRestoreToken: () => core.settings.get('restoreToken'), setRestoreToken: (t) => core.settings.set('restoreToken', t),
      onStatus: (st) => { core.setStatus(st); pushState(); },
      getFfmpeg: () => tools.ensure('ffmpeg'),
    });
    if (WIN) {
      const refresh = async () => { monitors = await portal.monitors(); pushState(); };
      refresh();
      setInterval(refresh, 5000);   // np. po zainstalowaniu wirtualnego monitora
      vdd = require('./win/vdd').createVdd({ dataDir: core.paths.data, log: core.log, portal, onStatus: (t) => { vddState.message = t; pushState(); } });
      refreshVdd();
      setInterval(() => { if (!vddState.busy) refreshVdd(); }, 30000);
    }
    startServer();
    pollAdb();
    setInterval(pollAdb, 3000);
    watchIphones();
    pushState();
  });
  app.on('before-quit', () => { isQuitting = true; if (session) session.stopAll(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

ipcMain.on('pitaya:win-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('pitaya:win-close', () => mainWindow && mainWindow.hide());
ipcMain.on('app-quit', () => { isQuitting = true; app.quit(); });
ipcMain.handle('screen:state', () => state());
ipcMain.handle('screen:set-encoder', (e, id) => { core.settings.set('encoder', id); return state(); });
// Wirtualny monitor (Windows): sterownik Virtual Display Driver — dzięki niemu telefon jest prawdziwym dodatkowym monitorem
async function refreshVdd() {
  if (!vdd) return;
  try { Object.assign(vddState, await vdd.status()); } catch (err) { core.log.warn('VDD status:', err.message); }
  pushState();
}
const vddAction = (fn) => async () => {
  if (!vdd) return { ok: false, error: 'Dostępne tylko w Windows' };
  vddState.busy = true; pushState();
  try { await fn(); await refreshVdd(); return { ok: true }; }
  catch (err) { core.log.error(err); return { ok: false, error: err.message }; }
  finally { vddState.busy = false; vddState.message = ''; await refreshVdd(); }
};
ipcMain.handle('screen:vdd-install', vddAction(() => vdd.install()));
ipcMain.handle('screen:vdd-uninstall', vddAction(() => vdd.uninstall()));
ipcMain.handle('screen:vdd-extend', vddAction(() => vdd.extend()));
ipcMain.handle('screen:set-monitor', (e, dev) => { core.settings.set('monitor', dev || ''); return state(); });
ipcMain.handle('screen:open-url', (e, url) => { if (/^https:\/\//.test(url)) require('electron').shell.openExternal(url); });
ipcMain.handle('screen:forget', () => { core.settings.set('restoreToken', ''); return true; });
