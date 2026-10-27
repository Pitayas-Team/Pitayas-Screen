// ═══════ PITAYAS SCREEN (Windows) — OBRAZ PRZEZ FFMPEG ═══════
// gdigrab: wybrany monitor (współrzędne pulpitu) → skalowanie do ekranu telefonu → H.264 (Annex B) na stdout.
// dump_extra dokleja SPS/PPS do każdej klatki kluczowej — telefon może dołączyć w dowolnej chwili.
const { execFileSync } = require('child_process');

const ENCODERS = [
    { id: 'h264_nvenc', label: 'NVIDIA NVENC (sprzętowy)', args: (k) => ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-rc', 'cbr', '-b:v', `${k}k`] },
    { id: 'h264_qsv', label: 'Intel Quick Sync (sprzętowy)', args: (k) => ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-look_ahead', '0', '-b:v', `${k}k`, '-maxrate', `${k}k`] },
    { id: 'h264_amf', label: 'AMD AMF (sprzętowy)', args: (k) => ['-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-quality', 'speed', '-rc', 'cbr', '-b:v', `${k}k`] },
    { id: 'libx264', label: 'x264 (procesor)', args: (k) => ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-x264-params', 'sliced-threads=0', '-b:v', `${k}k`, '-maxrate', `${k}k`, '-bufsize', `${Math.round(k / 2)}k`] },
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

function ffmpegArgs({ mon, width, height, fps = 30, kbps, encoder }) {
    return ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer',
        '-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '1',
        '-offset_x', String(mon.x), '-offset_y', String(mon.y), '-video_size', `${mon.w}x${mon.h}`, '-i', 'desktop',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
        ...encoder.args(kbps), '-g', String(fps), '-bf', '0', '-bsf:v', 'dump_extra', '-f', 'h264', 'pipe:1'];
}

module.exports = { ENCODERS, detectEncoders, ffmpegArgs };
