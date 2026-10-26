// ═══════ PITAYAS SCREEN — SESJA ═══════
// Łączy telefon (WebSocket) z wirtualnym ekranem: rozmiar z telefonu → GStreamer, dotyk z telefonu → portal.
// Protokół (telefon → komputer, JSON):
//   {t:'hello', w, h, quality}         rozmiar ekranu telefonu w pikselach, jakość: 'high' | 'mid' | 'low'
//   {t:'pointer', x, y, b, btn}        x, y 0–1; b: 'down' | 'move' | 'up'; btn: 'left' | 'right'
//   {t:'scroll', dx, dy}               przewijanie
//   {t:'text', text} / {t:'key', sym}  klawiatura
// Komputer → telefon: {t:'config', codec, description, w, h} (JSON) i klatki binarne [1 bajt: klucz][H.264 avcC]
const { createStream } = require('./stream');

const QUALITY = { high: 16000, mid: 9000, low: 4500 };
const KEYSYM = { Enter: 0xff0d, Backspace: 0xff08, Tab: 0xff09, Escape: 0xff1b, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, Delete: 0xffff };

function createSession({ portal, log, getEncoder, getRestoreToken, setRestoreToken, onStatus }) {
    let viewer = null, size = null, config = null, waitingKey = true, idleTimer = null, frames = 0, bytes = 0, lastStat = Date.now();
    let starting = null, lastStart = null;
    const status = { streaming: false, size: null, fps: 0, mbps: 0, via: '', error: '' };
    const emit = () => onStatus && onStatus({ ...status });

    const stream = createStream({
        log,
        onConfig: (c) => {
            config = { t: 'config', ...c, w: size && size[0], h: size && size[1] };
            if (viewer) viewer.send(JSON.stringify(config));
        },
        onFrame: (key, data) => {
            if (!viewer || viewer.readyState !== 1) return;
            // Telefon nie nadąża (słaby kabel/telefon) — pomijamy klatki do następnej kluczowej
            if (viewer.bufferedAmount > 1500000) { waitingKey = true; return; }
            if (waitingKey && !key) return;
            waitingKey = false;
            const out = Buffer.allocUnsafe(data.length + 1);
            out[0] = key ? 1 : 0;
            data.copy(out, 1);
            viewer.send(out);
            frames++; bytes += out.length;
            const now = Date.now();
            if (now - lastStat >= 1000) {
                status.fps = Math.round(frames * 1000 / (now - lastStat));
                status.mbps = Math.round(bytes * 8 / (now - lastStat) / 100) / 10;
                frames = 0; bytes = 0; lastStat = now;
                emit();
            }
        },
        onExit: (code, err) => {
            // Dokładny rozmiar nie przeszedł (system go nie przyjął) — jeszcze raz ze skalowaniem
            if (code && lastStart && lastStart.exact && Date.now() - lastStart.at < 5000 && viewer) {
                log.warn('Dokładny rozmiar monitora nie przeszedł — skaluję obraz');
                lastStart.exact = false;
                stream.start({ fd: null, exact: false, node: portal.node(), width: lastStart.w, height: lastStart.h, kbps: QUALITY[lastStart.quality] || QUALITY.mid, encoder: getEncoder() });
                return;
            }
            status.streaming = false;
            if (code) status.error = `GStreamer: ${String(err || '').trim().split('\n').pop() || code}`;
            emit();
        },
    });

    async function startStream(w, h, quality) {
        // Parzyste wymiary (wymóg H.264), rozsądne granice
        w = Math.max(320, Math.min(3840, Math.round(w / 2) * 2));
        h = Math.max(320, Math.min(3840, Math.round(h / 2) * 2));
        if (!portal.active()) {
            const r = await Promise.race([
                portal.start({ restoreToken: getRestoreToken() }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('Brak odpowiedzi systemu — zgódź się na udostępnienie ekranu na komputerze')), 60000)),
            ]);
            if (r.restoreToken) setRestoreToken(r.restoreToken);
        }
        portal.setSize(w, h);
        size = [w, h];
        config = null;
        waitingKey = true;
        log.info(`Start obrazu ${w}×${h}`);
        lastStart = { w, h, quality, at: Date.now(), exact: true };
        stream.start({ fd: null, exact: true, node: portal.node(), width: w, height: h, kbps: QUALITY[quality] || QUALITY.mid, encoder: getEncoder() });
        Object.assign(status, { streaming: true, size: `${w}×${h}`, error: '' });
        emit();
    }

    function stopAll() {
        stream.stop();
        portal.stop();
        Object.assign(status, { streaming: false, size: null, fps: 0, mbps: 0 });
        emit();
    }

    function onMessage(ws, data, isBinary) {
        if (isBinary || ws !== viewer) return;
        let m;
        try { m = JSON.parse(String(data)); } catch { return; }
        if (m.t === 'hello') {
            clearTimeout(idleTimer);
            starting = startStream(Number(m.w) || 1280, Number(m.h) || 720, m.quality).catch((err) => {
                status.error = err.message;
                log.warn('Start ekranu:', err.message);
                emit();
                if (viewer) viewer.send(JSON.stringify({ t: 'error', message: err.message }));
            });
            return;
        }
        if (!size) return;
        if (m.t === 'pointer') {
            const x = Math.max(0, Math.min(1, Number(m.x))) * size[0], y = Math.max(0, Math.min(1, Number(m.y))) * size[1];
            portal.move(x, y);
            if (m.b === 'down') portal.button(m.btn === 'right' ? 'right' : 'left', true);
            if (m.b === 'up') portal.button(m.btn === 'right' ? 'right' : 'left', false);
        } else if (m.t === 'scroll') {
            portal.scroll(Number(m.dx) || 0, Number(m.dy) || 0);
        } else if (m.t === 'text') {
            for (const ch of String(m.text || '').slice(0, 200)) {
                const cp = ch.codePointAt(0);
                const sym = cp === 10 ? KEYSYM.Enter : cp < 0x100 ? cp : 0x01000000 + cp;
                portal.keysym(sym, true); portal.keysym(sym, false);
            }
        } else if (m.t === 'key' && KEYSYM[m.sym]) {
            portal.keysym(KEYSYM[m.sym], true); portal.keysym(KEYSYM[m.sym], false);
        }
    }

    // Nowy telefon (przez ADB albo usbmux). Ostatnio podłączony przejmuje obraz.
    function attach(ws, via) {
        if (viewer && viewer !== ws) try { viewer.close(); } catch {}
        viewer = ws;
        status.via = via;
        emit();
        log.info(`Telefon połączony (${via})`);
        ws.on('message', (data, isBinary) => onMessage(ws, data, isBinary));
        ws.on('close', () => {
            if (viewer !== ws) return;
            viewer = null;
            status.via = '';
            stream.stop();
            status.streaming = false;
            emit();
            // Wirtualny monitor znika po chwili bez telefonu (krótkie rozłączenie kabla go nie zamyka)
            clearTimeout(idleTimer);
            idleTimer = setTimeout(stopAll, 20000);
        });
    }

    return { attach, stopAll, status: () => ({ ...status }) };
}

module.exports = { createSession };
