// ═══════ PITAYAS SCREEN (Windows) — MONITOR I STEROWANIE ═══════
// Odpowiednik portal.js z Linuksa. Windows nie tworzy monitorów na życzenie, więc:
//  • jeśli jest zainstalowany wirtualny monitor (Virtual Display Driver), używamy go i ustawiamy mu rozdzielczość telefonu,
//  • jeśli nie — pokazujemy wybrany monitor (domyślnie główny) jako lustro.
// Dotyk i klawiatura: SendInput przez stały proces PowerShell (win/host.ps1).
const path = require('path');
const { spawn, execFile } = require('child_process');

// Wirtualny monitor poznajemy po karcie, nazwie monitora i jego identyfikatorze (MTT1337 = Virtual Display Driver)
const VIRTUAL = /virtual display|iddsample|mttvdd|mtt1337|vdd by mtt|parsec virtual|indirect display|usbmmidd/i;
const isVirtual = (m) => VIRTUAL.test(`${m.adapter || ''} ${m.monitor || ''} ${m.monitorId || ''}`);
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
            if (r && !r.dead) { r.settled = true; r.resolve(line); }   // spóźniona odpowiedź na zakończone czasem zapytanie jest odrzucana
        }
    });
    host.stderr.on('data', (c) => log.warn('PowerShell:', String(c).trim().slice(0, 300)));
    host.on('exit', (code) => log.warn(`Pomocnik PowerShell zakończył się (${code})`));
    await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('PowerShell nie odpowiada')), 20000))]);

    const cmd = (line) => { try { host.stdin.write(`${line}\n`); } catch {} };
    const ask = (line, ms = 5000) => new Promise((resolve) => {
        const e = { resolve, dead: false, settled: false };
        replies.push(e);
        cmd(line);
        setTimeout(() => { if (!e.settled) { e.dead = true; resolve(''); } }, ms);
    });

    async function monitors() {
        try { return JSON.parse(await ask('mon')) || []; } catch { return []; }
    }

    let session = false, mon = null, target = [1280, 720], frame = null;

    // Który monitor pokazujemy: wybrany w ustawieniach → wirtualny → główny
    async function pick() {
        const list = await monitors();
        const want = getMonitor && getMonitor();
        return list.find((m) => want && m.device === want) || list.find((m) => isVirtual(m)) || list.find((m) => m.primary) || list[0] || null;
    }

    async function start() {
        const all = await monitors();
        log.info(`Monitory w systemie: ${all.map((m) => `${m.device} [${m.adapter} / ${m.monitor || '?'}] ${m.w}×${m.h} @ ${m.x},${m.y}${m.primary ? ' (główny)' : ''}`).join('; ') || 'brak'}`);
        mon = await pick();
        if (!mon) throw new Error('Nie widzę żadnego monitora');
        session = true;
        log.info(`Monitor: ${mon.device} (${mon.adapter}) ${mon.w}×${mon.h} @ ${mon.x},${mon.y}`);
        return { node: 0, restoreToken: '' };
    }

    // Najbliższy tryb z listy monitora: proporcje ważniejsze niż liczba pikseli (żeby nie było czarnych pasów)
    function pickMode(modes, w, h) {
        let best = null, bestScore = Infinity;
        for (const [mw, mh] of modes) {
            const score = Math.abs(Math.log((mw / mh) / (w / h))) * 4 + Math.abs(Math.log((mw * mh) / (w * h)));
            if (score < bestScore) { bestScore = score; best = [mw, mh]; }
        }
        return best;
    }
    const getModes = async (device) => { try { return JSON.parse(await ask(`modes ${device}`)) || []; } catch { return []; } };
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);

    // Dopasowuje monitor do telefonu i zwraca rozmiar strumienia [w, h].
    //  • wirtualny monitor: ustawiamy mu najbliższy tryb z listy sterownika (rozdzielczość telefonu albo najbliższa),
    //  • zwykły monitor (lustro): zostaje, jak jest.
    // Strumień idzie w natywnym rozmiarze monitora (bez skalowania po stronie komputera); zmniejszamy go tylko, gdy jest większy niż ekran telefonu.
    async function fit(w, h) {
        target = [w, h];
        mon = (await pick()) || mon;   // wirtualny monitor mógł pojawić się po starcie aplikacji
        if (!mon) return [w, h];
        // Windows potrafi trzymać nowy monitor w trybie „duplikuj” — wtedy telefon pokazywałby kopię głównego ekranu. Przełączamy na „rozszerz”.
        if (isVirtual(mon)) {
            const all = await monitors();
            if (all.some((m) => m.device !== mon.device && m.x === mon.x && m.y === mon.y)) {
                log.info('Wirtualny monitor jest zduplikowany z innym — przełączam Windows na „Rozszerz te ekrany”');
                await new Promise((r) => execFile('DisplaySwitch.exe', ['/extend'], { windowsHide: true, timeout: 15000 }, () => r()));
                await new Promise((r) => setTimeout(r, 2500));
                mon = (await pick()) || mon;
            }
        }
        if (isVirtual(mon)) {
            const best = pickMode(await getModes(mon.device), w, h);
            if (best && (best[0] !== mon.w || best[1] !== mon.h)) {
                const r = await ask(`mode ${mon.device} ${best[0]} ${best[1]}`);
                if (r === '0') log.info(`Wirtualny monitor: tryb ${best[0]}×${best[1]} (telefon ${w}×${h})`);
                else log.warn(`Nie udało się ustawić trybu ${best[0]}×${best[1]} na wirtualnym monitorze (odpowiedź: ${r || 'brak'})`);
                const fresh = (await monitors()).find((m) => m.device === mon.device);
                if (fresh) mon = fresh;
            }
        }
        const k = Math.min(1, w / mon.w, h / mon.h);
        const out = [even(mon.w * k), even(mon.h * k)];
        frame = { sx: out[0] / mon.w, sy: out[1] / mon.h };
        return out;
    }

    // x, y w pikselach obrazu strumienia → piksele pulpitu Windows
    function toDesktop(x, y) {
        if (!mon || !frame) return null;
        const mx = Math.max(0, Math.min(mon.w - 1, x / frame.sx));
        const my = Math.max(0, Math.min(mon.h - 1, y / frame.sy));
        return [Math.round(mon.x + mx), Math.round(mon.y + my)];
    }

    return {
        start,
        stop: async () => { session = false; },
        fit,
        monitor: () => mon,
        monitors,
        vddCount: async () => Number(await ask('vdd', 20000)) || 0,   // 0 = sterownik wirtualnego monitora niezainstalowany
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

module.exports = { createPortal, VIRTUAL, isVirtual };
