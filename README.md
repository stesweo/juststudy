# JustStudy Desktop

Electron wrapper around your JustStudy.html (kept at `app/index.html`).

## Run it
1. Install Node.js (https://nodejs.org, LTS)
2. In this folder:
   npm install
   npm start

## Build an installer
   npm run build:win     # Windows .exe installer
   npm run build:mac     # macOS .dmg (build on a Mac)
   npm run build:linux   # AppImage + .deb
Output goes to `dist/`.

## Notes
- Data (scores, settings, local-mode study days) is saved in the app's own
  localStorage, so it persists between launches.
- Internet is still needed for the weather, AQI widget and Google Fonts.
- External links open in your default browser.
- To change the icon, add `build/icon.png` (512x512) before building.

## Build the Windows installer on GitHub
1. Upload this folder's contents to a new GitHub repo (browser upload is fine).
2. Create a release with tag `music` and attach `classical-music.ogg` to it.
3. Actions tab -> "Build Windows installer" -> Run workflow.
4. Download the .exe from the finished run's Artifacts.
