// ═══════ PITAYAS SCREEN (Windows) — OBRAZ PRZEZ FFMPEG ═══════
// Przechwytywanie monitora → skalowanie do ekranu telefonu → H.264 (Annex B) na stdout.
//  • ddagrab  — Desktop Duplication (GPU), dużo szybszy i płynniejszy; wymaga FFmpeg 6+ i numeru wyjścia DXGI monitora,
//  • gdigrab  — starszy, wolniejszy, ale zawsze działa i bierze monitor po współrzędnych pulpitu (zapas).
// dump_extra dokleja SPS/PPS do każdej klatki kluczowej — telefon może dołączyć w dowolnej chwili.
const { execFileSync, spawnSync } = require('child_process');

// args(kbps, heavy): heavy = bardzo duży obraz → koder procesorowy dostaje szybszy preset.
// Profil High: wyraźnie lepszy obraz przy tym samym bitrate niż Baseline. Wszystkie koderki sprawdzamy próbnym uruchomieniem,
// więc opcja, której dany sterownik nie zna, po prostu wyłączy ten koder (zostaje następny).
const ENCODERS = [
    { id: 'h264_nvenc', label: 'NVIDIA NVENC (sprzętowy)', args: (k) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-profile:v', 'high', '-rc', 'cbr', '-b:v', `${k}k`, '-maxrate', `${k}k`, '-bufsize', `${Math.round(k / 2)}k`, '-spatial-aq', '1', '-zerolatency', '1'] },
    { id: 'h264_qsv', label: 'Intel Quick Sync (sprzętowy)', args: (k) => ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-profile:v', 'high', '-look_ahead', '0', '-b:v', `${k}k`, '-maxrate', `${k}k`] },
    { id: 'h264_amf', label: 'AMD AMF (sprzętowy)', args: (k) => ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-quality', 'balanced', '-profile:v', 'high', '-rc', 'cbr', '-b:v', `${k}k`] },
    { id: 'libx264', label: 'x264 (procesor)', args: (k, heavy) => ['-c:v', 'libx264', '-preset', heavy ? 'ultrafast' : 'superfast', '-tune', 'zerolatency', '-profile:v', 'high', '-x264-params', 'sliced-threads=0', '-b:v', `${k}k`, '-maxrate', `${k}k`, '-bufsize', `${Math.round(k / 2)}k`] },
];

// Który koder działa na tym komputerze (sterowniki karty graficznej) — krótka próba na obrazie testowym
function detectEncoders(ffmpeg) {
    if (!ffmpeg) return [];
    const ok = [];
    for (const e of ENCODERS) {
        try {
            execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-frames:v', '3',
                '-pix_fmt', 'yuv420p', ...e.args(4000), '-f', 'null', '-'], { timeout: 15000, stdio: 'ignore', windowsHide: true });
            ok.push(e);
        } catch {}
    }
    return ok;
}

// ───── ddagrab: który numer wyjścia DXGI to nasz monitor ─────
// Sprawdzamy kolejne wyjścia (0…5) i porównujemy rozmiar obrazu z rozmiarem monitora. Gdy pasuje dokładnie jedno — mamy numer;
// przy dwóch takich samych monitorach nie zgadujemy (użyjemy gdigrab).
const outputCache = new Map();
function ddagrabOutput(ffmpeg, mon) {
    const key = `${mon.device}|${mon.w}x${mon.h}`;
    if (outputCache.has(key)) return outputCache.get(key);
    const sizes = [];
    for (let idx = 0; idx < 6; idx++) {
        const r = spawnSync(ffmpeg, ['-hide_banner', '-f', 'lavfi', '-i', `ddagrab=output_idx=${idx}:framerate=5`, '-frames:v', '1', '-f', 'null', '-'],
            { encoding: 'utf8', timeout: 10000, windowsHide: true });
        const m = /Video:[^\n]*?,\s*(\d{3,5})x(\d{3,5})/.exec(`${r.stderr || ''}`);
        if (r.status !== 0 || !m) break;   // brak takiego wyjścia (albo FFmpeg bez ddagrab)
        sizes.push([idx, Number(m[1]), Number(m[2])]);
    }
    const same = sizes.filter(([, w, h]) => w === mon.w && h === mon.h);
    const out = same.length === 1 ? same[0][0] : null;
    outputCache.set(key, out);
    return out;
}

// Lista sposobów przechwycenia do wypróbowania po kolei: najpierw szybki, potem zapasowy
function backendsFor(ffmpeg, mon) {
    const list = [];
    try {
        const idx = ddagrabOutput(ffmpeg, mon);
        if (idx !== null) list.push({ name: 'ddagrab', outputIdx: idx });
    } catch {}
    list.push({ name: 'gdigrab' });
    return list;
}

function ffmpegArgs({ mon, width, height, fps = 30, kbps, encoder, backend = { name: 'gdigrab' } }) {
    // bicubic przy zmniejszaniu daje ostrzejszy tekst niż domyślny bilinear; pad tylko na wypadek różnicy proporcji
    const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
    const heavy = width * height > 2300000;
    const input = backend.name === 'ddagrab'
        ? ['-filter_complex', `ddagrab=output_idx=${backend.outputIdx}:framerate=${fps}:draw_mouse=1,hwdownload,format=bgra,${fit},format=yuv420p`]
        : ['-fflags', 'nobuffer', '-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '1',
            '-offset_x', String(mon.x), '-offset_y', String(mon.y), '-video_size', `${mon.w}x${mon.h}`, '-i', 'desktop',
            '-vf', `${fit},format=yuv420p`];
    return ['-hide_banner', '-loglevel', 'error', ...input, ...encoder.args(kbps, heavy), '-g', String(fps), '-bf', '0', '-bsf:v', 'dump_extra', '-f', 'h264', 'pipe:1'];
}

module.exports = { ENCODERS, detectEncoders, backendsFor, ffmpegArgs };
