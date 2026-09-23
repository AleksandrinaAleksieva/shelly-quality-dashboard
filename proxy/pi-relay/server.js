#!/usr/bin/env node
/**
 * Read-only Jira relay for the Shelly Quality Dashboard's "Live data" mode —
 * Raspberry Pi / Node.js version (in place of the Cloudflare Worker in
 * ../worker.js). Same contract, same restrictions, just running on your own
 * hardware behind a tunnel instead of on Cloudflare's edge.
 *
 * What it does: forwards POST /rest/api/3/search to Jira, using whatever
 * Authorization header the caller's browser sent, and adds the CORS headers
 * a browser needs to accept the response.
 *
 * What it deliberately does NOT do:
 *   - Never reads, stores, or logs anyone's token — the header passes
 *     through untouched.
 *   - Only forwards to JIRA_BASE below, and only the one read-only search
 *     endpoint — nothing that creates/edits/deletes in Jira or Confluence.
 *   - Is not an open proxy — it can't be pointed at arbitrary hosts.
 *
 * Run directly:   node server.js
 * Run under PM2:  pm2 start ecosystem.config.js
 * (see ../../README.md, "Deploying the relay on your own Raspberry Pi")
 */

const http = require('http');

const JIRA_BASE = process.env.JIRA_BASE_URL || 'https://shellyusa.atlassian.net';
const PORT = process.env.PORT || 5057;

// Set to your GitHub Pages origin, e.g. 'https://your-github-username.github.io'.
// '*' also works (every request still needs a valid per-user Jira token to do
// anything), but a specific origin is tidier and is what's used below by default
// if ALLOWED_ORIGIN isn't set.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

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

function send(res, status, body, extraHeaders) {
  res.writeHead(status, { ...corsHeaders(), ...(extraHeaders || {}) });
  res.end(body || '');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    return send(res, 204);
  }

  if (!ALLOWED_PATHS.includes(url.pathname)) {
    return send(res, 404, 'Not found');
  }
  if (req.method !== 'POST') {
    return send(res, 405, 'Method not allowed');
  }
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    return send(res, 401, 'Missing Authorization header');
  }

  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', async () => {
    // Defense in depth: reject anything that doesn't look like a search body.
    let parsed;
    try {
      parsed = JSON.parse(raw || '{}');
      if (!('jql' in parsed) && !('fields' in parsed)) {
        return send(res, 400, 'Malformed request');
      }
    } catch (e) {
      return send(res, 400, 'Malformed JSON body');
    }

    try {
      const jiraResp = await fetch(JIRA_BASE + url.pathname, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: raw,
      });
      const respBody = await jiraResp.text();
      send(res, jiraResp.status, respBody, { 'Content-Type': 'application/json' });
    } catch (err) {
      console.error('Upstream Jira request failed:', err.message);
      send(res, 502, 'Upstream Jira request failed');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Shelly Quality Dashboard relay listening on :${PORT}`);
  console.log(`Forwarding to ${JIRA_BASE}, CORS origin: ${ALLOWED_ORIGIN}`);
});
