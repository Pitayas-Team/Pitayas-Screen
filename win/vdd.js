// ═══════ PITAYAS SCREEN (Windows) — WIRTUALNY MONITOR ═══════
// Windows nie umie tworzyć monitorów „na życzenie” (jak portal na Linuksie), więc potrzebny jest sterownik:
// Virtual Display Driver (VirtualDrivers/Virtual-Display-Driver, open source, podpisany). Po instalacji w Ustawienia → System → Ekran
// pojawia się prawdziwy dodatkowy monitor — można go rozszerzać, przesuwać i ustawiać jak każdy inny. Pitayas Screen pokazuje go na telefonie.
//
// Instalacja: pobranie paczki (≈70 MB, raz) → rozpakowanie sterownika i devcon.exe → jeden skrypt z uprawnieniami administratora
// (jedno okno UAC), który zapisuje listę rozdzielczości, instaluje urządzenie Root\MttVDD i uruchamia je ponownie.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { download } = require('./tools');

const API = 'https://api.github.com/repos/VirtualDrivers/Virtual-Display-Driver/releases/latest';
const FALLBACK = 'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VDD.Control.25.7.23.zip';
const SETTINGS_DIR = 'C:\\VirtualDisplayDriver';
const HWID = 'Root\\MttVDD';

// Rozdzielczości, które sterownik ma udostępniać (obie orientacje). Telefon prosi o swój rozmiar, a Pitayas Screen wybiera
// najbliższy z tej listy — dlatego są tu popularne telefony i tablety (iPad, Galaxy Tab…) oraz zwykłe rozdzielczości monitorów.
const LANDSCAPE = [
    [1280, 720], [1280, 800], [1366, 768], [1440, 900], [1600, 900], [1680, 1050], [1920, 1080], [1920, 1200], [2000, 1200], [2048, 1536],
    [2160, 1620], [2266, 1488], [2360, 1640], [2388, 1668], [2560, 1440], [2560, 1600], [2732, 2048], [2800, 1752], [2960, 1848], [3840, 2160],
    [2340, 1080], [2400, 1080], [2412, 1080], [2532, 1170], [2556, 1179], [2622, 1206], [2640, 1200], [2778, 1284], [2796, 1290], [2960, 1344], [3120, 1440], [3200, 1440],
];
const RESOLUTIONS = [...new Set(LANDSCAPE.flatMap(([w, h]) => [`${w}x${h}`, `${h}x${w}`]))].map((r) => r.split('x').map(Number));

function settingsXml() {
    const res = RESOLUTIONS.map(([w, h]) => `        <resolution>\n            <width>${w}</width>\n            <height>${h}</height>\n            <refresh_rate>60</refresh_rate>\n        </resolution>`).join('\n');
    return `<?xml version='1.0' encoding='utf-8'?>
<vdd_settings>
    <monitors>
        <count>1</count>
    </monitors>
    <gpu>
        <friendlyname>default</friendlyname>
    </gpu>
    <global>
        <g_refresh_rate>60</g_refresh_rate>
        <g_refresh_rate>90</g_refresh_rate>
        <g_refresh_rate>120</g_refresh_rate>
    </global>
    <resolutions>
${res}
    </resolutions>
    <options>
        <CustomEdid>false</CustomEdid>
        <PreventSpoof>false</PreventSpoof>
        <EdidCeaOverride>false</EdidCeaOverride>
        <HardwareCursor>true</HardwareCursor>
        <SDR10bit>false</SDR10bit>
        <HDRPlus>false</HDRPlus>
        <logging>false</logging>
        <debuglogging>false</debuglogging>
    </options>
</vdd_settings>
`;
}

const q = (s) => String(s).replace(/'/g, "''");   // tekst w apostrofach PowerShella
const sh = (file, args, opts = {}) => new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 600000, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(String(stdout)))));

