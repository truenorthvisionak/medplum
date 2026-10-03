// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0
//
// Imports SNOMED CT into the Medplum project from an official RF2 release,
// including the is-a hierarchy — which makes hierarchy-filtered value sets
// (e.g. US Core condition codes: "is-a 404684003 Clinical finding") expand.
//
// SNOMED CT is licensed, so this script does NOT download it. Get the release
// yourself (free for US users):
//   1. Create a UMLS account: https://uts.nlm.nih.gov/uts/signup-login
//   2. Download "SNOMED CT United States Edition" (RF2 zip, ~1 GB):
//      https://www.nlm.nih.gov/healthit/snomedct/us_edition.html
//   3. Run this script with the path to the zip (or an extracted directory):
//        node clinic/seed/import-snomed.mjs ~/Downloads/SnomedCT_USEditionRF2_PRODUCTION_*.zip
//
// What it imports (Snapshot files):
//   - Active concepts, displayed by their US-English preferred term
//     (fallback: fully specified name without the semantic tag)
//   - Active "is a" relationships as `parent` properties, enabling
//     is-a/descendent-of value set filters
//
// Idempotent-ish: skips the (long) import if SNOMED looks loaded already;
// pass --force to re-import. Expect the full import to take 15-45 minutes.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const BASE = (process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103').replace(/\/$/, '');
const EMAIL = process.env.EMAIL ?? 'doctor@example.com';
const PASSWORD = process.env.PASSWORD ?? 'EyeClinic2026!';
const SNOMED = 'http://snomed.info/sct';
const PARENT_PROPERTY_URI = 'http://hl7.org/fhir/concept-properties#parent';
const BATCH_SIZE = 800;

// RF2 constants
const TYPE_FSN = '900000000000003001';
const TYPE_SYNONYM = '900000000000013009';
const US_ENGLISH_REFSET = '900000000000509007';
const ACCEPTABILITY_PREFERRED = '900000000000548007';
const IS_A = '116680003';

const args = process.argv.slice(2).filter((a) => a !== '--force');
const force = process.argv.includes('--force');
const releasePath = args[0];
if (!releasePath) {
  console.error('Usage: node clinic/seed/import-snomed.mjs <path-to-RF2-zip-or-directory> [--force]');
  console.error('Download the SNOMED CT US Edition (free with a UMLS account):');
  console.error('  https://www.nlm.nih.gov/healthit/snomedct/us_edition.html');
  process.exit(1);
}

// ---------- auth (same flow as the other seed scripts) ----------

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

