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
- ALLEN and NEET PYQs are buttons in the top right. They open inside the main window (logins are kept)
  under a slim toolbar (home / back / forward / reload). Alt+Left/Right = back/forward, Ctrl+R = reload,
  Ctrl+W = back to JustStudy.
- F11 toggles fullscreen for the whole app, websites included. Esc does not exit it.
- Network requests use private DNS (AdGuard DNS-over-HTTPS) to block ad/tracker domains. If a network
  blocks DoH, change `secureDnsMode` to `'automatic'` in `main.js`.
- To change the icon, add `build/icon.png` (512x512) before building.

## Build the Windows installer on GitHub
1. Upload this folder's contents to a new GitHub repo (browser upload is fine).
2. Create a release with tag `music` and attach `classical-music.ogg` to it.
3. Actions tab -> "Build Windows installer" -> Run workflow.
4. Download the .exe from the finished run's Artifacts.

## Google Tasks panel
The Google Tasks button (top right) opens a built-in panel (view, add, tick off, delete),
using Google's official Tasks API. Sign-in happens in a small in-app window; after that
the app stays signed in (token stored encrypted with your OS keychain).
If Google refuses the in-app window, use "Sign in using my browser instead".

### One-time setup
1. console.cloud.google.com -> new project -> enable **Google Tasks API**.
2. Google Auth Platform: audience **External**, add scope `https://www.googleapis.com/auth/tasks`,
   add your Gmail under **Test users** (or publish the app to avoid the 7-day sign-in expiry).
3. Credentials -> Create credentials -> OAuth client ID -> **Desktop app**.
4. Copy `google-config.example.json` to `google-config.json` and paste the Client ID and secret.
   (It is git-ignored. For the GitHub installer build, add repo secrets
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` - the workflow writes the file for you.)
