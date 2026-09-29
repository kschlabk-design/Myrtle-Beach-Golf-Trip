# Myrtle Beach Golf Trip

Tee times, teams, live scores, net skins, sides, 6-6-6, the Snake and the money for the trip.
Viewers open the link with no login. Only the scorer (PIN) can enter and publish scores.

## How it works

- `public/` is the website the guys open.
- `api/state.js` saves and serves the trip data. Saves only go through with the right PIN.
- `api/login.js` checks the PIN.
- The PIN lives only in Vercel's settings (`SCORER_PIN`). It is not in this code, and it never reaches anyone's phone.
- 8 wrong PINs from one phone locks that phone out for 15 minutes.
- Viewers' phones check for new scores every 30 seconds and keep the last results for when there's no signal.
- The last 30 saves are kept in the database under `mbt:history`, in case one ever needs to be recovered.

## One-time setup (about 10 minutes)

1. **GitHub.** Create a new **private** repository. Upload everything in this folder, keeping the folders
   (`api/`, `public/`, `src/`, `test/`) and the files `vercel.json` and `package.json`.
2. **Vercel.** Add New → Project → import the repository. Framework preset: **Other**.
   Leave build settings empty (`vercel.json` already points to `public/`). Deploy.
3. **Database.** In the Vercel project: **Storage** → **Create Database** (or Browse Marketplace) →
   **Upstash for Redis** → free plan → connect it to this project for all environments.
   This adds the database keys automatically.
4. **PIN.** Project **Settings** → **Environment Variables** → add
   `SCORER_PIN` = your PIN for Production and Preview → Save.
   Never put the PIN in the code or this README.
5. **Redeploy.** Deployments → the latest one → ⋯ → **Redeploy**. Settings only apply to new deploys.
6. **Test.** Open the site. Scroll to the bottom of any tab → **Scorer login** → enter the PIN.
   Tap **Publish** once (that saves the starting data to the database). Open the link on a second phone
   and check it matches.

## Before the trip

- Scorer tab → **Setup** → **Trip data** → **Start new trip** to clear the demo scores.
- Enter the real players and tiers, courses (par and stroke index for every hole), Day 1 handicaps,
  dates, teams and tee times. **Publish.**
- Send the guys the link. On iPhone: Safari → Share → **Add to Home Screen** gives them an app icon.

## During the trip

- Score on **one phone**. If two devices edit, the app blocks the older one from overwriting and asks which to keep.
- Unpublished edits are saved on your phone. No signal? Keep entering and publish when you have service.
- Check each man's total against the paper card before you publish.
- Every night: Setup → Trip data → **Copy backup** and paste it into a note.

## Changing things later

- **Change the PIN:** edit `SCORER_PIN` in Vercel, then redeploy. Everyone logged in gets logged out on their next save.
- **Change the app:** edit files in `src/`, run `python3 build.py` to rebuild `public/index.html`, commit, and Vercel redeploys.
  Trip data lives in the database, so code changes never wipe scores.

## Local testing (optional)

`node test/dev-server.mjs` runs the site with a fake in-memory database on http://127.0.0.1:4321 (test PIN 12345).
`test/e2e.mjs` is the automated end-to-end test (needs Playwright).
