/**
 * Read-only Jira relay for the Shelly Quality Dashboard's "Live data" settings.
 *
 * Deploy this as a Cloudflare Worker (free tier is plenty). It exists purely
 * because Jira Cloud does not send CORS headers that would let a browser on
 * github.io call it directly — this worker just adds those headers and
 * forwards the request.
 *
 * What it does NOT do:
 *   - It never reads, stores, or logs anyone's token. The Authorization
 *     header a visitor's browser sends is forwarded to Jira as-is and
 *     otherwise never touched.
 *   - It only allows a fixed allow-list of read-only Jira search endpoints
 *     (see ALLOWED_PATHS below) — nothing that creates, edits, transitions,
 *     comments on, or deletes anything. Issue creation / Confluence
 *     publishing are a deliberately separate, not-yet-built phase.
 *   - It only ever talks to JIRA_BASE below — it is not an open proxy, so it
 *     can't be pointed at arbitrary hosts.
 *
 * One-time setup:
 *   1. npm install -g wrangler   (Cloudflare's CLI)
 *   2. wrangler login
 *   3. Edit JIRA_BASE and ALLOWED_ORIGIN below for your site.
 *   4. wrangler deploy
 *   5. Paste the printed *.workers.dev URL into the dashboard's
 *      Settings -> "Read-only relay URL" field.
 *
 * (A wrangler.toml is included alongside this file so `wrangler deploy`
 * works with no extra flags.)
 */

const JIRA_BASE = 'https://shellyusa.atlassian.net';

// Set this to your GitHub Pages origin once you know it, e.g.
// 'https://your-org.github.io'. '*' works too (this endpoint requires a
// valid per-user Jira token to do anything useful, so an open CORS policy
// doesn't expose anything on its own) but a specific origin is tidier.
const ALLOWED_ORIGIN = '*';

// Read-only search only. No write endpoints are reachable through this relay.
const ALLOWED_PATHS = ['/rest/api/3/search'];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request) {
    const cors = corsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);

    if (!ALLOWED_PATHS.includes(url.pathname)) {
      return new Response('Not found', { status: 404, headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }
    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Basic ')) {
      return new Response('Missing Authorization header', { status: 401, headers: cors });
    }

    // Defense in depth: even though the client only ever sends /search
    // bodies, reject anything that smells like a write.
    let body;
    try {
      body = await request.text();
      const parsed = JSON.parse(body);
      if ('fields' in parsed === false && 'jql' in parsed === false) {
        return new Response('Malformed request', { status: 400, headers: cors });
      }
    } catch (e) {
      return new Response('Malformed JSON body', { status: 400, headers: cors });
    }

    const jiraResp = await fetch(JIRA_BASE + url.pathname, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });

    const respBody = await jiraResp.text();
    return new Response(respBody, {
      status: jiraResp.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
