# ═══════ PITAYAS SCREEN (Windows) — POMOCNIK SYSTEMOWY ═══════
# Jeden proces PowerShell na cały czas działania aplikacji. Polecenia przychodzą liniami na stdin:
#   m X Y          kursor w punkt (piksele pulpitu)
#   b l|r 1|0      przycisk myszy wciśnięty / puszczony
#   w DY DX        kółko (120 = jeden ząbek)
#   c KOD          znak Unicode
#   k VK           klawisz (kod wirtualny Windows)
#   mon            lista monitorów (JSON, jedna linia)
#   modes DEV      lista rozdzielczości monitora DEV (JSON [[w,h],…])
#   vdd            ile urządzeń „Virtual Display Driver” jest w systemie (0 = sterownik niezainstalowany)
#   mode DEV W H   ustaw rozdzielczość monitora DEV (np. \\.\DISPLAY2); odpowiedź: 0 = OK, -1 = brak takiego trybu
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class PitayasHost {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, int data, UIntPtr extra);

    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DEVMODE {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra; public int dmFields;
        public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
        public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight; public int dmDisplayFlags; public int dmDisplayFrequency;
        public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DISPLAY_DEVICE {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string dev, uint i, ref DISPLAY_DEVICE dd, uint flags);

    // Współrzędne w prawdziwych pikselach na każdym monitorze (bez skalowania DPI Windowsa)
    public static void Init() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {} }

    public static void Move(int x, int y) { SetCursorPos(x, y); }
    public static void Button(bool right, bool down) {
        uint f = right ? (down ? 0x0008u : 0x0010u) : (down ? 0x0002u : 0x0004u);
        mouse_event(f, 0, 0, 0, UIntPtr.Zero);
    }
    public static void Wheel(int dy, int dx) {
        if (dy != 0) mouse_event(0x0800, 0, 0, dy, UIntPtr.Zero);
        if (dx != 0) mouse_event(0x1000, 0, 0, dx, UIntPtr.Zero);
    }
    static void Key(ushort vk, ushort scan, uint flags) {
        INPUT[] i = new INPUT[1];
        i[0].type = 1; i[0].u.ki.wVk = vk; i[0].u.ki.wScan = scan; i[0].u.ki.dwFlags = flags;
        SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }
    public static void Char(int cp) {
        foreach (char c in char.ConvertFromUtf32(cp)) { Key(0, c, 4); Key(0, c, 4 | 2); }   // KEYEVENTF_UNICODE (+ KEYUP)
    }
    public static void Vk(ushort vk) { Key(vk, 0, 0); Key(vk, 0, 2); }

    static string Esc(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }
    public static string Monitors() {
        StringBuilder sb = new StringBuilder("[");
        DISPLAY_DEVICE dd = new DISPLAY_DEVICE(); dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
        bool first = true;
        for (uint i = 0; EnumDisplayDevices(null, i, ref dd, 0); i++) {
            if ((dd.StateFlags & 1) == 0) { dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE)); continue; }   // tylko podłączone do pulpitu
            DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
            if (EnumDisplaySettings(dd.DeviceName, -1, ref dm)) {
                // Sam monitor podłączony do tego wyjścia: nazwa i identyfikator (wirtualny monitor poznajemy po nich pewniej niż po nazwie karty)
                DISPLAY_DEVICE md = new DISPLAY_DEVICE(); md.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
                string mname = "", mid = "";
                if (EnumDisplayDevices(dd.DeviceName, 0, ref md, 0)) { mname = md.DeviceString; mid = md.DeviceID; }
                if (!first) sb.Append(",");
                first = false;
                sb.AppendFormat("{{\"device\":\"{0}\",\"adapter\":\"{1}\",\"monitor\":\"{7}\",\"monitorId\":\"{8}\",\"primary\":{2},\"x\":{3},\"y\":{4},\"w\":{5},\"h\":{6}}}",
                    Esc(dd.DeviceName), Esc(dd.DeviceString), (dd.StateFlags & 4) != 0 ? "true" : "false", dm.dmPositionX, dm.dmPositionY, dm.dmPelsWidth, dm.dmPelsHeight, Esc(mname), Esc(mid));
            }
            dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
        }
        return sb.Append("]").ToString();
    }
    // Lista rozdzielczości, które monitor obsługuje: [[w,h],…]
    public static string Modes(string dev) {
        DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        System.Collections.Generic.HashSet<string> seen = new System.Collections.Generic.HashSet<string>();
        StringBuilder sb = new StringBuilder("[");
        bool first = true;
        for (int i = 0; EnumDisplaySettings(dev, i, ref dm); i++) {
            string k = dm.dmPelsWidth + "x" + dm.dmPelsHeight;
            if (!seen.Add(k)) continue;
            if (!first) sb.Append(",");
            first = false;
            sb.AppendFormat("[{0},{1}]", dm.dmPelsWidth, dm.dmPelsHeight);
        }
        return sb.Append("]").ToString();
    }
    // Ustawia rozdzielczość; spośród trybów o takim rozmiarze wybiera 60 Hz (albo najwyższą poniżej 60)
    public static int SetMode(string dev, int w, int h) {
        DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        int found = -1, bestScore = -1;
        for (int i = 0; EnumDisplaySettings(dev, i, ref dm); i++) {
            if (dm.dmPelsWidth != w || dm.dmPelsHeight != h) continue;
            int hz = dm.dmDisplayFrequency;
            int score = hz == 60 ? 1000 : (hz < 60 ? hz : 0);
            if (score > bestScore) { bestScore = score; found = i; }
        }
        if (found < 0) return -1;
        EnumDisplaySettings(dev, found, ref dm);
        dm.dmFields = 0x80000 | 0x100000 | 0x400000;   // DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY
        return ChangeDisplaySettingsEx(dev, ref dm, IntPtr.Zero, 0x1, IntPtr.Zero);   // CDS_UPDATEREGISTRY
    }
}
'@
[PitayasHost]::Init()
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
    $p = $line.Split(' ')
    try {
        switch ($p[0]) {
            'm' { [PitayasHost]::Move([int]$p[1], [int]$p[2]) }
            'b' { [PitayasHost]::Button($p[1] -eq 'r', $p[2] -eq '1') }
            'w' { [PitayasHost]::Wheel([int]$p[1], [int]$p[2]) }
            'c' { [PitayasHost]::Char([int]$p[1]) }
            'k' { [PitayasHost]::Vk([uint16]$p[1]) }
            'mon' { [Console]::Out.WriteLine([PitayasHost]::Monitors()); [Console]::Out.Flush() }
            'modes' { [Console]::Out.WriteLine([PitayasHost]::Modes($p[1])); [Console]::Out.Flush() }
            'vdd' {
                $n = @(Get-PnpDevice -Class Display -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains 'Root\MttVDD' }).Count
                [Console]::Out.WriteLine($n); [Console]::Out.Flush()
            }
            'mode' { [Console]::Out.WriteLine([PitayasHost]::SetMode($p[1], [int]$p[2], [int]$p[3])); [Console]::Out.Flush() }
        }
    } catch {
        if ($p[0] -eq 'mon' -or $p[0] -eq 'mode' -or $p[0] -eq 'modes' -or $p[0] -eq 'vdd') { [Console]::Out.WriteLine('-2'); [Console]::Out.Flush() }
    }
}
