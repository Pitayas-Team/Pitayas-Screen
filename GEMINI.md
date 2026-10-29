# Instrukcje dla Antigravity / Gemini

Cały kontekst projektu **Pitayas Screen** (cel, zasady od właściciela, struktura, uruchamianie i wdrażanie, testowanie, znane ograniczenia) jest w pliku **`AGENTS.md`** w tym samym katalogu – przeczytaj go najpierw i traktuj jako obowiązujący.

Najważniejsze w skrócie:
- Aplikacja Electron: Linux (portal Wayland + GStreamer) i Windows (FFmpeg + sterownik wirtualnego monitora). Telefon łączy się **tylko kablem** (Android: `adb reverse`, iPhone: usbmux).
- Po stronie telefonu to moduł `modules/screen` w `Pitayas-Mobile` — protokół opisuje nagłówek `session.js`; zmieniając go, zmieniaj oba.
- Windows: instalacja wirtualnego monitora (`win/vdd.js`) nie była testowana na prawdziwym Windowsie.
- Wszystko po polsku; wygląd matowy i spokojny, nie „AI slop”.
- Po każdej zmianie dopisz wpis w liście zmian: `node ~/Pitayas-Projects/ADMIN/changelog.js add <id> <feature|fix|change> "opis"`.
- Commity jako właściciel, **bez** „Co-Authored-By” i wzmianek o AI. Nie buduj ani nie publikuj wersji bez prośby.
- Nigdy nie kopiuj sekretów (hasła, tokeny, `.env`) do kodu, logów ani czatu. Napisz, czego nie mogłeś sprawdzić.
