// ═══════ PITAYAS SCREEN (Windows) — MONITOR I STEROWANIE ═══════
// Odpowiednik portal.js z Linuksa. Windows nie tworzy monitorów na życzenie, więc:
//  • jeśli jest zainstalowany wirtualny monitor (Virtual Display Driver), używamy go i ustawiamy mu rozdzielczość telefonu,
//  • jeśli nie — pokazujemy wybrany monitor (domyślnie główny) jako lustro.
// Dotyk i klawiatura: SendInput przez stały proces PowerShell (win/host.ps1).
const path = require('path');
const { spawn } = require('child_process');

const VIRTUAL = /virtual display|iddsample|mttvdd|parsec virtual|indirect display/i;
// Klawisze z telefonu (keysym X11, jak na Linuksie) → kody wirtualne Windows
const VK = { 0xff0d: 0x0d, 0xff08: 0x08, 0xff09: 0x09, 0xff1b: 0x1b, 0xff51: 0x25, 0xff52: 0x26, 0xff53: 0x27, 0xff54: 0x28, 0xffff: 0x2e };

async function createPortal({ log, appDir, getMonitor }) {
    // W spakowanej aplikacji host.ps1 leży w app.asar.unpacked (PowerShell nie czyta z archiwum asar)
    const script = path.join(appDir.replace(/app\.asar$/, 'app.asar.unpacked'), 'win', 'host.ps1');
    const host = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    const replies = [];
    let readyResolve;
    const ready = new Promise((r) => { readyResolve = r; });
    host.stdout.setEncoding('utf8');
    host.stdout.on('data', (c) => {
        buf += c;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line === 'ready') { readyResolve(); continue; }
            const r = replies.shift();
            if (r) r(line);
        }
    });
    host.stderr.on('data', (c) => log.warn('PowerShell:', String(c).trim().slice(0, 300)));
    host.on('exit', (code) => log.warn(`Pomocnik PowerShell zakończył się (${code})`));
    await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('PowerShell nie odpowiada')), 20000))]);

    const cmd = (line) => { try { host.stdin.write(`${line}\n`); } catch {} };
    const ask = (line) => new Promise((resolve) => { replies.push(resolve); cmd(line); setTimeout(() => resolve(''), 5000); });

    async function monitors() {
        try { return JSON.parse(await ask('mon')) || []; } catch { return []; }
    }

    let session = false, mon = null, target = [1280, 720], frame = null;

    // Który monitor pokazujemy: wybrany w ustawieniach → wirtualny → główny
    async function pick() {
        const list = await monitors();
        const want = getMonitor && getMonitor();
        return list.find((m) => want && m.device === want) || list.find((m) => VIRTUAL.test(m.adapter)) || list.find((m) => m.primary) || list[0] || null;
    }

    async function start() {
        mon = await pick();
        if (!mon) throw new Error('Nie widzę żadnego monitora');
        session = true;
        log.info(`Monitor: ${mon.device} (${mon.adapter}) ${mon.w}×${mon.h} @ ${mon.x},${mon.y}`);
        return { node: 0, restoreToken: '' };
    }

    // Wirtualny monitor dostaje dokładnie rozdzielczość telefonu (jeśli sterownik ma taki tryb); zwykły zostaje jak jest
    async function fit(w, h) {
        target = [w, h];
        if (!mon) return;
        if (VIRTUAL.test(mon.adapter) && (mon.w !== w || mon.h !== h)) {
            const r = await ask(`mode ${mon.device} ${w} ${h}`);
            if (r === '0') log.info(`Wirtualny monitor: ustawiono ${w}×${h}`);
            else log.warn(`Wirtualny monitor nie ma trybu ${w}×${h} — obraz będzie przeskalowany`);
            const fresh = (await monitors()).find((m) => m.device === mon.device);
            if (fresh) mon = fresh;
        }
        // Obraz monitora wpisany w ekran telefonu (z czarnymi pasami, gdy proporcje się różnią)
        const s = Math.min(w / mon.w, h / mon.h);
        frame = { s, ox: (w - mon.w * s) / 2, oy: (h - mon.h * s) / 2 };
    }

    // x, y w pikselach obrazu telefonu → piksele pulpitu Windows
    function toDesktop(x, y) {
        if (!mon || !frame) return null;
        const mx = Math.max(0, Math.min(mon.w - 1, (x - frame.ox) / frame.s));
        const my = Math.max(0, Math.min(mon.h - 1, (y - frame.oy) / frame.s));
        return [Math.round(mon.x + mx), Math.round(mon.y + my)];
    }

    return {
        start,
        stop: async () => { session = false; },
        fit,
        monitor: () => mon,
        monitors,
        node: () => 0,
        active: () => session,
        setSize: (w, h) => { target = [w, h]; },
        move: (x, y) => { const p = toDesktop(x, y); if (p) cmd(`m ${p[0]} ${p[1]}`); },
        button: (name, down) => cmd(`b ${name === 'right' ? 'r' : 'l'} ${down ? 1 : 0}`),
        scroll: (dx, dy) => cmd(`w ${Math.round(-dy * 4)} ${Math.round(dx * 4)}`),
        keysym: (sym, down) => {
            if (!down) return;   // Windows: wciśnięcie + puszczenie wysyłamy razem
            if (VK[sym]) cmd(`k ${VK[sym]}`);
            else cmd(`c ${sym >= 0x01000000 ? sym - 0x01000000 : sym}`);
        },
        close: () => { try { host.kill(); } catch {} },
    };
}

module.exports = { createPortal, VIRTUAL };
