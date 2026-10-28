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

## Windows

Windows nie tworzy monitorów „na życzenie”, więc telefon jest **prawdziwym dodatkowym monitorem** dopiero po zainstalowaniu
sterownika wirtualnego monitora ([Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver), open source, podpisany):

1. W oknie Pitayas Screen kliknij **Zainstaluj wirtualny monitor** (pobiera ≈70 MB, raz) i zatwierdź okno z uprawnieniami administratora.
2. W *Ustawienia → System → Ekran* pojawi się dodatkowy monitor — ustawisz go jak każdy inny (rozszerz, pozycja, skala).
3. Pitayas Screen sam ustawi mu rozdzielczość najbliższą ekranowi telefonu (lista zawiera popularne telefony i tablety).

Bez sterownika telefon pokazuje tylko kopię wybranego monitora. Obraz: FFmpeg (pobiera się sam) z koderem NVIDIA / Intel / AMD albo x264,
przechwytywanie Desktop Duplication (`ddagrab`) z automatycznym powrotem do `gdigrab`. iPhone na Windowsie wymaga aplikacji **Apple Devices** (albo iTunes).
