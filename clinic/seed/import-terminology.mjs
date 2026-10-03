// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0
//
// Loads real clinical terminologies into the Medplum project so coded pickers
// (medications, problems, allergies, immunizations) work on a self-hosted server:
//
//   - RxNorm "Current Prescribable Content" (free, no UMLS license) with a
//     `tty` property per concept — drug products and ingredients
//   - ICD-10-CM (free, CMS) — diagnoses for the problem list
//   - CVX (free, CDC) — vaccine codes
//   - The medication picker's value set (RxNorm clinical/branded drugs + packs)
//   - The allergy substance value set, redefined over RxNorm ingredients/brands
//     plus curated SNOMED substances (imported into a project SNOMED code system)
//
// SNOMED CT itself is license-restricted (free via a UMLS account); until it is
// loaded, SNOMED-filtered value sets simply contribute no results.
//
// Requires a project admin login (the user who created the project).
// Idempotent-ish: re-importing concepts upserts; value sets are replaced.
//
// Usage:
//   node clinic/seed/import-terminology.mjs
//   MEDPLUM_BASE_URL=... EMAIL=... PASSWORD=... node clinic/seed/import-terminology.mjs

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103').replace(/\/$/, '');
const EMAIL = process.env.EMAIL ?? 'doctor@example.com';
const PASSWORD = process.env.PASSWORD ?? 'EyeClinic2026!';

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const SNOMED = 'http://snomed.info/sct';
const ICD10CM = 'http://hl7.org/fhir/sid/icd-10-cm';
const ICD9CM = 'http://hl7.org/fhir/sid/icd-9-cm';
const CVX = 'http://hl7.org/fhir/sid/cvx';

const MEDICATION_VS_URL = 'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1010.4';
const ALLERGY_VS_URL = 'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1186.8';

const BATCH_SIZE = 800;

