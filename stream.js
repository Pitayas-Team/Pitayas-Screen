// ═══════ PITAYAS SCREEN — OBRAZ ═══════
// GStreamer: PipeWire (wirtualny ekran) → H.264 (koder sprzętowy, jeśli jest) → stdout.
// Tutaj dzielimy strumień na klatki i zamieniamy na format dla WebCodecs w telefonie (avcC + długości NAL).
const { spawn, execFileSync } = require('child_process');

// Klatka kluczowa co 30 klatek = co sekundę (stałe 30 kl/s z videorate — pusty pulpit też daje klatki, więc obraz pojawia się od razu)
// Kolejność: NVIDIA, VA-API (Intel/AMD), x264, OpenH264. Pierwszy, który działa na tym komputerze, wygrywa.
// pipe(kbps, gop, heavy): heavy = bardzo duży obraz (koder procesorowy dostaje szybszy preset, żeby utrzymać klatki)
const ENCODERS = [
    { id: 'nvh264enc', label: 'NVIDIA (sprzętowy)', pipe: (kbps, g = 30) => `nvh264enc bitrate=${kbps} gop-size=${g} bframes=0 zerolatency=true rc-mode=cbr` },
    { id: 'vah264enc', label: 'VA-API (sprzętowy)', pipe: (kbps, g = 30) => `vah264enc bitrate=${kbps} key-int-max=${g} b-frames=0 rate-control=cbr target-usage=4` },
    { id: 'x264enc', label: 'x264 (procesor)', pipe: (kbps, g = 30, heavy = false) => `x264enc tune=zerolatency sliced-threads=false speed-preset=${heavy ? 'ultrafast' : 'superfast'} bitrate=${kbps} key-int-max=${g}` },
    { id: 'openh264enc', label: 'OpenH264 (procesor)', pipe: (kbps, g = 30) => `openh264enc bitrate=${kbps * 1000} gop-size=${g} complexity=low rate-control=bitrate` },
];
// Profil High daje wyraźnie lepszy obraz przy tym samym bitrate (CABAC, 8×8). Używamy go, gdy koder go przyjmie.
const HIGH = 'video/x-h264,profile=high';
const SOFT = new Set(['x264enc', 'openh264enc']);   // kodery procesorowe

function detectEncoders() {
    const ok = [];
    const probe = (e, high) => {
        execFileSync('gst-launch-1.0', ['-q', 'videotestsrc', 'num-buffers=2', '!', 'video/x-raw,width=640,height=360', '!', 'videoconvert', '!',
            ...e.pipe(4000).split(' '), ...(high ? ['!', HIGH] : []), '!', 'fakesink'], { timeout: 8000, stdio: 'ignore' });
    };
    for (const e of ENCODERS) {
        try { probe(e, true); ok.push({ ...e, high: true }); continue; } catch {}
        try { probe(e, false); ok.push({ ...e, high: false }); } catch {}
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

    function start({ fd, node, width, height, fps = 30, kbps = 12000, encoder, source, exact = false, mon, ffmpeg }) {
        stop();
        lastConfig = '';
        if (process.platform === 'win32') return startWin({ mon, ffmpeg, width, height, fps, kbps, encoder });
        const heavy = width * height > 2200000;
        const enc = `${encoder.pipe(kbps, fps, heavy)}${encoder.high ? ` ! ${HIGH}` : ''}`;
        // source: zamiennik PipeWire do testów (np. videotestsrc)
        // Bez fd: aplikacja nie jest w piaskownicy, więc łączy się z PipeWire użytkownika bezpośrednio po numerze węzła
        const src = source || `pipewiresrc${fd == null ? '' : ' fd=3'} path=${node} do-timestamp=true keepalive-time=100 always-copy=true`;
        // exact: prosimy system o monitor dokładnie w rozmiarze telefonu (bez czarnych pasów)
        const pipeline = `${src}${exact ? ` ! video/x-raw,width=${width},height=${height}` : ''} ! videorate ! video/x-raw,framerate=${fps}/1 `
            + `! videoconvert ! videoscale add-borders=true ! video/x-raw,width=${width},height=${height},pixel-aspect-ratio=1/1 `
            + `! ${enc} ! h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream,alignment=au ! fdsink fd=1 sync=false`;
        log.info(`GStreamer: ${pipeline}`);
        child = spawn('gst-launch-1.0', ['-q', ...pipeline.split(' ')], { stdio: ['ignore', 'pipe', 'pipe', fd == null ? 'ignore' : fd] });
        attach(child);
    }

    // Windows: FFmpeg zamiast GStreamera — reszta (podział na klatki) bez zmian.
    // Sposoby przechwycenia próbujemy po kolei (szybki ddagrab, potem gdigrab): gdy pierwszy padnie, zanim da jakąkolwiek klatkę,
    // od razu startujemy następny, a telefon nic nie zauważa.
    function startWin({ mon, ffmpeg, width, height, fps, kbps, encoder }) {
        const capture = require('./win/capture');
        const backends = capture.backendsFor(ffmpeg, mon);
        let i = 0;
        const launch = () => {
            const backend = backends[i];
            const args = capture.ffmpegArgs({ mon, width, height, fps, kbps, encoder, backend });
            log.info(`FFmpeg (${backend.name}): ${args.join(' ')}`);
            child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            attach(child, i + 1 < backends.length ? () => { i++; log.warn(`Przechwytywanie ${backend.name} nie ruszyło — próbuję ${backends[i].name}`); pending = Buffer.alloc(0); launch(); } : null);
        };
        launch();
    }

    // retry: wywoływane zamiast onExit, gdy proces padł zanim wysłał pierwsze dane
    function attach(proc, retry = null) {
        let err = '', gotData = false;
        proc.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
        proc.stdout.on('data', (chunk) => {
            gotData = true;
            const { nals, rest } = splitNals(pending.length ? Buffer.concat([pending, chunk]) : chunk);
            pending = Buffer.from(rest);
            nals.forEach(handleNal);
        });
        proc.on('exit', (code) => {
            if (proc !== child) return;
            child = null;
            if (code && !gotData && retry) return retry();
            if (code) log.warn(`Koder zakończył się kodem ${code}: ${err.trim().split('\n').pop()}`);
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

module.exports = { createStream, detectEncoders, ENCODERS, SOFT };
