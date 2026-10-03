// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0
//
// Creates/updates the appointment-to-worklist Bot and its Subscription:
//   Appointment change in Medplum -> Bot -> wl-writer -> Orthanc MWL.
// Idempotent; requires a project admin login.
//
// Usage:  node clinic/seed/deploy-worklist-bot.mjs

import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103').replace(/\/$/, '');
const EMAIL = process.env.EMAIL ?? 'doctor@example.com';
const PASSWORD = process.env.PASSWORD ?? 'EyeClinic2026!';
const BOT_NAME = 'appointment-to-worklist';

let token;
let projectId;

async function login() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      scope: 'openid',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    }),
  });
  const loginBody = await loginRes.json();
  if (!loginBody.code) {
    throw new Error(`Login failed: ${JSON.stringify(loginBody)}`);
  }
  const tokenRes = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${loginBody.code}&code_verifier=${verifier}`,
  });
  const tokenBody = await tokenRes.json();
  if (!tokenBody.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(tokenBody)}`);
  }
  token = tokenBody.access_token;
  const me = await (await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  projectId = me.project?.id;
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

await login();
console.log(`Signed in as ${EMAIL} (project ${projectId})`);

// 1. Find or create the Bot
let bot = (await api('GET', `/fhir/R4/Bot?name=${BOT_NAME}&_count=1`)).entry?.[0]?.resource;
if (bot) {
  console.log(`Exists  Bot/${bot.id}`);
} else {
  bot = await api('POST', `/admin/projects/${projectId}/bot`, {
    name: BOT_NAME,
    description: 'Writes/removes Orthanc MWL entries when appointments change',
  });
  console.log(`Created Bot/${bot.id}`);
}

// 2. Deploy the code
const here = dirname(fileURLToPath(import.meta.url));
const code = await readFile(join(here, '../bots/src/appointment-to-worklist.bot.cjs'), 'utf8');
await api('POST', `/fhir/R4/Bot/${bot.id}/$deploy`, { code, filename: 'index.js' });
console.log('Deployed bot code');

// 3. Find or create the Subscription
const criteria = 'Appointment';
const endpoint = `Bot/${bot.id}`;
const existing = (await api('GET', `/fhir/R4/Subscription?url=${encodeURIComponent(endpoint)}&_count=10`)).entry
  ?.map((e) => e.resource)
  .find((s) => s.criteria === criteria);
if (existing) {
  console.log(`Exists  Subscription/${existing.id}`);
} else {
  const subscription = await api('POST', '/fhir/R4/Subscription', {
    resourceType: 'Subscription',
    status: 'active',
    reason: 'Write Orthanc modality worklist entries for appointments',
    criteria,
    channel: { type: 'rest-hook', endpoint },
  });
  console.log(`Created Subscription/${subscription.id}`);
}

console.log('\nDone. Booking or updating an Appointment now writes an Orthanc MWL entry.');
