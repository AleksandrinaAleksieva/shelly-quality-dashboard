#!/usr/bin/env node
/**
 * Pulls fresh data from Jira and regenerates the GENDATA blocks inside docs/index.html.
 *
 * Requires (as environment variables, e.g. GitHub Actions secrets):
 *   JIRA_BASE_URL    e.g. "https://shellyusa.atlassian.net"
 *   JIRA_EMAIL       the email address tied to the API token
 *   JIRA_API_TOKEN   an Atlassian API token (id.atlassian.com/manage-profile/security/api-tokens)
 *
 * Usage:
 *   node scripts/fetch-and-build.js
 *
 * The token is only ever read from process.env on the machine running this script
 * (a GitHub Actions runner). It is never written into docs/index.html or any
 * committed file — only the aggregated counts are.
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.JIRA_BASE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

if (!BASE_URL || !EMAIL || !TOKEN) {
  console.error('Missing JIRA_BASE_URL, JIRA_EMAIL or JIRA_API_TOKEN environment variables.');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

// ---- Field IDs (from this Jira site's Bug schema — adjust if your fields differ) ----
const F_DEVICE = 'customfield_10203';       // Device (multiselect)
const F_ISSUED_BY = 'customfield_11895';    // Issued by (select)
const F_FW_VERSION = 'customfield_13320';   // Firmware Version (multiselect, clean predefined values)
const F_COMPONENT = 'customfield_13319';    // Shelly Component (multiselect)

const ISSUED_BY_CATEGORIES = ['Support', 'QA', 'QA Automation', 'PO', 'Development', 'Integrations'];

// ---------------------------------------------------------------------------
async function jiraSearch(jql, { fields = [], maxResults = 100 } = {}) {
  const results = [];
  let startAt = 0;
  for (;;) {
    const res = await fetch(`${BASE_URL}/rest/api/3/search`, {
      method: 'POST',
      headers: {
        Authorization: AUTH,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ jql, fields, maxResults, startAt }),
    });
    if (!res.ok) {
      throw new Error(`Jira search failed (${res.status}): ${await res.text()} — JQL: ${jql}`);
    }
    const data = await res.json();
    results.push(...data.issues);
    startAt += data.issues.length;
    if (startAt >= data.total || data.issues.length === 0) break;
  }
  return results;
}

async function jiraCount(jql) {
  const res = await fetch(`${BASE_URL}/rest/api/3/search`, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jql, fields: [], maxResults: 0 }),
  });
  if (!res.ok) throw new Error(`Jira count failed (${res.status}): ${await res.text()} — JQL: ${jql}`);
  const data = await res.json();
  return data.total;
}

function fieldOptionValues(field) {
  if (!field) return [];
  if (Array.isArray(field)) return field.map((f) => f.value);
  return [field.value];
}

// naive semver-ish comparator: parses "2.0.1-beta3", "1.7.99-xt-prod0", etc. Higher = newer.
function compareVersions(a, b) {
  const parse = (v) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z]+)(\d+)?.*)?$/);
    if (!m) return { major: 0, minor: 0, patch: 0, pre: v, preNum: 0, raw: v };
    const [, major, minor, patch, pre, preNum] = m;
    return {
      major: +major,
      minor: +minor,
      patch: +patch,
      pre: pre || '',
      preNum: preNum ? +preNum : 0,
      raw: v,
    };
  };
  const pa = parse(a), pb = parse(b);
  if (pa.major !== pb.major) return pb.major - pa.major;
  if (pa.minor !== pb.minor) return pb.minor - pa.minor;
  if (pa.patch !== pb.patch) return pb.patch - pa.patch;
  // no prerelease suffix ("stable") ranks above any prerelease suffix
  if (!pa.pre && pb.pre) return -1;
  if (pa.pre && !pb.pre) return 1;
  if (pa.pre !== pb.pre) return pa.pre.localeCompare(pb.pre) * -1;
  if (pa.preNum !== pb.preNum) return pb.preNum - pa.preNum;
  return pb.raw.localeCompare(pa.raw);
}

// ---------------------------------------------------------------------------
async function buildIssuedByBreakdown(projectKey) {
  const total = await jiraCount(`project = ${projectKey} AND issuetype = Bug`);
  const breakdown = { Empty: await jiraCount(`project = ${projectKey} AND issuetype = Bug AND cf[11895] is EMPTY`) };
  let known = breakdown.Empty;
  for (const cat of ISSUED_BY_CATEGORIES) {
    const n = await jiraCount(`project = ${projectKey} AND issuetype = Bug AND cf[11895] = "${cat}"`);
    if (n > 0) {
      breakdown[cat] = n;
      known += n;
    }
  }
  const other = total - known;
  if (other > 0) breakdown.Other = other;
  return { total, breakdown };
}

async function buildFirmwareVersionIssues() {
  const issues = await jiraSearch(
    `project = FW AND issuetype = Bug AND cf[13320] is not EMPTY`,
    { fields: ['summary', F_DEVICE, F_ISSUED_BY, F_FW_VERSION, F_COMPONENT, 'status'] }
  );
  return issues.map((issue) => {
    const f = issue.fields;
    return {
      key: issue.key,
      summary: f.summary,
      device: fieldOptionValues(f[F_DEVICE]).join(' / ') || 'Unspecified',
      component: fieldOptionValues(f[F_COMPONENT]),
      versions: fieldOptionValues(f[F_FW_VERSION]),
      issuedBy: f[F_ISSUED_BY] ? f[F_ISSUED_BY].value : 'Unspecified',
      status: f.status ? f.status.name : 'Unknown',
    };
  });
}

async function buildSupportByDevice() {
  const issues = await jiraSearch(
    `project = FW AND issuetype = Bug AND cf[11895] = "Support"`,
    { fields: [F_DEVICE] }
  );
  const counts = {};
  let withDevice = 0;
  for (const issue of issues) {
    const devices = fieldOptionValues(issue.fields[F_DEVICE]);
    if (devices.length === 0) continue;
    withDevice++;
    for (const d of devices) counts[d] = (counts[d] || 0) + 1;
  }
  const list = Object.entries(counts)
    .map(([device, count]) => ({ device, count }))
    .sort((a, b) => b.count - a.count || a.device.localeCompare(b.device));
  return {
    list,
    stats: { total: issues.length, withDevice, distinctDevices: list.length },
  };
}

function monthRange(monthsAgo) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - monthsAgo;
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  const fmt = (d) => d.toISOString().slice(0, 10);
  const label = start.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const isCurrent = monthsAgo === 0;
  return { start: fmt(start), end: fmt(end), label: isCurrent ? `${label} (to date)` : label };
}

async function buildMonthlyTrend(numMonths = 3) {
  const months = [];
  for (let i = numMonths - 1; i >= 0; i--) {
    const { start, end, label } = monthRange(i);
    const total = await jiraCount(`project in (FW, FE) AND issuetype = Bug AND created >= "${start}" AND created < "${end}"`);
    const empty = total === 0 ? 0 : await jiraCount(`project in (FW, FE) AND issuetype = Bug AND created >= "${start}" AND created < "${end}" AND cf[11895] is EMPTY`);
    const tagged = total - empty;
    const support = tagged === 0 ? 0 : await jiraCount(`project in (FW, FE) AND issuetype = Bug AND created >= "${start}" AND created < "${end}" AND cf[11895] = "Support"`);
    const completion = total === 0 ? 0 : Math.round((tagged / total) * 100);
    months.push({
      month: label,
      total,
      tagged,
      support,
      completion,
      lowConfidence: completion < 60,
    });
  }
  return months;
}

// ---------------------------------------------------------------------------
function jsLiteral(value) {
  return JSON.stringify(value, null, 0);
}

function replaceBlock(html, name, newBody) {
  const re = new RegExp(`(/\\* GENDATA:${name}:START \\*/)([\\s\\S]*?)(/\\* GENDATA:${name}:END \\*/)`);
  if (!re.test(html)) throw new Error(`GENDATA marker not found for block: ${name}`);
  return html.replace(re, `$1\n${newBody}\n$3`);
}

async function main() {
  console.log('Fetching Jira data...');

  const [fw, fe] = await Promise.all([buildIssuedByBreakdown('FW'), buildIssuedByBreakdown('FE')]);
  const issues = await buildFirmwareVersionIssues();
  const { list: supportByDevice, stats: supportStats } = await buildSupportByDevice();
  const monthly = await buildMonthlyTrend(3);

  const versionSet = new Set();
  issues.forEach((i) => i.versions.forEach((v) => versionSet.add(v)));
  const mainlineOrder = Array.from(versionSet).sort(compareVersions);

  const docsPath = path.join(__dirname, '..', 'docs', 'index.html');
  let html = fs.readFileSync(docsPath, 'utf8');

  html = replaceBlock(html, 'TOTALS',
    `const FW_ISSUED = ${jsLiteral(fw.breakdown)};\n` +
    `const FE_ISSUED = ${jsLiteral(fe.breakdown)};\n` +
    `const FW_TOTAL = ${fw.total}, FE_TOTAL = ${fe.total};`
  );

  html = replaceBlock(html, 'ISSUES',
    `const ISSUES = [\n` +
    issues.map((i) => ` ${jsLiteral(i)}`).join(',\n') +
    `\n];`
  );

  html = replaceBlock(html, 'SUPPORT_BY_DEVICE',
    `const SUPPORT_BY_DEVICE = ${jsLiteral(supportByDevice)};`
  );

  html = replaceBlock(html, 'SUPPORT_STATS',
    `const SUPPORT_STATS = ${jsLiteral(supportStats)};`
  );

  html = replaceBlock(html, 'VERSIONS',
    `const MAINLINE_ORDER = ${jsLiteral(mainlineOrder)};`
  );

  html = replaceBlock(html, 'MONTHLY',
    `const MONTHLY = ${jsLiteral(monthly)};`
  );

  html = replaceBlock(html, 'FETCHED_AT',
    `const FETCHED_AT_ISO = ${jsLiteral(new Date().toISOString())};`
  );

  fs.writeFileSync(docsPath, html, 'utf8');
  console.log('docs/index.html regenerated with live data.');
  console.log(`  FW bugs: ${fw.total}, FE bugs: ${fe.total}`);
  console.log(`  Firmware-version-tagged issues: ${issues.length}`);
  console.log(`  Latest version: ${mainlineOrder[0]}`);
  console.log(`  Monthly trend: ${monthly.map((m) => `${m.month}=${m.support}/${m.tagged}`).join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
