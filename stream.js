// ═══════ PITAYAS SCREEN — OBRAZ ═══════
// GStreamer: PipeWire (wirtualny ekran) → H.264 (koder sprzętowy, jeśli jest) → stdout.
// Tutaj dzielimy strumień na klatki i zamieniamy na format dla WebCodecs w telefonie (avcC + długości NAL).
const { spawn, execFileSync } = require('child_process');

// Klatka kluczowa co 30 klatek = co sekundę (stałe 30 kl/s z videorate — pusty pulpit też daje klatki, więc obraz pojawia się od razu)
// Kolejność: NVIDIA, VA-API (Intel/AMD), x264, OpenH264. Pierwszy, który działa na tym komputerze, wygrywa.
const ENCODERS = [
    { id: 'nvh264enc', label: 'NVIDIA (sprzętowy)', pipe: (kbps) => `nvh264enc bitrate=${kbps} gop-size=30 bframes=0 zerolatency=true rc-mode=cbr` },
    { id: 'vah264enc', label: 'VA-API (sprzętowy)', pipe: (kbps) => `vah264enc bitrate=${kbps} key-int-max=30 b-frames=0 rate-control=cbr target-usage=7` },
    { id: 'x264enc', label: 'x264 (procesor)', pipe: (kbps) => `x264enc tune=zerolatency speed-preset=ultrafast bitrate=${kbps} key-int-max=30` },
    { id: 'openh264enc', label: 'OpenH264 (procesor)', pipe: (kbps) => `openh264enc bitrate=${kbps * 1000} gop-size=30 complexity=low rate-control=bitrate` },
];

function detectEncoders() {
    const ok = [];
    for (const e of ENCODERS) {
        try {
            execFileSync('gst-launch-1.0', ['-q', 'videotestsrc', 'num-buffers=2', '!', 'video/x-raw,width=640,height=360', '!', 'videoconvert', '!',
                ...e.pipe(4000).split(' '), '!', 'fakesink'], { timeout: 8000, stdio: 'ignore' });
            ok.push(e);
        } catch {}
    }
    return ok;
}

// Annex B → pojedyncze NAL-e. Ostatni (może niepełny) zostaje w „rest” do następnego kawałka.
function splitNals(buf) {
    const starts = [];   // [początek kodu startowego, początek NAL-a]
    for (let i = 0; i + 3 <= buf.length; i++) {
        if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
        if (buf[i + 2] === 1) { starts.push([i, i + 3]); i += 2; }
        else if (buf[i + 2] === 0 && i + 3 < buf.length && buf[i + 3] === 1) { starts.push([i, i + 4]); i += 3; }
    }
    const nals = [];
    for (let k = 0; k + 1 < starts.length; k++) nals.push(buf.subarray(starts[k][1], starts[k + 1][0]));
    const rest = starts.length ? buf.subarray(starts[starts.length - 1][0]) : buf;
    return { nals, rest };
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

function createStream({ log, onConfig, onFrame, onExit }) {
    let child = null, pending = Buffer.alloc(0), sps = null, pps = null, au = [], key = false, lastConfig = '';

    function flushAu() {
        if (!au.length) return;
        const parts = [];
        for (const n of au) { const len = Buffer.alloc(4); len.writeUInt32BE(n.length); parts.push(len, n); }
        onFrame(key, Buffer.concat(parts));
        au = []; key = false;
    }

    function handleNal(n) {
        const type = n[0] & 0x1f;
        if (type === 7) { flushAu(); sps = Buffer.from(n); return; }
        if (type === 8) {
            pps = Buffer.from(n);
            const cfg = `${sps && sps.toString('hex')}|${pps.toString('hex')}`;
            if (sps && cfg !== lastConfig) {
                lastConfig = cfg;
                const desc = Buffer.concat([Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 255]), sps,
                    Buffer.from([1, pps.length >> 8, pps.length & 255]), pps]);
                onConfig({ codec: `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`, description: desc.toString('base64') });
            }
            return;
        }
        if (type === 9) { flushAu(); return; }          // AUD = granica klatki
        if (type === 1 || type === 5) {
            // Jeden kawałek (slice) na klatkę — tak pracują te kodery przy niskich opóźnieniach
            if (type === 5) key = true;
            au.push(Buffer.from(n));
            // Klatka z jednym kawałkiem jest kompletna — wysyłamy od razu (bez czekania na następną)
            flushAu();
            return;
        }
        if (type === 6) au.push(Buffer.from(n));          // SEI
    }

    function start({ fd, node, width, height, fps = 30, kbps = 12000, encoder, source, exact = false }) {
        stop();
        lastConfig = '';
        const enc = encoder.pipe(kbps);
        // source: zamiennik PipeWire do testów (np. videotestsrc)
        // Bez fd: aplikacja nie jest w piaskownicy, więc łączy się z PipeWire użytkownika bezpośrednio po numerze węzła
        const src = source || `pipewiresrc${fd == null ? '' : ' fd=3'} path=${node} do-timestamp=true keepalive-time=1000 always-copy=true`;
        // exact: prosimy system o monitor dokładnie w rozmiarze telefonu (bez czarnych pasów)
        const pipeline = `${src}${exact ? ` ! video/x-raw,width=${width},height=${height}` : ''} ! videorate ! video/x-raw,framerate=${fps}/1 `
            + `! videoconvert ! videoscale add-borders=true ! video/x-raw,width=${width},height=${height},pixel-aspect-ratio=1/1 `
            + `! ${enc} ! h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream,alignment=au ! fdsink fd=1 sync=false`;
        log.info(`GStreamer: ${pipeline}`);
        child = spawn('gst-launch-1.0', ['-q', ...pipeline.split(' ')], { stdio: ['ignore', 'pipe', 'pipe', fd == null ? 'ignore' : fd] });
        let err = '';
        child.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
        child.stdout.on('data', (chunk) => {
            const { nals, rest } = splitNals(pending.length ? Buffer.concat([pending, chunk]) : chunk);
            pending = Buffer.from(rest);
            nals.forEach(handleNal);
        });
        const me = child;
        child.on('exit', (code) => {
            if (me !== child) return;
            child = null;
            if (code) log.warn(`GStreamer zakończył się kodem ${code}: ${err.trim().split('\n').pop()}`);
            onExit && onExit(code, err);
        });
    }

    function stop() {
        if (!child) return;
        const c = child;
        child = null;
        c.kill('SIGTERM');
        setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 1500);
        pending = Buffer.alloc(0); au = []; key = false;
    }

    return { start, stop, running: () => Boolean(child), lastConfig: () => lastConfig };
}

module.exports = { createStream, detectEncoders, ENCODERS };