// ---------- auth ----------

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
  const url = path ? `${BASE}/fhir/R4/${path}` : `${BASE}/fhir/R4`;
  const res = await fetch(url, {
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

// ---------- helpers ----------

/** Finds or creates a CodeSystem owned by THIS project (imports require that,
 * and project-owned resources outrank base-project stubs during $expand). */
async function ensureProjectCodeSystem(url, extra = {}) {
  const bundle = await fhir('GET', `CodeSystem?url=${encodeURIComponent(url)}&_count=25`);
  const own = (bundle.entry ?? []).map((e) => e.resource).find((r) => r.meta?.project === projectId);
  if (own) {
    const needsUpdate = Object.entries(extra).some(
      ([key, value]) => JSON.stringify(own[key]) !== JSON.stringify(value)
    );
    if (needsUpdate) {
      const updated = await fhir('PUT', `CodeSystem/${own.id}`, { ...own, ...extra });
      console.log(`Updated project CodeSystem ${url}`);
      return updated;
    }
    return own;
  }
  const created = await fhir('POST', 'CodeSystem', {
    resourceType: 'CodeSystem',
    url,
    status: 'active',
    content: 'not-present',
    ...extra,
  });
  console.log(`Created project CodeSystem ${url}`);
  return created;
}

/** True if the code already resolves in the given system (used to skip huge re-imports). */
async function hasCode(system, code) {
  try {
    const result = await fhir(
      'GET',
      `CodeSystem/$lookup?system=${encodeURIComponent(system)}&code=${encodeURIComponent(code)}`
    );
    return result.resourceType === 'Parameters';
  } catch {
    return false;
  }
}

async function importConcepts(system, concepts, { withTty } = {}) {
  let done = 0;
  for (let i = 0; i < concepts.length; i += BATCH_SIZE) {
    const batch = concepts.slice(i, i + BATCH_SIZE);
    const parameter = [{ name: 'system', valueUri: system }];
    for (const c of batch) {
      parameter.push({ name: 'concept', valueCoding: { code: c.code, display: c.display } });
    }
    if (withTty) {
      for (const c of batch) {
        parameter.push({
          name: 'property',
          part: [
            { name: 'code', valueCode: c.code },
            { name: 'property', valueCode: 'tty' },
            { name: 'value', valueString: c.tty },
          ],
        });
      }
    }
    await fhir('POST', 'CodeSystem/$import', { resourceType: 'Parameters', parameter });
    done += batch.length;
    if (done % 8000 < BATCH_SIZE || done === concepts.length) {
      console.log(`  ${done}/${concepts.length} imported`);
    }
  }
}

/** Replaces (or creates) the project-owned ValueSet at the given canonical url. */
async function upsertValueSet(valueSet) {
  const bundle = await fhir('GET', `ValueSet?url=${encodeURIComponent(valueSet.url)}&_count=25`);
  const own = (bundle.entry ?? []).map((e) => e.resource).find((r) => r.meta?.project === projectId);
  if (own) {
    await fhir('PUT', `ValueSet/${own.id}`, { ...valueSet, id: own.id });
    console.log(`Updated ValueSet ${valueSet.name}`);
  } else {
    await fhir('POST', 'ValueSet', valueSet);
    console.log(`Created ValueSet ${valueSet.name}`);
  }
}

async function download(url, dest) {
  console.log(`Downloading ${url} ...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// ---------- RxNorm ----------

const RXNORM_TTYS = new Set(['IN', 'PIN', 'MIN', 'BN', 'SCD', 'SBD', 'GPCK', 'BPCK']);

async function importRxNorm(workDir) {
  await ensureProjectCodeSystem(RXNORM, {
    name: 'RxNorm',
    property: [{ code: 'tty', type: 'string', description: 'RxNorm term type' }],
  });
  if (await hasCode(RXNORM, '7980')) {
    console.log('RxNorm: already imported; skipping');
    return;
  }
  const zip = join(workDir, 'rxnorm.zip');
  await download('https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_current.zip', zip);
  execFileSync('unzip', ['-o', '-q', zip, 'rrf/RXNCONSO.RRF', '-d', workDir]);

  const byCode = new Map();
  const rl = createInterface({ input: createReadStream(join(workDir, 'rrf', 'RXNCONSO.RRF')) });
  for await (const line of rl) {
    const f = line.split('|');
    // CUI|LAT|TS|LUI|STT|SUI|ISPREF|RXAUI|SAUI|SCUI|SDUI|SAB|TTY|CODE|STR|SRL|SUPPRESS|CVF
    if (f[11] !== 'RXNORM' || !RXNORM_TTYS.has(f[12]) || f[16] === 'Y' || f[16] === 'O' || f[16] === 'E') {
      continue;
    }
    if (!byCode.has(f[13])) {
      byCode.set(f[13], { code: f[13], display: f[14], tty: f[12] });
    }
  }
  const concepts = [...byCode.values()];
  console.log(`RxNorm: importing ${concepts.length} prescribable concepts (products + ingredients + brands)`);
  await importConcepts(RXNORM, concepts, { withTty: true });
}

// ---------- ICD-10-CM ----------

async function importIcd10(workDir) {
  const zip = join(workDir, 'icd10cm.zip');
  const candidates = [
    'https://www.cms.gov/files/zip/2026-code-descriptions-tabular-order.zip',
    'https://www.cms.gov/files/zip/2025-code-descriptions-tabular-order.zip',
    'https://www.cms.gov/files/zip/2025-code-descriptions.zip',
  ];
  let ok = false;
  for (const url of candidates) {
    try {
      await download(url, zip);
      ok = true;
      break;
    } catch (err) {
      console.log(`  ${String(err).slice(0, 100)}`);
    }
  }
  if (!ok) {
    console.log('ICD-10-CM: could not download from CMS; skipping (problems picker will lack diagnoses)');
    return;
  }
  const dir = join(workDir, 'icd10');
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  // The archive holds several files; we want the plain codes list, NOT the addenda
  const codesFile = execFileSync('find', [dir, '-iname', '*.txt'])
    .toString()
    .trim()
    .split('\n')
    .find((f) => /icd10cm[_-]?codes[_-]?\d{4}\.txt$/i.test(f));
  if (!codesFile) {
    console.log('ICD-10-CM: codes file not found in archive; skipping');
    return;
  }
  const concepts = [];
  for (const line of readFileSync(codesFile, 'latin1').split(/\r?\n/)) {
    const m = line.match(/^([A-TV-Z][0-9][0-9A-Z]{1,5})\s+(.+)$/);
    if (m) {
      const raw = m[1];
      const code = raw.length > 3 ? `${raw.slice(0, 3)}.${raw.slice(3)}` : raw;
      concepts.push({ code, display: m[2].trim() });
    }
  }
  console.log(`ICD-10-CM: importing ${concepts.length} diagnosis codes`);
  await ensureProjectCodeSystem(ICD10CM, { name: 'ICD10CM' });
  await importConcepts(ICD10CM, concepts);
}

// ---------- CVX ----------

async function importCvx(workDir) {
  const dest = join(workDir, 'cvx.txt');
  try {
    await download('https://www2a.cdc.gov/vaccines/iis/iisstandards/downloads/cvx.txt', dest);
  } catch (err) {
    console.log(`CVX: download failed (${String(err).slice(0, 80)}); skipping vaccine codes`);
    return;
  }
  // Format: CVX code|short description|full vaccine name|notes|status|...
  const concepts = [];
  for (const line of readFileSync(dest, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const f = line.split('|');
    const code = f[0]?.trim();
    if (f.length >= 3 && code && /^\d+$/.test(code)) {
      concepts.push({ code, display: (f[2] || f[1]).trim() });
    }
  }
  if (!concepts.length) {
    console.log('CVX: no codes parsed; skipping');
    return;
  }
  console.log(`CVX: importing ${concepts.length} vaccine codes`);
  await ensureProjectCodeSystem(CVX, { name: 'CVX' });
  await importConcepts(CVX, concepts);
}

// ---------- Value sets ----------

async function updateValueSets() {
  // Medication picker: RxNorm clinical + branded drugs and packs
  await upsertValueSet({
    resourceType: 'ValueSet',
    url: MEDICATION_VS_URL,
    version: 'clinic-rxnorm-1',
    name: 'ClinicMedicationClinicalDrug',
    title: 'Medication Clinical Drug (RxNorm prescribable)',
    status: 'active',
    description:
      'Stands in for the VSAC Medication Clinical Drug value set: all RxNorm prescribable clinical/branded drugs and packs (TTY SCD, SBD, GPCK, BPCK).',
    compose: {
      include: [
        { system: RXNORM, filter: [{ property: 'tty', op: 'in', value: 'SCD,SBD,GPCK,BPCK' }] },
      ],
    },
  });

  // Allergy substances: RxNorm ingredients/brands + curated SNOMED substances.
  // The curated SNOMED concepts come from the previous stored-expansion file and
  // must exist in the project SNOMED code system for the expansion to keep them.
  const here = dirname(fileURLToPath(import.meta.url));
  const legacy = JSON.parse(await readFile(join(here, 'allergy-substances-valueset.json'), 'utf8'));
  const snomedConcepts = (legacy.expansion?.contains ?? legacy.compose?.include?.find((i) => i.system === SNOMED)?.concept ?? [])
    .filter((c) => (c.system ?? SNOMED) === SNOMED)
    .map((c) => ({ code: c.code, display: c.display }));

  // hierarchyMeaning 'is-a' lets value sets with SNOMED is-a filters (like US
  // Core condition codes) expand: without a resolvable parent property the
  // filtered include contributes nothing instead of erroring the whole expand.
  await ensureProjectCodeSystem(SNOMED, {
    name: 'SNOMEDCT',
    description: 'Project-local SNOMED subset',
    hierarchyMeaning: 'is-a',
  });
  if (snomedConcepts.length) {
    console.log(`SNOMED: importing ${snomedConcepts.length} curated substance concepts`);
    await importConcepts(SNOMED, snomedConcepts);
  }

  await upsertValueSet({
    resourceType: 'ValueSet',
    url: ALLERGY_VS_URL,
    version: 'clinic-curated-2',
    name: 'ClinicAllergySubstances',
    title: 'Common allergens for allergy and intolerance documentation (clinic-curated)',
    status: 'active',
    description:
      'Stands in for the VSAC allergy/intolerance substance value set: all RxNorm prescribable ingredients and brands (TTY IN, PIN, MIN, BN) plus curated SNOMED substances and refutation concepts.',
    compose: {
      include: [
        { system: RXNORM, filter: [{ property: 'tty', op: 'in', value: 'IN,PIN,MIN,BN' }] },
        { system: SNOMED, concept: snomedConcepts },
      ],
    },
  });
}

// ---------- main ----------

await login();
console.log(`Signed in as ${EMAIL} (project ${projectId})`);
const workDir = mkdtempSync(join(tmpdir(), 'terminology-'));

await importRxNorm(workDir);
await importIcd10(workDir);
await importCvx(workDir);
await ensureProjectCodeSystem(ICD9CM, { name: 'ICD9CM' }); // empty stub so multi-system value sets expand
await updateValueSets();

console.log('\nDone. Spot checks:');
for (const [vs, filter] of [
  [MEDICATION_VS_URL, 'lisinopril'],
  [ALLERGY_VS_URL, 'penicillin'],
  ['http://hl7.org/fhir/us/core/ValueSet/us-core-condition-code', 'glaucoma'],
]) {
  try {
    const result = await fhir(
      'GET',
      `ValueSet/$expand?url=${encodeURIComponent(vs)}&filter=${encodeURIComponent(filter)}&count=3`
    );
    const hits = (result.expansion?.contains ?? []).map((c) => c.display);
    console.log(`  ${filter}: ${hits.length ? hits.join(' | ') : 'NO RESULTS'}`);
  } catch (err) {
    console.log(`  ${filter}: EXPAND FAILED ${String(err).slice(0, 120)}`);
  }
}
