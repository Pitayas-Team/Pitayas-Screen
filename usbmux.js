// ═══════ PITAYAS SCREEN — iPHONE PO KABLU (usbmuxd) ═══════
// usbmuxd to systemowa usługa (ta sama, której używa iTunes / Finder): przez kabel USB otwiera połączenie TCP
// do portu NA iPhonie. Aplikacja Pitayas (0.2.5+) słucha tam lokalnie i przekazuje dane do modułu Screen.
// Bez Wi-Fi i bez hotspotu — tylko kabel. Telefon musi raz „zaufać” temu komputerowi.
const net = require('net');

const SOCKET = process.platform === 'win32' ? { port: 27015, host: '127.0.0.1' } : { path: '/var/run/usbmuxd' };
let tag = 0;

const xml = (o) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${Object.entries(o).map(([k, v]) => `<key>${k}</key>${typeof v === 'number' ? `<integer>${v}</integer>` : `<string>${v}</string>`}`).join('')}</dict></plist>`;

function packet(obj) {
    const body = Buffer.from(xml({ ClientVersionString: 'pitayas-screen', ProgName: 'Pitayas Screen', ...obj }), 'utf8');
    const head = Buffer.alloc(16);
    head.writeUInt32LE(16 + body.length, 0);
    head.writeUInt32LE(1, 4);    // wersja protokołu (plist)
    head.writeUInt32LE(8, 8);    // typ: plist
    head.writeUInt32LE(++tag, 12);
    return Buffer.concat([head, body]);
}

// Wyciąga proste pola z odpowiedzi plist (wystarczy nam kilka kluczy)
function field(text, key) {
    const m = text.match(new RegExp(`<key>${key}</key>\\s*<(string|integer)>([^<]*)</`));
    return m ? (m[1] === 'integer' ? Number(m[2]) : m[2]) : undefined;
}

// Czyta kolejne wiadomości usbmuxd z gniazda
function reader(sock, onMessage) {
    let buf = Buffer.alloc(0);
    const handler = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 16) {
            const len = buf.readUInt32LE(0);
            if (buf.length < len) return;
            const text = buf.subarray(16, len).toString('utf8');
            const rest = buf.subarray(len);
            buf = Buffer.alloc(0);
            if (onMessage(text, rest) === 'stop') return;
            buf = rest;
        }
    };
    sock.on('data', handler);
    return () => sock.off('data', handler);
}

// Obserwuje podłączanie iPhone'ów: onChange(Map(deviceId → { serial }))
function watchDevices(onChange, log) {
    const devices = new Map();
    let sock = null, closed = false;
    const connect = () => {
        if (closed) return;
        sock = net.connect(SOCKET);
        sock.on('connect', () => sock.write(packet({ MessageType: 'Listen' })));
        reader(sock, (text) => {
            const type = field(text, 'MessageType');
            if (type === 'Attached' && field(text, 'ConnectionType') === 'USB') {
                devices.set(field(text, 'DeviceID'), { serial: field(text, 'SerialNumber') || '' });
                onChange(devices);
            } else if (type === 'Detached') {
                devices.delete(field(text, 'DeviceID'));
                onChange(devices);
            }
        });
        sock.on('error', () => {});
        sock.on('close', () => {
            devices.clear(); onChange(devices);
            if (!closed) setTimeout(connect, 3000);   // usbmuxd startuje dopiero po podłączeniu iPhone'a
        });
    };
    connect();
    return () => { closed = true; if (sock) sock.destroy(); };
}

// Otwiera połączenie TCP do portu na iPhonie. Zwraca gniazdo, które od razu jest „rurą” do telefonu.
function connectDevice(deviceId, port) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(SOCKET);
        const fail = (err) => { sock.destroy(); reject(err); };
        sock.on('error', fail);
        sock.on('connect', () => sock.write(packet({ MessageType: 'Connect', DeviceID: deviceId, PortNumber: ((port & 0xff) << 8) | (port >> 8) })));
        const stop = reader(sock, (text, rest) => {
            const n = field(text, 'Number');
            stop();
            sock.off('error', fail);
            if (n !== 0) { fail(new Error(n === 3 ? 'Aplikacja Pitayas na iPhonie nie nasłuchuje (otwórz moduł Screen)' : `usbmuxd: błąd ${n}`)); return 'stop'; }
            if (rest.length) sock.unshift(rest);
            resolve(sock);
            return 'stop';
        });
    });
}

module.exports = { watchDevices, connectDevice };
