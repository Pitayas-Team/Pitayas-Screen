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
  defaults: { port: 8195, encoder: 'auto', restoreToken: '' },
});
const { createPortal } = require('./portal');
const { detectEncoders } = require('./stream');
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
});

function pickEncoder() {
  const want = core.settings.get('encoder');
  return encoders.find((e) => e.id === want) || encoders[0];
}

// ───── Android: tunel ADB przez kabel (adb reverse) — telefon łączy się z 127.0.0.1 ─────
const reversed = new Set();
function pollAdb() {
  execFile('adb', ['devices'], { timeout: 5000 }, (err, out) => {
    if (err) { cable.adb = false; cable.android = []; pushState(); return; }
    cable.adb = true;
    const list = String(out).split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[0] && p[1]);
    cable.android = list.map(([serial, st]) => ({ serial, state: st === 'device' ? 'ok' : st === 'unauthorized' ? 'unauthorized' : st }));
    for (const d of cable.android) {
      if (d.state !== 'ok' || reversed.has(d.serial)) continue;
      execFile('adb', ['-s', d.serial, 'reverse', `tcp:${PORT()}`, `tcp:${PORT()}`], { timeout: 5000 }, (e) => {
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
    encoders = detectEncoders();
    core.log.info(`Kodery: ${encoders.map((e) => e.id).join(', ') || 'brak'}`);
    let portal;
    try { portal = await createPortal({ log: core.log }); }
    catch (err) { cable.error = `Portal: ${err.message}`; core.log.error(err); pushState(); return; }
    session = createSession({
      portal, log: core.log, getEncoder: pickEncoder,
      getRestoreToken: () => core.settings.get('restoreToken'), setRestoreToken: (t) => core.settings.set('restoreToken', t),
      onStatus: (st) => { core.setStatus(st); pushState(); },
    });
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
ipcMain.handle('screen:forget', () => { core.settings.set('restoreToken', ''); return true; });
