# Shelly Quality Dashboard

A live-ish firmware/FE defect-quality dashboard, rebuilt weekly from real Jira
data and published on GitHub Pages — with an optional per-user **Live data**
mode anyone can turn on from the settings (⚙) button, top right.

**How it works, by default:** `docs/index.html` is a self-contained HTML page
(no backend, no database). Once a week, a GitHub Actions workflow runs
`scripts/fetch-and-build.js`, which queries the Jira REST API directly,
recomputes every number the dashboard shows, and rewrites the specific data
blocks inside `docs/index.html` (marked with `/* GENDATA:... */` comments).
The workflow commits that change and redeploys the page to GitHub Pages.

Between runs, the page is a static file — opening it doesn't call Jira. The
"freshness" comes entirely from how recently the weekly job last ran (shown
in the page header as "Fetched ...").

**How the optional Live data mode works:** click **⚙** (top right), enter
your own Jira account email + API token + a relay URL, and the page
re-queries Jira right there in your browser and redraws every chart, table
and KPI from the result — no waiting for the next Tuesday run. See
[**"Live data" per-user mode**](#live-data-per-user-mode) below for what the
relay is, why it's needed, and how to stand one up. This mode is
**read-only for now**: it refreshes what you see, it does not publish to
Confluence or create Jira tickets — that's a deliberate later phase, not
built yet.

## Why not call Jira straight from the browser, with no relay at all?

1. **CORS.** Jira Cloud doesn't send the headers a browser needs to allow a
   third-party site (like a GitHub Pages URL) to call it directly — the
   request is blocked before your code ever sees a response, token or not.
2. **Credentials, for the weekly snapshot specifically.** The scheduled
   GitHub Actions build (above) uses one shared bot/service-account token.
   That one is never appropriate to ship to the browser — it's not "your"
   token, it's the dashboard's, and anyone who opened dev tools would have
   it. That's why it lives only as an encrypted GitHub Actions secret and is
   used server-side, once a week, never inside `docs/index.html`.

The Live data mode below sidesteps both: each visitor supplies *their own*
token, it's used only from their own browser, and a small relay (not this
repo's GitHub Actions job) adds the CORS headers Jira won't. See the next
section for exactly what that relay does and doesn't do.

## "Live data" per-user mode

The ⚙ settings panel asks for three things:

- **Jira account email** — the account the token belongs to.
- **Jira API token** — from
  [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
- **Read-only relay URL** — see below.

On save, the page calls Jira (through the relay, with *your* token) for the
same aggregates the weekly job computes — issued-by breakdowns, the
firmware-version-tagged issue list, Support-by-device counts, and the
3-month trend — and re-renders the whole page from the result. Nothing is
written back to this repo; a refresh only changes what's in your browser
right now. Your email/token/relay URL are saved to *this browser's*
`localStorage` (key `sqd-jira-creds-v1`) so you're not retyping them each
visit — "Forget & sign out" in the panel clears them, and nothing here is
ever sent anywhere but the relay you configured.

### Why a relay, and what it is

A browser can't call `shellyusa.atlassian.net` directly (the CORS problem
above), so the relay is a tiny piece sitting in between: your browser sends
it a Jira search request with your token in the `Authorization` header, it
forwards that request to Jira and forwards the response back, adding the
CORS header a browser needs to accept it. It does **not** store, log, or
ever see your token used for anything else — it just relays that one header
through. It also only allows the one read-only endpoint
(`POST /rest/api/3/search`) — there's no path through it to create, edit, or
delete anything in Jira or Confluence.

Two ready-made implementations of the exact same contract are included —
pick one:

- **`proxy/pi-relay/`** — plain Node.js, meant to run on your own Raspberry
  Pi under PM2 and be reached through a tunnel (e.g. ngrok). This is the
  option below, and what this repo is set up to use if you're deploying the
  frontend to your own public GitHub repo + Pages.
- **`proxy/worker.js`** — a [Cloudflare Worker](https://developers.cloudflare.com/workers/)
  version of the same relay, for when you'd rather not depend on a home
  device staying online. See the comments at the top of that file for its
  own three-command deploy.

Either one works with the dashboard unchanged — the settings panel just
needs *a* relay URL that answers this contract.

### Deploying the relay on your own Raspberry Pi

This mirrors the Pi + tunnel pattern from your other Jira-connected tools
(a small Node/Express-style process under PM2, reached from the public
internet through a tunnel) — same idea, scoped down to one read-only Jira
endpoint.

**1. Copy `proxy/pi-relay/` onto the Pi** (e.g. `scp -r proxy/pi-relay pi@<pi-host>:~/shelly-relay`, or `git clone` the whole repo there and `cd proxy/pi-relay`).

**2. Install Node 18+ on the Pi**, if it isn't already (`node -v` to check):
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**3. Install PM2 and start the relay:**
```bash
cd ~/shelly-relay   # wherever you copied proxy/pi-relay to
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup          # follow the one printed command to survive reboots
```
It listens on port `5057` by default (`PORT` in `ecosystem.config.js`).
Once you know your GitHub Pages URL, set `ALLOWED_ORIGIN` in that same file
to it (e.g. `'https://your-github-username.github.io'`) instead of `'*'`,
then `pm2 restart shelly-quality-dashboard-relay`.

**4. Expose it to the internet with ngrok** (the Pi has no public IP):
```bash
# one-time: sign up at ngrok.com, then on the Pi:
ngrok config add-authtoken <your-authtoken>
# claim a free static domain once (Dashboard -> Domains) so the URL never changes, then:
ngrok http 5057 --url=<your-static-subdomain>.ngrok-free.app
```
Run that under PM2 too, so it survives reboots and reconnects on its own:
```bash
pm2 start ngrok --name shelly-relay-tunnel -- http 5057 --url=<your-static-subdomain>.ngrok-free.app
pm2 save
```

**5. Paste that `https://<your-static-subdomain>.ngrok-free.app` URL** into
the dashboard's ⚙ settings panel as the relay URL — that's it. `pm2 status`
and `pm2 logs` on the Pi are the two commands worth knowing for checking
it's alive later.

### Publishing the frontend to your public GitHub repo

The `docs/` folder is already laid out for GitHub Pages "Source: Deploy from
a branch, `/docs`" as well as the Actions-based deploy described above —
either works for a public repo:

```bash
cd shelly-quality-dashboard
git init
git add .
git commit -m "Initial import of quality dashboard"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```
Then **Settings → Pages → Build and deployment → Source** — either
**"Deploy from a branch"** (branch `main`, folder `/docs`) for the simplest
setup, or **"GitHub Actions"** if you also want the weekly auto-refresh
workflow described above. Both can coexist: the weekly job keeps the
static snapshot fresh for anyone without a Jira token, and the ⚙ Live data
mode (pointed at your Pi relay) gives anyone with their own token an
up-to-the-second view on demand.

Since the repo is public, double-check `docs/index.html` never has a real
token committed to it — it doesn't by design (GENDATA blocks hold only
aggregated counts, never credentials), but it's worth a glance in the diff
before pushing, same as any public repo.

### What's not built yet

Confluence publishing and Jira ticket creation from this dashboard are not
implemented — this first phase is deliberately read-only. Adding them would
mean the relay also allow-listing write endpoints and forwarding a
create/comment/transition call, which is a larger trust surface than a
read-only relay; worth its own pass once the read path has been used for a
while.

## One-time setup

### 1. Create a Jira API token

As the account this dashboard should query under, go to
[id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
and create a token. Copy it immediately (you won't be able to see it again).

Use a **service/bot account** if you have one available, rather than a
personal account, so the dashboard doesn't break if that person leaves or
changes their password.

### 2. Push this repo to GitHub

```bash
cd shelly-quality-dashboard
git init
git add .
git commit -m "Initial import of quality dashboard"
git branch -M main
git remote add origin https://github.com/<your-org>/<your-repo>.git
git push -u origin main
```

### 3. Add repo secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**.
Add all three:

| Secret name | Value |
|---|---|
| `JIRA_BASE_URL` | `https://shellyusa.atlassian.net` (no trailing slash) |
| `JIRA_EMAIL` | the email address tied to the API token |
| `JIRA_API_TOKEN` | the token from step 1 |

### 4. Enable GitHub Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**
(Not "Deploy from a branch" — the workflow uses the newer Pages Actions
integration, which needs this setting.)

### 5. Test it

**Actions tab → "Refresh Quality Dashboard" → Run workflow** (this uses the
`workflow_dispatch` trigger, so you don't have to wait for Tuesday). Watch
the run; if it succeeds, your Pages URL (shown under **Settings → Pages**
once the first deploy finishes) will serve the live dashboard.

## Schedule

The workflow runs every **Tuesday at 09:00 UTC**. Sofia is UTC+3 in summer
(EEST) and UTC+2 in winter (EET) — GitHub Actions cron is fixed UTC and
doesn't follow daylight saving, so this lands at:

- **12:00 Sofia time** roughly late March–late October (EEST)
- **11:00 Sofia time** roughly late October–late March (EET)

If you'd rather it stay pinned to exactly 12:00/13:00 local and don't mind
the one-hour DST jump the other direction, edit the `cron:` line in
`.github/workflows/refresh-dashboard.yml`.

GitHub Actions schedules can also silently lag a few minutes during high
platform load — expect "around noon," not to-the-second.

## What actually gets regenerated

This section covers the **weekly** GitHub Actions build. For what a Live
data refresh in your own browser recomputes, see
["Live data" per-user mode](#live-data-per-user-mode) above — it's the same
set of numbers, just computed client-side with your own token instead of
server-side with the shared bot token.

The script recomputes and rewrites, from live Jira data:

- FW / FE total bug counts and the full Issued-by breakdown for each project
- Every firmware-version-tagged issue (device, component, issued-by, status, versions)
- Support-reported bug counts per device (all-time)
- The dynamic "latest version" ordering (semver-aware, includes beta/prerelease handling)
- The 3-month rolling trend table (bugs created, field-completion %, escape rate) used on the Escape Rate tab
- The "Fetched" timestamp in the header

All of the dashboard's **charts, tables, and headline KPI numbers** are
computed at page-load time from this data, so they can't drift out of sync
with each other.

**What is *not* auto-regenerated:** the two hand-written commentary
paragraphs on the Escape Rate tab ("What's actually happening" and the
"Recommendation" callout) contain some narrative prose written around
July/August/September 2026 specifically. Their embedded *numbers* stay
correct (they're pulled from IDs the script's data feeds), but the prose
itself doesn't rewrite itself as new months roll in — worth a human glance
every month or two, or ask an LLM to refresh the wording against the current
`MONTHLY` data if it starts to feel dated.

## Adjusting field IDs

If your Jira instance's custom field IDs differ from this one's (unlikely if
you're forking this repo for the same site, but worth checking if fields
have been recreated), edit the constants near the top of
`scripts/fetch-and-build.js`:

```js
const F_DEVICE = 'customfield_10203';
const F_ISSUED_BY = 'customfield_11895';
const F_FW_VERSION = 'customfield_13320';
const F_COMPONENT = 'customfield_13319';
```

## Local test run

You can run the fetch/build script locally (e.g. to sanity-check before
relying on the scheduled job):

```bash
export JIRA_BASE_URL="https://shellyusa.atlassian.net"
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="..."
node scripts/fetch-and-build.js
```

This modifies `docs/index.html` in place — check the diff before committing.
