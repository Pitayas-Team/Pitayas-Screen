# Pitayas Screen

Telefon jako dodatkowy monitor komputera — tylko przez kabel USB.

- Komputer (Linux, Wayland: GNOME/KDE): portal systemowy tworzy wirtualny monitor, GStreamer koduje go do H.264 (NVIDIA / VA-API / x264 / OpenH264).
- Telefon: moduł **Pitayas Screen** w aplikacji Pitayas (0.2.5+) — obraz przez WebCodecs, dotyk jako mysz.
- **Android:** Debugowanie USB, tunel `adb reverse` robi aplikacja sama.
- **iPhone:** przez usbmuxd (ten sam kanał co Finder/iTunes), bez Wi-Fi i hotspotu.

Wymaga: `gst-launch-1.0` z `pipewiresrc` i koderem H.264, `adb` (Android), `usbmuxd` (iPhone).

```bash
npm install
npm start
```