function createVdd({ dataDir, log, portal, onStatus }) {
    const root = path.join(dataDir, 'tools', 'vdd');
    const say = (t) => { log.info(`VDD: ${t}`); onStatus && onStatus(t); };
    let busy = false;

    async function assetUrl() {
        try {
            const r = await fetch(API, { headers: { 'User-Agent': 'Pitayas-Screen', Accept: 'application/vnd.github+json' } });
            const j = await r.json();
            const a = (j.assets || []).find((x) => /^VDD\.Control.*\.zip$/i.test(x.name));
            if (a && a.browser_download_url) return a.browser_download_url;
        } catch {}
        return FALLBACK;
    }

    const driverDir = () => path.join(root, 'SignedDrivers', process.arch === 'arm64' ? 'ARM64' : 'x86', 'VDD');   // „x86” w paczce to sterownik 64-bitowy
    const devcon = () => path.join(root, 'Dependencies', 'devcon.exe');
    const filesReady = () => ['MttVDD.inf', 'MttVDD.dll', 'mttvdd.cat'].every((f) => fs.existsSync(path.join(driverDir(), f))) && fs.existsSync(devcon());

    // Pobranie i rozpakowanie samego sterownika i devcon.exe (paczka ma też duży program „VDD Control”, którego nie potrzebujemy)
    async function ensureFiles() {
        if (filesReady()) return;
        fs.mkdirSync(root, { recursive: true });
        const zip = path.join(root, 'vdd.zip');
        say('Pobieram sterownik wirtualnego monitora…');
        await download(await assetUrl(), zip, (p) => say(`Pobieram sterownik wirtualnego monitora — ${p}%`));
        say('Rozpakowuję sterownik…');
        const arch = process.arch === 'arm64' ? 'ARM64' : 'x86';
        await sh('tar', ['-xf', zip, '-C', root, `SignedDrivers/${arch}/VDD`, 'Dependencies/devcon.exe'], { cwd: root });
        fs.rmSync(zip, { force: true });
        if (!filesReady()) throw new Error('Paczka sterownika ma nieoczekiwaną zawartość — spróbuj jeszcze raz');
    }

    // Uruchamia skrypt PowerShella z uprawnieniami administratora (okno UAC) i zwraca tekst, który skrypt zapisał do pliku wyniku
    async function runElevated(body, name) {
        fs.mkdirSync(root, { recursive: true });
        const script = path.join(root, `${name}.ps1`);
        const result = path.join(root, `${name}.result.txt`);
        fs.rmSync(result, { force: true });
        const text = `$ErrorActionPreference = 'Continue'
$result = '${q(result)}'
function Done($msg, $code) { $msg | Set-Content -LiteralPath $result -Encoding UTF8; exit $code }
try {
${body}
} catch { Done ("Błąd: " + $_) 3 }
Done 'OK' 0
`;
        fs.writeFileSync(script, `\ufeff${text}`, 'utf8');   // BOM: PowerShell 5.1 inaczej źle czyta polskie znaki
        const cmd = `try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $env:PITAYAS_PS1 + '"')); exit $p.ExitCode } catch { exit 99 }`;
        let code = 0;
        try { await sh('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { env: { ...process.env, PITAYAS_PS1: script } }); }
        catch (e) { code = e.code || 1; }
        if (code === 99 || !fs.existsSync(result)) throw new Error('Nie zatwierdzono uprawnień administratora (okno UAC) — spróbuj jeszcze raz');
        const out = fs.readFileSync(result, 'utf8').replace(/^\ufeff/, '').trim();
        if (out !== 'OK') throw new Error(out || 'Instalacja nie powiodła się');
    }

    const hasMonitor = async () => (await portal.monitors()).some((m) => require('./portal').isVirtual(m));
    async function waitForMonitor(ms) {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await hasMonitor()) return true; await new Promise((r) => setTimeout(r, 1000)); }
        return false;
    }

    async function status() {
        const installed = (await portal.vddCount()) > 0;
        return { installed, monitor: await hasMonitor(), busy };
    }

    async function install() {
        if (busy) throw new Error('Trwa już instalacja');
        busy = true;
        try {
            await ensureFiles();
            const xml = path.join(root, 'vdd_settings.xml');
            fs.writeFileSync(xml, settingsXml(), 'utf8');
            say('Instaluję sterownik — zatwierdź okno z pytaniem o uprawnienia administratora…');
            await runElevated(`
$drv = '${q(driverDir())}'; $devcon = '${q(devcon())}'; $xml = '${q(xml)}'
New-Item -ItemType Directory -Force -Path '${q(SETTINGS_DIR)}' | Out-Null
Copy-Item -LiteralPath $xml -Destination '${q(SETTINGS_DIR)}\\vdd_settings.xml' -Force
& $devcon remove '${HWID}' | Out-Null
$out = (& $devcon install (Join-Path $drv 'MttVDD.inf') '${HWID}' 2>&1 | Out-String)
$code = $LASTEXITCODE
if ($code -ne 0 -and $code -ne 1) { Done ("devcon install, kod " + $code + ": " + $out) 2 }
# Instalator potrafi nadpisać ustawienia domyślnymi — zapisujemy naszą listę jeszcze raz i uruchamiamy urządzenie ponownie
Copy-Item -LiteralPath $xml -Destination '${q(SETTINGS_DIR)}\\vdd_settings.xml' -Force
& $devcon restart '${HWID}' | Out-Null`, 'install-vdd');
            say('Czekam na pojawienie się monitora…');
            let ok = await waitForMonitor(8000);
            if (!ok) {   // monitor bywa dodany, ale nie włączony do pulpitu — „Rozszerz te ekrany”
                try { await sh('DisplaySwitch.exe', ['/extend'], { timeout: 15000 }); } catch {}
                ok = await waitForMonitor(10000);
            }
            say(ok ? 'Wirtualny monitor jest gotowy' : 'Sterownik zainstalowany, ale monitor się nie pojawił — uruchom ponownie komputer albo kliknij „Włącz monitor”');
            return { ok, installed: true };
        } finally { busy = false; }
    }

    async function uninstall() {
        if (busy) throw new Error('Trwa inna operacja');
        busy = true;
        try {
            await ensureFiles();
            say('Usuwam sterownik — zatwierdź okno z pytaniem o uprawnienia administratora…');
            await runElevated(`& '${q(devcon())}' remove '${HWID}' | Out-Null`, 'remove-vdd');
            say('Wirtualny monitor usunięty');
        } finally { busy = false; }
    }

    // „Rozszerz te ekrany” — gdy sterownik jest, ale Windows pokazuje monitor jako zduplikowany albo wyłączony
    async function extend() {
        await sh('DisplaySwitch.exe', ['/extend'], { timeout: 15000 });
        return waitForMonitor(10000);
    }

    return { status, install, uninstall, extend };
}

module.exports = { createVdd, settingsXml, RESOLUTIONS };
