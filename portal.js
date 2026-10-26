// ═══════ PITAYAS SCREEN — PORTAL (Wayland: GNOME, KDE) ═══════
// xdg-desktop-portal: RemoteDesktop + ScreenCast z typem „virtual” = system tworzy NOWY monitor,
// a my dostajemy jego obraz (PipeWire) i możemy sterować myszą/klawiaturą na nim.
// Pierwsze uruchomienie pokazuje systemowe okno zgody; restore_token pamięta zgodę na następne razy.
const dbus = require('dbus-next');
const { Variant, Message } = dbus;

const DEST = 'org.freedesktop.portal.Desktop';
const PATH = '/org/freedesktop/portal/desktop';
const BTN = { left: 0x110, right: 0x111, middle: 0x112 };   // kody evdev

let tokenSeq = 0;
const token = () => `pitayas${process.pid}_${++tokenSeq}`;

async function createPortal({ log }) {
    const bus = dbus.sessionBus();
    const obj = await bus.getProxyObject(DEST, PATH);
    const rd = obj.getInterface('org.freedesktop.portal.RemoteDesktop');
    const sc = obj.getInterface('org.freedesktop.portal.ScreenCast');
    const sender = bus.name.slice(1).replace(/\./g, '_');

    // Odpowiedź portalu przychodzi sygnałem Request.Response na ścieżce zależnej od naszego tokenu
    const waiting = new Map();
    await bus.call(new Message({
        destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch',
        signature: 's', body: ["type='signal',interface='org.freedesktop.portal.Request',member='Response'"],
    }));
    bus.on('message', (msg) => {
        if (msg.interface !== 'org.freedesktop.portal.Request' || msg.member !== 'Response') return;
        const w = waiting.get(msg.path);
        if (!w) return;
        waiting.delete(msg.path);
        const [code, results] = msg.body;
        if (code === 0) w.resolve(results);
        else w.reject(new Error(code === 1 ? 'Odmówiono udostępnienia ekranu' : 'Portal przerwał udostępnianie'));
    });
    function request(call) {
        const t = token();
        const path = `/org/freedesktop/portal/desktop/request/${sender}/${t}`;
        return new Promise((resolve, reject) => {
            waiting.set(path, { resolve, reject });
            call(t).catch((err) => { waiting.delete(path); reject(err); });
        });
    }
    const val = (v) => (v && v.value !== undefined ? v.value : v);

    let session = null, streamNode = 0, streamSize = [1920, 1080];

    async function start({ restoreToken }) {
        const created = await request((t) => rd.CreateSession({ handle_token: new Variant('s', t), session_handle_token: new Variant('s', token()) }));
        session = val(created.session_handle);
        const devOpts = { handle_token: null, types: new Variant('u', 3), persist_mode: new Variant('u', 2) };   // klawiatura + wskaźnik
        if (restoreToken) devOpts.restore_token = new Variant('s', restoreToken);
        await request((t) => { devOpts.handle_token = new Variant('s', t); return rd.SelectDevices(session, devOpts); });
        await request((t) => sc.SelectSources(session, {
            handle_token: new Variant('s', t), types: new Variant('u', 4), multiple: new Variant('b', false), cursor_mode: new Variant('u', 2),
        }));
        const started = await request((t) => rd.Start(session, '', { handle_token: new Variant('s', t) }));
        const streams = val(started.streams) || [];
        if (!streams.length) throw new Error('Portal nie utworzył wirtualnego ekranu');
        streamNode = streams[0][0];
        const props = streams[0][1] || {};
        if (props.size) streamSize = val(props.size);
        log.info(`Wirtualny ekran: węzeł PipeWire ${streamNode}`);
        return { node: streamNode, restoreToken: val(started.restore_token) || restoreToken || '' };
    }

    async function stop() {
        if (!session) return;
        try {
            const s = await bus.getProxyObject(DEST, session);
            await s.getInterface('org.freedesktop.portal.Session').Close();
        } catch {}
        session = null;
    }

    // ───── Sterowanie (x, y w pikselach wirtualnego ekranu) ─────
    const safe = (p) => p.catch(() => {});
    return {
        start, stop,
        // Nowe połączenie z PipeWire dla każdego uruchomienia GStreamera
        openRemote: () => sc.OpenPipeWireRemote(session, {}),
        node: () => streamNode,
        active: () => Boolean(session),
        setSize: (w, h) => { streamSize = [w, h]; },
        move: (x, y) => session && safe(rd.NotifyPointerMotionAbsolute(session, {}, streamNode, x, y)),
        button: (name, down) => session && safe(rd.NotifyPointerButton(session, {}, BTN[name] || BTN.left, down ? 1 : 0)),
        scroll: (dx, dy) => session && safe(rd.NotifyPointerAxis(session, { finish: new Variant('b', true) }, dx, dy)),
        keysym: (sym, down) => session && safe(rd.NotifyKeyboardKeysym(session, {}, sym, down ? 1 : 0)),
        close: () => { stop(); bus.disconnect(); },
    };
}

module.exports = { createPortal };
