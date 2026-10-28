// ═══════ PITAYAS SCREEN (Windows) — NARZĘDZIA ═══════
// FFmpeg (obraz) i adb (Android) nie są częścią Windowsa — przy pierwszym uruchomieniu pobieramy je do folderu danych
// (~\AppData\Roaming\Pitayas\Screen\tools). Rozpakowuje wbudowany w Windows 10+ tar.exe (obsługuje .zip).
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, execFileSync } = require('child_process');

const SOURCES = {
    ffmpeg: { url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', exe: 'ffmpeg.exe', label: 'FFmpeg' },
    adb: { url: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip', exe: 'adb.exe', label: 'Android platform-tools' },
};

function download(url, file, onProgress, hops = 0) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Pitayas-Screen' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 8) {
                res.resume();
                return resolve(download(new URL(res.headers.location, url).toString(), file, onProgress, hops + 1));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            const total = Number(res.headers['content-length']) || 0;
            let done = 0;
            const out = fs.createWriteStream(file);
            res.on('data', (c) => { done += c.length; if (total && onProgress) onProgress(Math.round(done * 100 / total)); });
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve()));
            out.on('error', reject);
        }).on('error', reject);
    });
}

// Szuka pliku exe w rozpakowanym folderze (archiwa mają podfoldery z wersją w nazwie)
function findExe(dir, exe) {
    if (!fs.existsSync(dir)) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isFile() && e.name.toLowerCase() === exe) return p;
        if (e.isDirectory()) { const f = findExe(p, exe); if (f) return f; }
    }
    return null;
}

function onPath(exe) {
    try { return execFileSync('where', [exe], { encoding: 'utf8', timeout: 3000 }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

function createTools({ dataDir, log, onStatus }) {
    const root = path.join(dataDir, 'tools');
    const busy = {};
    async function ensure(name) {
        const src = SOURCES[name];
        const dir = path.join(root, name);
        const have = findExe(dir, src.exe) || onPath(src.exe);
        if (have) return have;
        if (busy[name]) return busy[name];
        busy[name] = (async () => {
            fs.mkdirSync(dir, { recursive: true });
            const zip = path.join(root, `${name}.zip`);
            log.info(`Pobieram ${src.label}…`);
            onStatus && onStatus(`Pobieram ${src.label}…`);
            await download(src.url, zip, (p) => onStatus && onStatus(`Pobieram ${src.label} — ${p}%`));
            onStatus && onStatus(`Rozpakowuję ${src.label}…`);
            await new Promise((res, rej) => execFile('tar', ['-xf', zip, '-C', dir], { timeout: 300000 }, (e) => (e ? rej(e) : res())));
            fs.rmSync(zip, { force: true });
            onStatus && onStatus('');
            const exe = findExe(dir, src.exe);
            if (!exe) throw new Error(`Brak ${src.exe} po rozpakowaniu`);
            log.info(`${src.label}: ${exe}`);
            return exe;
        })().finally(() => { busy[name] = null; });
        return busy[name];
    }
    return { ensure, cached: (name) => findExe(path.join(root, name), SOURCES[name].exe) || onPath(SOURCES[name].exe) };
}

module.exports = { createTools, download, findExe };
