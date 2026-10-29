# Pitayas Screen – telefon jako dodatkowy monitor komputera (przez kabel USB)

> Plik przekazania projektu między narzędziami AI (Claude Code ⇄ Antigravity ⇄ inne).
> Przeczytaj go w całości, zanim cokolwiek zmienisz. **Nie ma tu żadnych sekretów** – hasła i klucze są poza repozytorium i nie wolno ich kopiować do kodu, logów ani rozmów.
> Stan na: 2026-10-29. Jeśli zmieniasz architekturę albo sposób wdrażania, zaktualizuj ten plik.

## 1. Czym to jest
Telefon lub tablet jako **dodatkowy monitor**. Komputer tworzy wirtualny ekran (Linux: portal systemowy; Windows: sterownik Virtual Display Driver), koduje go do H.264 i wysyła do modułu **Pitayas Screen** w aplikacji Pitayas; dotyk wraca jako mysz i klawiatura. Obraz idzie wyłącznie przez kabel USB (bez Wi-Fi).

## 2. Zasady od właściciela
- Telefon łączy się **tylko przez USB**; serwer słucha wyłącznie na `127.0.0.1:8195`.
- Jakość obrazu jest priorytetem: profil H.264 High, bitrate zależny od rozdzielczości, natywna rozdzielczość tabletu przy kodowaniu sprzętowym; koder procesorowy dostaje obraz ograniczony do ok. 2,3 Mpx.
- Na Windowsie telefon ma być **prawdziwym dodatkowym monitorem** (widocznym w ustawieniach Windows), a nie tylko lustrem.

## 3. Gdzie co leży i jak uruchamiać/wydawać
| Rzecz | Jak |
|---|---|
| Uruchomienie z kodu | `npm install`, `npm start` |
| Linux wymaga | `gst-launch-1.0` z `pipewiresrc` i koderem H.264, `adb` (Android), `usbmuxd` (iPhone), Wayland (GNOME/KDE) |
| Windows wymaga | FFmpeg i adb (pobierają się same do `%APPDATA%\Pitayas\Screen\tools`), sterownik wirtualnego monitora (przycisk w oknie), Apple Devices/iTunes dla iPhone'a |
| Wydanie | Pitayas Admin: `--targets linux-appimage,linux-rpm,win-nsis` (RPM wymaga `rpm-build`, EXE przez electron-builder) |

## 4. Struktura
```
main.js        okno, serwer 127.0.0.1:8195, ADB (adb reverse), iPhone (usbmux), stan dla okna, IPC wirtualnego monitora
session.js     łączy telefon z ekranem; PROTOKÓŁ w nagłówku (hello/pointer/scroll/text/key ↔ config + klatki H.264); bitrate, fps, limit rozmiaru
stream.js      Linux: GStreamer (pipewiresrc → koder → klatki Annex B → avcC); Windows: FFmpeg z zapasowymi sposobami przechwytywania; wybór kodera
portal.js      Linux: xdg-desktop-portal RemoteDesktop+ScreenCast (wirtualny monitor, mysz, klawiatura)
usbmux.js      iPhone przez usbmuxd
win/           portal.js (monitor, dopasowanie trybu, SendInput), capture.js (ddagrab/gdigrab + kodery NVENC/QSV/AMF/x264), host.ps1 (PowerShell: SendInput, tryby monitorów), vdd.js (instalacja Virtual Display Driver), tools.js (pobieranie FFmpeg/adb)
index.html     okno (stan, wybór kodera i monitora, karta „Wirtualny monitor” na Windows)
```

## 5. Jak to działa
- Telefon wysyła `hello {w,h,quality}`; komputer dopasowuje monitor, startuje strumień i odpowiada `config` + klatkami binarnymi `[1 bajt: klucz][H.264]`. Klatka kluczowa co sekundę; telefon po zgubieniu klatki czeka na kluczową.
- Windows: `win/portal.js` wybiera najbliższy tryb wirtualnego monitora (proporcje ważniejsze niż liczba pikseli) i zwraca rozmiar strumienia; `capture.js` próbuje `ddagrab` (GPU) i wraca do `gdigrab`.
- **CSP w `index.html` musi zezwalać na skrypt strony** (`script-src 'self' 'unsafe-inline'`) — bez tego okno jest martwe.

## 6. Testowanie
Linux: tor GStreamer testuj `videotestsrc` i koderem dostępnym lokalnie (`openh264enc`). Windows: testuj logikę FFmpeg z atrapą `ffmpeg`, a okno w Chromium ze stubem `window.api`. **Nie sprawdzisz** skryptu PowerShell, instalacji sterownika, przechwytywania ani widoku monitora w ustawieniach Windows — napisz o tym i poproś właściciela o log `%APPDATA%\Pitayas\Screen\logs\app.log`.

## 7. Znane ograniczenia
- Instalacja sterownika (devcon, UAC, ewentualne pytanie o zaufanie do wydawcy) nie była sprawdzona na prawdziwym Windowsie.
- iPhone na Windowsie wymaga zainstalowanych Apple Devices / iTunes.

## 8. Zasady wspólne
- **Język:** interfejs, komentarze, opisy zmian i odpowiedzi po polsku. Marka „Pitayas”; kolory: róż pitai `#ff4fa6`, ciemne tło `#121116`.
- **Wygląd:** matowy, spokojny, czytelny — **nie „AI slop”**: bez świecących gradientów w tytułach, poświat pod przyciskami i udawanego szkła w CSS. Prawdziwe szkło tylko natywne (iOS 26) na elementach, które się nie ruszają.
- **Pitaya Core:** folder `core/` w aplikacji to **kopia** z projektu `Pitayas-Core`. Nie edytuj jej w aplikacji — zmieniaj w `Pitayas-Core` i uruchom `~/Pitayas-Projects/ADMIN/sync-core.sh`. Każda aplikacja rejestruje się w `~/.config/Pitayas/apps/<id>.json` i wystawia kanał sterowania (kontrakt Core 0.2, dla przyszłego Pitaya Hub).
- **Lista zmian:** po **każdej** zmianie w aplikacji dopisz wpis: `node ~/Pitayas-Projects/ADMIN/changelog.js add <id> <feature|fix|change> "opis po polsku"`. `<id>` = nazwa folderu bez „Pitayas-”, małymi literami (np. `screen`, `mobile`, `accounts`, `admin`, `website`). Wpisy trafiają do opisu wydania na GitHubie.
- **Git:** commity jako właściciel (`Pitayas <inbox@rakunek.com>`), krótki opis po polsku, **bez** `Co-Authored-By` i wzmianek o narzędziach AI. Push tylko na bieżącą gałąź, bez force-push bez zgody.
- **Budowanie i wydania:** nie buduj, nie pakuj i nie publikuj wersji bez wyraźnej prośby właściciela. Wydania robi **Pitayas Admin** (`ADMIN/cli.js`, GitHub Releases organizacji Pitayas-Team). Po budowie nie uruchamiaj aplikacji właściciela.
- **Sekrety:** hasła, tokeny, klucze i pliki `.env` nigdy do kodu, logów, commitów ani rozmów.
- **Uczciwość:** nie masz telefonu, iPhone'a ani Windowsa — wyraźnie napisz, czego nie dało się sprawdzić, zamiast twierdzić, że działa.
- **Praca na serwerze:** projekty leżą w `~/Pitayas-Projects` na serwerze rakunek.com (kopia na komputerze właściciela to zapas). Nie startuj zbędnych procesów w tle ani dodatkowych sesji/agentów.
