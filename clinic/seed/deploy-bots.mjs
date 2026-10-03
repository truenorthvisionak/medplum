// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0
//
// Creates/updates every clinic Bot, deploys its code, tags it with a stable
// identifier (urn:clinic:bot|<name>) so the UI can execute it by identifier,
// and creates any Subscription it needs. Idempotent; requires a project admin
// login and the project's `bots` feature.
//
// Usage:  node clinic/seed/deploy-bots.mjs

import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103').replace(/\/$/, '');
const EMAIL = process.env.EMAIL ?? 'doctor@example.com';
const PASSWORD = process.env.PASSWORD ?? 'EyeClinic2026!';
const BOT_IDENTIFIER_SYSTEM = 'urn:clinic:bot';

const BOTS = [
  {
    name: 'appointment-to-worklist',
    file: 'appointment-to-worklist.bot.cjs',
    description: 'Writes/removes Orthanc MWL entries when appointments change',
    subscriptionCriteria: 'Appointment',
  },
  {
    name: 'generate-visit-note',
    file: 'generate-visit-note.bot.cjs',
    description: 'Composes a visit into a rendered PDF note (DocumentReference)',
  },
  {
    name: 'generate-spectacle-rx',
    file: 'generate-spectacle-rx.bot.cjs',
    description: 'Renders a printable spectacle prescription from the latest refraction',
  },
  {
    name: 'generate-pcp-letter',
    file: 'generate-pcp-letter.bot.cjs',
    description: 'Drafts a referring-provider letter from a visit',
  },
];

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
const here = dirname(fileURLToPath(import.meta.url));

for (const spec of BOTS) {
  let bot = (await api('GET', `/fhir/R4/Bot?name=${spec.name}&_count=1`)).entry?.[0]?.resource;
  if (!bot) {
    bot = await api('POST', `/admin/projects/${projectId}/bot`, {
      name: spec.name,
      description: spec.description,
    });
    console.log(`Created Bot/${bot.id} (${spec.name})`);
  }

  const identifier = { system: BOT_IDENTIFIER_SYSTEM, value: spec.name };
  const hasIdentifier = (bot.identifier ?? []).some(
    (i) => i.system === identifier.system && i.value === identifier.value
  );
  if (!hasIdentifier) {
    bot = await api('PUT', `/fhir/R4/Bot/${bot.id}`, {
      ...bot,
      identifier: [...(bot.identifier ?? []), identifier],
    });
  }

  const code = await readFile(join(here, '../bots/src', spec.file), 'utf8');
  await api('POST', `/fhir/R4/Bot/${bot.id}/$deploy`, { code, filename: 'index.js' });
  console.log(`Deployed ${spec.name}`);

  if (spec.subscriptionCriteria) {
    const endpoint = `Bot/${bot.id}`;
    const existing = (await api('GET', `/fhir/R4/Subscription?url=${encodeURIComponent(endpoint)}&_count=10`)).entry
      ?.map((e) => e.resource)
      .find((s) => s.criteria === spec.subscriptionCriteria);
    if (!existing) {
      const subscription = await api('POST', '/fhir/R4/Subscription', {
        resourceType: 'Subscription',
        status: 'active',
        reason: spec.description,
        criteria: spec.subscriptionCriteria,
        channel: { type: 'rest-hook', endpoint },
      });
      console.log(`Created Subscription/${subscription.id} (${spec.subscriptionCriteria})`);
    }
  }
}

console.log('\nDone.');
