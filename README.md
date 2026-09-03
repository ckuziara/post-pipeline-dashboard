# Post Pipeline — Episodic Post-Production Dashboard

A standalone, local, Monday.com-style tracker for episodic post-production. Built to the
**Episodic Post-Production Tracking Application** proposal (the PDF) as the functional spec,
and styled after the team's real Monday board screenshots.

No build step, no Node, no server required — it's plain HTML/CSS/JS. Double-click
`index.html` (or `Start Post Pipeline.bat`) and it runs.

## What it does

Three views over the same episode data, switchable from the top bar:

| View | Mirrors | Shows |
|------|---------|-------|
| **Timeline** | the macro Gantt | Episodes as bars on a week/day calendar, grouped into status swimlanes (Working on it / In Review / Pending / Delivered), with a live **Today** line. Click an episode to drop down to its 27 subitem bars, coloured by department. |
| **Board** | the Monday table | Episodes as collapsible groups; expand to the full **27-subitem grid** — Department, Owner, Status, Start/Due, and **Dependencies**. Click any status cell to change it (two clicks, per the spec). |
| **Dashboard** | the widget board | Delivered counter, pipeline status mix, department & team workload, an at-risk/blocked queue, and upcoming deliveries. |

### Roles (top-right "View as" dropdown)
Three oversight roles + one role per department. The UI re-focuses, and **permissions** change:
- **Producer** → Timeline. Full access: edit any task, add/remove shows, Admin page, approve.
- **Manager** → Dashboard. Oversight + approve + Admin page.
- **Director** → **Ready-for-Review** queue with Approve / Send-back; approve.
- **Creative / Music / Animation / Audio Post / Video Post / Post Operations / QC** → Board filtered to that department. Can edit **only their own department's** tasks, and **cannot approve** (no "Approved" option).

Only **Producer, Director and Manager** can set a task to *Approved*.

### Editing tasks
- **Timeline:** click any subitem bar → **Edit Task** dialog (name, status, start/due with a live duration, Remove, Save).
- **Board:** click a subitem name to open the same dialog, or click its status cell for the quick picker.
- Hovering a timeline bar shows a **status pill** (coloured dot + status name); each bar carries a status-coloured end dot.

### Admin page (Producer / Manager)
A team directory — assign a **role/department** to each user, add or remove users. Live-task counts per person shown.

### Managing shows (Producer, on the Board)
An **+ Add show** button opens a dialog (show name, code, episode count, per-episode names) and spins up each episode with the full 27-stage pipeline. Each show chip has a **✕** to remove the show and its episodes.

