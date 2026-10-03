// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0
//
// Loads the US Core profiles (StructureDefinitions, ValueSets, CodeSystems)
// into the Medplum project. The provider app validates Patient edits against
// the US Core Patient profile, so a fresh self-hosted project needs these
// loaded once per project.
//
// Downloads the official hl7.fhir.us.core package from packages.fhir.org,
// then uploads conformance resources with conditional creates (by canonical
// url + version), so re-running is a no-op.
//
// Usage:
//   node clinic/seed/load-us-core-profiles.mjs
//   MEDPLUM_BASE_URL=http://localhost:8103 EMAIL=... PASSWORD=... node clinic/seed/load-us-core-profiles.mjs

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103').replace(/\/$/, '');
const EMAIL = process.env.EMAIL ?? 'doctor@example.com';
const PASSWORD = process.env.PASSWORD ?? 'EyeClinic2026!';
const PACKAGE = process.env.FHIR_PACKAGE ?? 'hl7.fhir.us.core';
const VERSION = process.env.FHIR_PACKAGE_VERSION ?? '6.1.0';
const UPLOAD_TYPES = new Set(['StructureDefinition', 'ValueSet', 'CodeSystem']);

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
  return tokenBody.access_token;
}

// 1. Download and extract the package
const workDir = mkdtempSync(join(tmpdir(), 'fhir-package-'));
const tarball = join(workDir, 'package.tgz');
console.log(`Downloading ${PACKAGE}@${VERSION} from packages.fhir.org...`);
const res = await fetch(`https://packages.fhir.org/${PACKAGE}/-/${PACKAGE}-${VERSION}.tgz`);
if (!res.ok) {
  throw new Error(`Package download failed: ${res.status}`);
}
writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
execFileSync('tar', ['-xzf', tarball, '-C', workDir]);
const packageDir = join(workDir, 'package');

// 2. Collect conformance resources
const resources = [];
for (const file of readdirSync(packageDir)) {
  if (!file.endsWith('.json')) {
    continue;
  }
  let resource;
  try {
    resource = JSON.parse(readFileSync(join(packageDir, file), 'utf8'));
  } catch {
    continue;
  }
  if (UPLOAD_TYPES.has(resource.resourceType) && resource.url) {
    resources.push(resource);
  }
}
console.log(`Found ${resources.length} conformance resources to load`);

// 3. Upload in batches with conditional creates. Batches stay under the
// server's request size limit (MEDPLUM_MAX_JSON_SIZE, 1mb by default).
const token = await login();
let created = 0;
let existing = 0;
let failed = 0;
const MAX_BATCH_BYTES = 700_000;
const batches = [];
let currentEntries = [];
let currentBytes = 0;
for (const resource of resources) {
  const entry = {
    resource,
    request: {
      method: 'POST',
      url: resource.resourceType,
      ifNoneExist: `url=${encodeURIComponent(resource.url)}&version=${encodeURIComponent(resource.version ?? '')}`,
    },
  };
  const bytes = Buffer.byteLength(JSON.stringify(entry));
  if (currentEntries.length > 0 && currentBytes + bytes > MAX_BATCH_BYTES) {
    batches.push(currentEntries);
    currentEntries = [];
    currentBytes = 0;
  }
  currentEntries.push(entry);
  currentBytes += bytes;
}
if (currentEntries.length > 0) {
  batches.push(currentEntries);
}

let processed = 0;
for (const entries of batches) {
  const batch = { resourceType: 'Bundle', type: 'batch', entry: entries };
  const batchRes = await fetch(`${BASE}/fhir/R4`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/fhir+json' },
    body: JSON.stringify(batch),
  });
  const result = await batchRes.json();
  if (!batchRes.ok) {
    throw new Error(`Batch failed: ${JSON.stringify(result).slice(0, 300)}`);
  }
  for (const entry of result.entry ?? []) {
    const status = entry.response?.status ?? '';
    if (status.startsWith('201')) {
      created++;
    } else if (status.startsWith('200')) {
      existing++;
    } else {
      failed++;
      console.log(`  Failed: ${status} ${JSON.stringify(entry.response?.outcome?.issue?.[0]?.details ?? '').slice(0, 150)}`);
    }
  }
  processed += entries.length;
  console.log(`  ${processed}/${resources.length} processed`);
}
console.log(`Done: ${created} created, ${existing} already present, ${failed} failed`);

// 4. Verify the profile the provider app needs
const check = await fetch(
  `${BASE}/fhir/R4/StructureDefinition?url=${encodeURIComponent('http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient')}&_count=1`,
  { headers: { Authorization: `Bearer ${token}` } }
);
const checkBody = await check.json();
console.log(
  checkBody.entry?.length
    ? 'Verified: US Core Patient profile is now resolvable in this project.'
    : 'WARNING: US Core Patient profile still not found!'
);
