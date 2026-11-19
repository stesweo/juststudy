# JustStudy Desktop

Electron wrapper around your JustStudy.html (kept at `app/index.html`).

## Run it
1. Install Node.js (https://nodejs.org, LTS)
2. In this folder:
   npm install
   npm start

## Build the app
   npm run build:win     # Windows standalone .exe (portable, no install)
   npm run build:mac     # macOS .dmg (build on a Mac)
   npm run build:linux   # AppImage + .deb
Output goes to `dist/`.

## Notes
- Data (scores, settings, local-mode study days) is saved in the app's own
  localStorage, so it persists between launches.
- Internet is still needed for the weather, AQI widget and Google Fonts.
- ALLEN and NEET PYQs are buttons in the top right. They open inside the main window (logins are kept),
  full screen, with no toolbar. **Hold Esc (~0.6 s) to go back to JustStudy** (a quick tap of Esc still goes
  to the website). Alt+Left/Right (or the mouse back/forward buttons) = back/forward: **Back on a website's first page returns to JustStudy, and Forward on the JustStudy screen goes back to the website you just left**, Ctrl+R / F5 = reload, Ctrl+W = back to JustStudy; the
  right-click menu on a site also has Back / Forward / Reload / Back to JustStudy.
- While a website is open, the clock, subject/state and stopwatch (same readout and fonts as the DVD screen)
  float over it, semi-transparent and click-through. Customise button -> "Clock on websites": on/off,
  transparency and a 3x3 position picker.
- Going to / from a website uses a 1 s fade (0.5 s to black, 0.5 s back).
- The window title always stays "JustStudy" (it never shows page names).
- F11 toggles fullscreen for the whole app, websites included. Esc does not exit it.
- Network requests use private DNS (AdGuard DNS-over-HTTPS) to block ad/tracker domains. If a network
  blocks DoH, change `secureDnsMode` to `'automatic'` in `main.js`.
- To change the icon, add `build/icon.png` (512x512) before building.

## Build the Windows exe on GitHub
1. Upload this folder's contents to a new GitHub repo (browser upload is fine).
2. Create a release with tag `music` and attach `classical-music.ogg` to it.
3. Actions tab -> "Build Windows portable exe" -> Run workflow.
4. Download the .exe from the finished run's Artifacts.

## Google Tasks panel
The Google Tasks button (top right) opens a built-in panel that works like the Google Tasks web app:
- tasks grouped by date (Overdue / Today / Tomorrow / dates / No date) or "My order" (list menu -> Sort by)
- "Add a task" with title, details, Today / Tomorrow chips, and a date picker with time and repeat
- click a task to edit it in place; tick the circle to complete; "Completed (n)" folds away
- hover a task for the star and the ⋮ menu: add/change/remove deadline, add/change date & time, add a subtask, delete, move to another list, new list
- drag tasks to reorder; switch lists from the title; list menu: rename, delete list, delete completed, sort, sign out
- a "Starred" view that gathers starred tasks from every list
When the panel is open the page makes room for it, so the clock never sits under it.

Google's public Tasks API only stores title, details, date, completed state, sub-tasks and order. So the **time,
repeat, star and deadline** of a task are kept inside this app (on this computer) and don't sync to your phone / Gmail.
A **deadline** is separate from the date & time you plan to do the task: it shows as a "Due yesterday / today / tomorrow" chip under the task (red / blue / grey). Google's API has no deadline field, so deadlines live only in this app.
Repeating tasks create their next copy (daily / weekly / monthly / yearly) when you tick one off.
"Add attachment" isn't available because the API can't create attachments.

Uses Google's official Tasks API. Sign-in happens in a small in-app window; after that
the app stays signed in (token stored encrypted with your OS keychain).
If Google refuses the in-app window, use "Sign in using my browser instead".

### One-time setup
1. console.cloud.google.com -> new project -> enable **Google Tasks API**.
2. Google Auth Platform: audience **External**, add scope `https://www.googleapis.com/auth/tasks`,
   add your Gmail under **Test users** (or publish the app to avoid the 7-day sign-in expiry).
3. Credentials -> Create credentials -> OAuth client ID -> **Desktop app**.
4. Copy `google-config.example.json` to `google-config.json` and paste the Client ID and secret.
   (It is git-ignored. For the GitHub exe build, add repo secrets
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` - the workflow writes the file for you.)