### The pipeline
Each episode expands into the exact **27-stage** pipeline transcribed from the reference
board (Episode 1: *Joe's Little Angel*) — Core Premises → … → Deliverys → QC — across
seven departments (Creative, Music, Animation, Audio Post, Video Post, Post Operations, QC).

**Dependencies are first-class.** Every subitem lists the work that must be *Approved*
before it can start. The app uses this to:
- mark a task **⛔ blocked** when a dependency isn't approved yet,
- auto-promote a task to **Ready to Start** the moment its dependencies clear,
- flag at-risk work on the dashboard.

## Statuses
`Not Started` · `Ready to Start` · `In Progress` · `Ready for Review` · `Approved`
(the label set from the board). Click a status cell on the Board to change it.

## Data
Demo data lives in `js/seed.js`; the pipeline template + all logic in `js/state.js`.
Changes persist to your browser's `localStorage` (key `postpipeline_v1`). **Reset** (top-right)
restores the reference board.

The clock is pinned to a demo "today" (`App.DEMO_TODAY` in `js/state.js`) so the timeline
stays lively; set `App.useRealClock = true` to track the real date.

## Run it (Phase 2–3: shared server + SSO)

**Team mode — the real thing.** From this folder run:

```
node server.js
```

The console prints two URLs: `http://localhost:8771` for you, and a
`http://<your-lan-ip>:8771` address teammates on the same network can open.
Everyone signs in, sees the **same shared board**, and edits sync automatically
(changes appear on other screens within ~5 seconds).

- Shared data lives in `data/state.json` next to the server — back that file up
  and you've backed up the whole board.
- Server settings live in `server-config.json` (created on first run).
  `adminEmails` lists who is always treated as Producer.
- Sign-in identity is matched to the team directory **by work email** — set each
  member's email in *Admin → User Directory* so their sign-in lands them in the
  right role automatically. Unknown emails see an "ask an admin to add you" screen.

**Solo/offline mode still works:** double-click `index.html` and the app quietly
falls back to browser-local storage, exactly as before.

## Deploy for free (Render + Neon)

To put the board on the internet — so teammates reach it anywhere and real
Google SSO works — host the Node process on **Render** (free) with the shared
state in **Neon** Postgres (free). The backend auto-switches storage: it uses
Postgres when `DATABASE_URL` is set, and the local `data/state.json` file
otherwise, so nothing changes for laptop dev. Sessions are stateless signed
cookies, so no session store is needed either.

1. **Neon** — create a project at <https://neon.tech>, copy the connection
   string (looks like `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`).
   The `board_state` table is created automatically on first boot.
2. **Render** — New → **Blueprint**, point it at this repo. `render.yaml`
   defines a free web service; Render will prompt for the `sync:false` secrets:
   - `DATABASE_URL` — the Neon string from step 1
   - `SESSION_SECRET` — any long random string (keep it stable; changing it
     signs everyone out)
   - `ACCESS_CODE` — **required** while `DEV_LOGIN` is `true` (see below)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from the SSO step below
     (leave blank at first; team sign-in still works)
   - `MASTER_KEY_V1` — only if you want BYOK (bring-your-own Gemini key) live;
     see below. Leave blank and the feature 503s gracefully — everything else
     works either way
   - `ADMIN_EMAILS`, `ALLOWED_DOMAIN` — already defaulted in `render.yaml`
3. Deploy. Render gives you a URL like `https://post-pipeline-dashboard.onrender.com`.

The database connection verifies the server's TLS certificate by default, which
works out of the box with Neon (and RDS/Aurora). If you later point this at an
on-prem Postgres using a **self-signed** certificate, set `PGSSL_NO_VERIFY=true`
to skip verification — only do that on a trusted network.

### ⚠ Securing the email sign-in (when you can't use Google SSO yet)

The email sign-in (`DEV_LOGIN=true`) asks only for an address — so on a public
URL, *anyone who finds the link* could sign in as an admin. Two protections,
both on by default once configured:

- **`ACCESS_CODE`** — a shared code the whole team types alongside their email.
  Pick your own memorable phrase — don't reuse an example from these docs.
  Compared in constant time, so it can't be guessed character-by-character.
  **Always set this on a public deploy that doesn't have SSO yet.**
- **`ALLOWED_DOMAIN`** — the email must end in `@moonbug.com` (or be listed in
  `ADMIN_EMAILS`), so a leaked code alone isn't enough.

The server prints which protections are active at startup and warns loudly if
email sign-in is exposed without a code. Once Google SSO is working, set
`DEV_LOGIN=false` and the email box disappears entirely.

> Rotating the code just means changing `ACCESS_CODE` in Render — existing
> sessions stay valid (they're signed with `SESSION_SECRET`, which is separate).

> Notes on the free tier: Render free web services **spin down after ~15 min
> idle** (first request then takes ~1 min to wake) — fine for an internal tool.
> Neon **scales its compute to zero** when idle and wakes on demand. When you
> move to company servers, Neon → your Postgres/Aurora is just a
> `pg_dump | pg_restore` (both are standard Postgres).

### Enabling Google SSO (one-time)

Config can come from **environment variables** (hosted deploys, where the
filesystem is wiped on restart) or `server-config.json` (local dev). Env wins.

Until SSO is set up, the login page uses the **team sign-in** (email only —
fine on a trusted office network, but no passwords):

Until this is done, the login page uses the **team sign-in** (email only —
fine on a trusted office network, but no passwords, so do the below when ready):

1. Go to <https://console.cloud.google.com/> → create/select a project.
2. **APIs & Services → OAuth consent screen** → *Internal* (this limits sign-in
   to your Workspace org) → fill in the app name.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   *Web application*. Add the redirect URI for wherever you're running:
   - local: `http://localhost:8771/auth/callback`
   - Render: `https://<your-app>.onrender.com/auth/callback`
4. Provide the **Client ID / secret**:
   - hosted: set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env vars
   - local: put them in `server-config.json` under `"google"`
5. Restart. The *Sign in with Google* button lights up, restricted to
   `ALLOWED_DOMAIN` (moonbug.com). Set `DEV_LOGIN=false` to turn off the
   email-only fallback — **do this on any public deploy.**

> Note: Google accepts `localhost` and public `https` redirect URLs, but not a
> raw LAN IP — so on a laptop the Google button works over localhost, and once
> deployed (Render) it works for everyone. Over plain LAN, teammates use the
> team sign-in, which still gives them their correct role via directory email.

### Enabling BYOK (bring-your-own Gemini key)

Lets each signed-in user connect their own Google Gemini key from the
preferences popover; the server encrypts it and relays their prompts, billed
to *their* Google account, not the team's. Needs Postgres (`DATABASE_URL`)
and one more secret the relay doesn't have without:

1. `openssl rand -base64 32`
2. Set it as `MASTER_KEY_V1` in Render (or `server-config.json` locally).
3. `MASTER_KEY_CURRENT` defaults to `1` in `render.yaml` — leave it unless
   you're rotating (see below).

Without `MASTER_KEY_V1`, `/api/save-key`, `/api/key` and `/api/call-gemini`
answer `503` with a message saying so — the rest of the board is unaffected.

**Rotating the key:** add `MASTER_KEY_V2` alongside `MASTER_KEY_V1` (don't
remove v1) and set `MASTER_KEY_CURRENT=2`. Every row already stored records
which version encrypted it, so old keys keep decrypting under v1 while new
saves use v2 — nothing needs re-encrypting in bulk, and nothing goes down
mid-rotation.

> The key itself never reaches Postgres — only ciphertext does, encrypted in
> the Node process (`keyvault.js`). Passing a master key into SQL as a query
> parameter would put it in statement logs and `pg_stat_statements`, handing
> the one secret to the same system holding everything it protects.

### Enabling the Slack bridge

Two-way sync between a task's chat thread and a Slack channel — messages
posted either side show up on the other. Needs Postgres (`DATABASE_URL`,
same one contextual chat uses) and two secrets from your Slack app:

1. **api.slack.com/apps** → your app → **OAuth & Permissions** → Bot User
   OAuth Token (`xoxb-…`) → set as `SLACK_BOT_TOKEN`.
2. Same app → **Basic Information** → App Credentials → Signing Secret →
   set as `SLACK_SIGNING_SECRET`.
3. Set `APP_URL` to this service's own public URL (e.g.
   `https://post-pipeline-dashboard.onrender.com`) — without it, the "Open
   in Post Pipeline" link on a Slack Task Card posts with no URL at all.
4. In the Slack app's **Event Subscriptions**, set the Request URL to
   `https://<your-app>/slack/events`. Slack calls it immediately to verify
   — a green checkmark means the two secrets above are both correct.

Without `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET`, `/slack/events` falls
through to the board's normal 404/405 handling — the rest of the app is
unaffected, same as BYOK's `503` above.

> `/slack/events` is handled by the same server and the same port as
> everything else — Bolt's request handler (`slack-bridge.js`) is called
> directly from the main dispatcher for that one route, before the
> dispatcher's own body-reading touches the request, so Bolt still gets
> the raw body it needs to verify `X-Slack-Signature` itself. An earlier
> version gave Bolt a second port to listen on instead; that runs fine on
> a laptop, but Render (like most single-service hosts) only proxies the
> one public port, so nothing could ever reach a second listener from the
> internet no matter how correctly it was configured.

### Companion mode (file features from the hosted board)

The hosted board has no LucidLink mount and never can — a container in a
datacenter cannot see a volume mounted on someone's Mac, and there's no way
to mount a laptop's directory into a remote server. Without a mount, Project
and Deliver degrade to a read-only note (see the panel behaviour above).

Companion mode closes that gap from the other direction: a studio machine
running this same server **does** have the mount, so the hosted page hands
its file work to that machine. The board stays on the host — one shared
source of truth — and only the filesystem work moves to where the filesystem
actually is.

Set up on the **studio machine** (not on Render — the hosted service needs
nothing):

1. **Install Node.js** if it isn't there — the LTS build from
   <https://nodejs.org>. macOS and Windows don't ship it.
2. Copy this folder to that machine. **No `npm install` needed** for a
   companion: `pg` and `@slack/bolt` are both lazy-required, so a companion
   that hosts no board and runs no Slack bridge needs no dependencies at all.
3. Open the launcher for that platform and set the two values at the top —
   `BOARD` (your hosted board's address) and `MOUNT` (the production folder
   as it appears on *that* machine):
   - macOS — `Start Post Pipeline Companion.command`, then double-click it
   - Windows — `Start Post Pipeline.bat`, with `COMPANION_ORIGINS` and
     `MASTER_PATH` set the same way
4. Leave the window open. It prints a **pairing code** — open the hosted
   board on that machine, open any task, and paste the code into the
   Workspace panel when it asks. Once per browser, not once per session.
5. Project, Assets and Deliver come fully alive — including "open in app",
   which only ever works where the volume and a desktop both are. The panel
   says which machine is serving files, with an ✕ to unpair.

**A companion holds no database credential.** It can't look an episode up,
so the client sends the handful of fields that become folder names (episode
code and title, show name and prefix) with each request, and the companion
only ever touches the volume already mounted on that machine. That's
deliberate: sharing `DATABASE_URL` would hand every machine full read/write
on the production database, bypassing every permission the app has — roles,
`adminEmails`, all of it — since `psql` doesn't care about any of them.
Stored state still wins for same-origin requests, so hosted and plain-local
behaviour is unchanged.

**Companion file routes are gated by a pairing code.** The companion prints
one at startup; paste it into the Workspace panel once per browser and it's
remembered on that device. Origin alone can't be the gate — `Origin` is a
header, and any non-browser client can claim whatever it likes, `curl`
included. The code is a secret the caller has to actually hold.

A companion also **binds to `127.0.0.1` only** in companion mode, so it isn't
reachable from the rest of the network. (The default `0.0.0.0` is right for
the team-server use, where teammates open it over the LAN; it's wrong for a
companion, where every legitimate caller is a browser on the same machine.)
Set `HOST` explicitly to override, but there's rarely a reason to.

`COMPANION_CODE` can be set explicitly if you'd rather pin it; otherwise a
fresh one is generated each start, which means a restart re-pairs. Pin it if
that becomes annoying.

> **What the code does and doesn't cover.** It stops anything that isn't the
> paired browser — `curl` on the machine, another local process, anything on
> the network if the listener is ever widened. It does *not* stop script
> execution on the board's own origin: the code lives in that origin's
> `localStorage` so its scripts can send it, so an XSS on the board could
> still read it and drive the volume. Not persisting it would close that and
> mean retyping the code constantly; a volume the board is legitimately
> allowed to drive can't be fully walled off from the board being
> compromised. Path sanitising bounds the damage to folders inside the
> production tree either way.

> **Only the machine with the mount benefits, and that's correct.**
> `localhost` means "the machine this browser is running on", so a teammate's
> browser probes their own machine, never yours. LucidLink *is* the filesystem
> here — someone without the volume mounted has no files to open and nowhere
> to create a project, so "file features need the mount" is a fact about the
> work rather than a software restriction. Everyone still gets the board,
> timeline, dashboard, chat, Slack and admin regardless.

## Files
```
index.html          shell + script/style includes
style.css           Monday-style dark theme
server.js           Node backend: static hosting, Google SSO + dev sign-in,
                    stateless cookie sessions, shared versioned state API
                    (Postgres when DATABASE_URL is set, else a local JSON file)
package.json        start script + the one dependency (pg), used by the host
render.yaml         Render Blueprint for the free deploy (env-var placeholders)
server-config.json  local dev settings (git-ignored; hosted deploys use env vars)
data/state.json     the shared board in local/file mode (git-ignored)
js/state.js         data model, pipelines, dependencies, metrics, persistence
js/api.js           server sync: session check, pull/push with versioning, polling
js/seed.js          demo shows / team / episodes
js/gantt.js         Timeline view
js/board.js         Board (Monday table) view
js/dashboard.js     Dashboard widgets
js/dialog.js        modal system + Edit Task & Add Show dialogs
js/admin.js         Admin hub: user directory, access control, privileges
js/render.js        shell: view tabs, user chip, toolbar, filters, KPIs, dispatch
js/main.js          boot + sign-in screens + interactions (permission-guarded)
```

## Not yet built
Live two-way Monday sync, real email/SSO invites on add-member, notifications,
drag-and-drop reassignment, and the project-intake module. Server-side per-role
write enforcement is also future work — the backend currently trusts signed-in
clients (fine on a private office network).