async function fhir(method, path, body, retried) {
  const res = await fetch(`${BASE}/fhir/R4/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/fhir+json',
      'X-Medplum': 'extended',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    await login();
    return fhir(method, path, body, true);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

// ---------- RF2 parsing ----------

function findFile(root, pattern) {
  const out = execFileSync('find', [root, '-type', 'f', '-name', pattern]).toString().trim().split('\n');
  // Prefer Snapshot over Full/Delta if multiple match
  return out.find((f) => f.includes('Snapshot')) ?? out[0] ?? undefined;
}

async function eachLine(file, onRow) {
  const rl = createInterface({ input: createReadStream(file) });
  let header = true;
  for await (const line of rl) {
    if (header) {
      header = false;
      continue;
    }
    if (line) {
      onRow(line.split('\t'));
    }
  }
}

// ---------- main ----------

await login();
console.log(`Signed in as ${EMAIL} (project ${projectId})`);

// Resolve/extract the release
let root = releasePath;
if (statSync(releasePath).isFile()) {
  root = mkdtempSync(join(tmpdir(), 'snomed-'));
  console.log(`Extracting ${releasePath} (Snapshot files only)...`);
  execFileSync('unzip', ['-o', '-q', releasePath, '*Snapshot*', '-d', root]);
}

const conceptFile = findFile(root, 'sct2_Concept_Snapshot*.txt');
const descriptionFile = findFile(root, 'sct2_Description_Snapshot*.txt');
const languageFile = findFile(root, 'der2_cRefset_LanguageSnapshot*.txt');
const relationshipFile = findFile(root, 'sct2_Relationship_Snapshot*.txt');
if (!conceptFile || !descriptionFile || !relationshipFile) {
  throw new Error(`Could not find RF2 Snapshot files under ${root}`);
}
console.log(`Concepts:      ${conceptFile}`);
console.log(`Descriptions:  ${descriptionFile}`);
console.log(`Language:      ${languageFile ?? '(none — will use FSN displays)'}`);
console.log(`Relationships: ${relationshipFile}`);

// Ensure the project CodeSystem declares the hierarchy + parent property
const csBundle = await fhir('GET', `CodeSystem?url=${encodeURIComponent(SNOMED)}&_count=25`);
const own = (csBundle.entry ?? []).map((e) => e.resource).find((r) => r.meta?.project === projectId);
const csFields = {
  resourceType: 'CodeSystem',
  url: SNOMED,
  name: 'SNOMEDCT',
  status: 'active',
  content: 'not-present',
  hierarchyMeaning: 'is-a',
  property: [
    { code: 'parent', uri: PARENT_PROPERTY_URI, type: 'code', description: 'Direct parent concept (is-a)' },
  ],
};
if (own) {
  await fhir('PUT', `CodeSystem/${own.id}`, { ...own, ...csFields, id: own.id });
} else {
  await fhir('POST', 'CodeSystem', csFields);
}
console.log('CodeSystem ready (is-a hierarchy + parent property declared)');

// Skip if already loaded (404684003 = Clinical finding, a core concept)
if (!force) {
  try {
    const probe = await fhir('GET', `CodeSystem/$lookup?system=${encodeURIComponent(SNOMED)}&code=404684003`);
    if (probe.resourceType === 'Parameters') {
      console.log('SNOMED already imported (404684003 resolves); pass --force to re-import.');
      process.exit(0);
    }
  } catch {
    // not loaded; continue
  }
}

// Pass 0: active concept ids
const active = new Set();
await eachLine(conceptFile, (f) => {
  // id, effectiveTime, active, moduleId, definitionStatusId
  if (f[2] === '1') {
    active.add(f[0]);
  }
});
console.log(`Active concepts: ${active.size}`);

// Pass 1: displays. Preferred US-English synonym; FSN (minus semantic tag) as fallback.
const preferredDescriptions = new Set();
if (languageFile) {
  await eachLine(languageFile, (f) => {
    // id, effectiveTime, active, moduleId, refsetId, referencedComponentId, acceptabilityId
    if (f[2] === '1' && f[4] === US_ENGLISH_REFSET && f[6] === ACCEPTABILITY_PREFERRED) {
      preferredDescriptions.add(f[5]);
    }
  });
  console.log(`Preferred description ids: ${preferredDescriptions.size}`);
}

const display = new Map();
const fallback = new Map();
await eachLine(descriptionFile, (f) => {
  // id, effectiveTime, active, moduleId, conceptId, languageCode, typeId, term, caseSignificanceId
  if (f[2] !== '1' || !active.has(f[4])) {
    return;
  }
  if (f[6] === TYPE_SYNONYM && preferredDescriptions.has(f[0]) && !display.has(f[4])) {
    display.set(f[4], f[7]);
  } else if (f[6] === TYPE_FSN && !fallback.has(f[4])) {
    fallback.set(f[4], f[7].replace(/\s*\([^)]*\)\s*$/, ''));
  }
});
for (const [conceptId, term] of fallback) {
  if (!display.has(conceptId)) {
    display.set(conceptId, term);
  }
}
console.log(`Displays resolved: ${display.size}`);

// Pass 2: import concepts
const concepts = [...display.entries()].map(([code, term]) => ({ code, display: term }));
console.log(`Importing ${concepts.length} concepts...`);
for (let i = 0; i < concepts.length; i += BATCH_SIZE) {
  const batch = concepts.slice(i, i + BATCH_SIZE);
  const parameter = [{ name: 'system', valueUri: SNOMED }];
  for (const c of batch) {
    parameter.push({ name: 'concept', valueCoding: { code: c.code, display: c.display } });
  }
  await fhir('POST', 'CodeSystem/$import', { resourceType: 'Parameters', parameter });
  if ((i / BATCH_SIZE) % 25 === 0 || i + BATCH_SIZE >= concepts.length) {
    console.log(`  concepts ${Math.min(i + BATCH_SIZE, concepts.length)}/${concepts.length}`);
  }
}

// Pass 3: import is-a relationships as parent properties
const parents = [];
await eachLine(relationshipFile, (f) => {
  // id, effectiveTime, active, moduleId, sourceId, destinationId, relationshipGroup, typeId, ...
  if (f[2] === '1' && f[7] === IS_A && active.has(f[4]) && active.has(f[5])) {
    parents.push([f[4], f[5]]);
  }
});
console.log(`Importing ${parents.length} is-a relationships as parent properties...`);
for (let i = 0; i < parents.length; i += BATCH_SIZE) {
  const batch = parents.slice(i, i + BATCH_SIZE);
  const parameter = [{ name: 'system', valueUri: SNOMED }];
  for (const [child, parent] of batch) {
    parameter.push({
      name: 'property',
      part: [
        { name: 'code', valueCode: child },
        { name: 'property', valueCode: 'parent' },
        { name: 'value', valueString: parent },
      ],
    });
  }
  await fhir('POST', 'CodeSystem/$import', { resourceType: 'Parameters', parameter });
  if ((i / BATCH_SIZE) % 25 === 0 || i + BATCH_SIZE >= parents.length) {
    console.log(`  relationships ${Math.min(i + BATCH_SIZE, parents.length)}/${parents.length}`);
  }
}

// Spot checks
console.log('\nDone. Spot checks:');
for (const [vs, filter] of [
  ['http://hl7.org/fhir/us/core/ValueSet/us-core-condition-code', 'open-angle glaucoma'],
  ['http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1186.8', 'latex'],
]) {
  try {
    const result = await fhir(
      'GET',
      `ValueSet/$expand?url=${encodeURIComponent(vs)}&filter=${encodeURIComponent(filter)}&count=5`
    );
    const hits = (result.expansion?.contains ?? []).map((c) => `${c.display} [${c.system?.includes('snomed') ? 'SNOMED' : 'other'}]`);
    console.log(`  ${filter}: ${hits.length ? hits.join(' | ') : 'NO RESULTS'}`);
  } catch (err) {
    console.log(`  ${filter}: EXPAND FAILED ${String(err).slice(0, 150)}`);
  }
}
