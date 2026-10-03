// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0
//
// Seeds demo data for testing the provider app:
//   - 5 test patients (eye clinic flavored, MRNs under urn:clinic:mrn)
//   - a Schedule for the signed-in practitioner
//   - free availability slots for the next 5 weekdays (8-12 / 13-17)
//   - booked appointments today and tomorrow (each with a busy slot,
//     matching how the app itself books appointments)
//   - the "Simple Initial Visit" care template (PlanDefinition + note
//     questionnaires) used when documenting a visit
//
// Idempotent: re-running skips anything already present (conditional creates).
//
// Usage:
//   node clinic/seed/seed-demo-schedule.mjs
//   MEDPLUM_BASE_URL=http://localhost:8103 EMAIL=doctor@example.com PASSWORD=... node clinic/seed/seed-demo-schedule.mjs

import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103').replace(/\/$/, '');
const EMAIL = process.env.EMAIL ?? 'doctor@example.com';
const PASSWORD = process.env.PASSWORD ?? 'EyeClinic2026!';
const MRN_SYSTEM = 'urn:clinic:mrn';
const DEMO_SYSTEM = 'urn:clinic:demo';

// ---------- auth (resource-owner login with PKCE) ----------

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
  return tokenBody;
}

let token;

async function fhir(method, path, body, headers = {}) {
  const url = path ? `${BASE}/fhir/R4/${path}` : `${BASE}/fhir/R4`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/fhir+json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

/** Conditional create: no-op if a resource already matches the query. */
async function createIfMissing(resource, query) {
  const res = await fetch(`${BASE}/fhir/R4/${resource.resourceType}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/fhir+json',
      'If-None-Exist': query,
    },
    body: JSON.stringify(resource),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`create ${resource.resourceType} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { resource: json, created: res.status === 201 };
}

// ---------- demo data ----------

const PATIENTS = [
  { mrn: 'MRN0001', given: 'Jane', family: 'Sample', birthDate: '1985-04-12', gender: 'female', phone: '555-0101' },
  { mrn: 'MRN0002', given: 'Marcus', family: 'Webb', birthDate: '1958-11-03', gender: 'male', phone: '555-0102' },
  { mrn: 'MRN0003', given: 'Elena', family: 'Reyes', birthDate: '1972-06-28', gender: 'female', phone: '555-0103' },
  { mrn: 'MRN0004', given: 'Tomas', family: 'Lindqvist', birthDate: '1990-01-15', gender: 'male', phone: '555-0104' },
  { mrn: 'MRN0005', given: 'Priya', family: 'Natarajan', birthDate: '1946-09-09', gender: 'female', phone: '555-0105' },
];

// [dayOffset, hour, minute, durationMin, patientIndex, reason]
const APPOINTMENTS = [
  [0, 9, 0, 45, 0, 'Comprehensive eye exam — annual'],
  [0, 10, 0, 30, 1, 'IOP re-check (glaucoma suspect)'],
  [0, 11, 0, 30, 2, 'Contact lens fitting'],
  [0, 14, 0, 45, 3, 'New patient — comprehensive exam'],
  [0, 15, 30, 30, 4, 'Diabetic retinopathy screening'],
  [1, 9, 30, 45, 2, 'Comprehensive eye exam — annual'],
  [1, 13, 30, 30, 0, 'Post-dilation follow-up'],
  [2, 8, 30, 45, 1, 'Visual field + OCT (glaucoma workup)'],
  [2, 10, 30, 30, 4, 'Cataract surgery consult'],
  [3, 14, 30, 30, 3, 'Contact lens re-check'],
];

function at(dayOffset, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function nextWeekdays(count) {
  const days = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (days.length < count) {
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      days.push(new Date(d));
    }
    d.setDate(d.getDate() + 1);
  }
  return days;
}

// ---------- main ----------

const tokenBody = await login();
token = tokenBody.access_token;
let profileRef = tokenBody.profile?.reference;
if (!profileRef) {
  const me = await (
    await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  profileRef = me.profile ? `${me.profile.resourceType}/${me.profile.id}` : undefined;
}
if (!profileRef?.startsWith('Practitioner/')) {
  throw new Error(`Signed-in profile is not a Practitioner: ${profileRef}`);
}
console.log(`Signed in as ${EMAIL} (${profileRef})`);

// 1. Patients
const patients = [];
for (const p of PATIENTS) {
  const { resource, created } = await createIfMissing(
    {
      resourceType: 'Patient',
      identifier: [{ system: MRN_SYSTEM, value: p.mrn }],
      name: [{ given: [p.given], family: p.family }],
      birthDate: p.birthDate,
      gender: p.gender,
      telecom: [{ system: 'phone', value: p.phone }],
    },
    `identifier=${MRN_SYSTEM}|${p.mrn}`
  );
  patients.push(resource);
  console.log(`${created ? 'Created' : 'Exists '} Patient ${p.given} ${p.family} (${p.mrn})`);
}

// 2. Schedule for the signed-in practitioner
const { resource: schedule, created: scheduleCreated } = await createIfMissing(
  {
    resourceType: 'Schedule',
    active: true,
    actor: [{ reference: profileRef }],
  },
  `actor=${profileRef}`
);
console.log(`${scheduleCreated ? 'Created' : 'Exists '} Schedule/${schedule.id}`);

// 3. Free availability slots for the next 5 weekdays (8-12 / 13-17)
for (const day of nextWeekdays(5)) {
  for (const [startHour, endHour] of [
    [8, 12],
    [13, 17],
  ]) {
    const start = new Date(day);
    start.setHours(startHour, 0, 0, 0);
    const end = new Date(day);
    end.setHours(endHour, 0, 0, 0);
    const slotKey = `avail-${start.toISOString().slice(0, 13)}`;
    const { created } = await createIfMissing(
      {
        resourceType: 'Slot',
        status: 'free',
        schedule: { reference: `Schedule/${schedule.id}` },
        start: start.toISOString(),
        end: end.toISOString(),
        identifier: [{ system: DEMO_SYSTEM, value: slotKey }],
      },
      `identifier=${DEMO_SYSTEM}|${slotKey}`
    );
    if (created) {
      console.log(`Created free slot ${start.toLocaleString()} - ${end.toLocaleTimeString()}`);
    }
  }
}

// 4. Booked appointments (with busy slots, matching the app's booking flow)
for (const [dayOffset, hour, minute, duration, patientIdx, reason] of APPOINTMENTS) {
  const start = at(dayOffset, hour, minute);
  const end = new Date(start.getTime() + duration * 60000);
  const patient = patients[patientIdx];
  const apptKey = `appt-${start.toISOString().slice(0, 16)}-${patient.id}`;

  const existing = await fhir('GET', `Appointment?identifier=${DEMO_SYSTEM}|${apptKey}&_count=1`);
  if (existing.entry?.length) {
    console.log(`Exists  Appointment ${start.toLocaleString()} ${reason}`);
    continue;
  }

  const busySlot = await fhir('POST', 'Slot', {
    resourceType: 'Slot',
    status: 'busy',
    schedule: { reference: `Schedule/${schedule.id}` },
    start: start.toISOString(),
    end: end.toISOString(),
  });

  await fhir('POST', 'Appointment', {
    resourceType: 'Appointment',
    status: 'booked',
    identifier: [{ system: DEMO_SYSTEM, value: apptKey }],
    start: start.toISOString(),
    end: end.toISOString(),
    slot: [{ reference: `Slot/${busySlot.id}` }],
    description: reason,
    serviceType: [{ text: reason }],
    participant: [
      { actor: { reference: `Patient/${patient.id}`, display: `${patient.name[0].given[0]} ${patient.name[0].family}` }, status: 'accepted' },
      { actor: { reference: profileRef }, status: 'accepted' },
    ],
  });
  console.log(`Created Appointment ${start.toLocaleString()} — ${reason}`);
}

// 5. Care templates (PlanDefinition + questionnaires for visit notes). The
// bundles have no conditional-create clauses, so skip a whole import if its
// PlanDefinition is already present.
const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = [
  {
    name: 'Simple Initial Visit',
    path: join(here, '../../examples/medplum-provider/src/data/simple-initial-visit-bundle.json'),
  },
  {
    name: 'Comprehensive Eye Exam',
    path: join(here, 'comprehensive-eye-exam-bundle.json'),
  },
];
for (const template of TEMPLATES) {
  const existing = await fhir('GET', `PlanDefinition?name=${encodeURIComponent(template.name)}&_count=1`);
  if (existing.entry?.length) {
    console.log(`Exists  Care template "${template.name}"`);
    continue;
  }
  const bundle = JSON.parse(await readFile(template.path, 'utf8'));
  const result = await fhir('POST', '', bundle);
  const imported = (result.entry ?? []).filter((e) => e.response?.status?.startsWith('201')).length;
  console.log(`Created Care template "${template.name}" (${imported} resources)`);
}

// 6. Clinic value sets (e.g. the allergy substance picker's VSAC value set,
// which self-hosted servers don't have). Conditional create by canonical url.
const valueSetFiles = ['allergy-substances-valueset.json'];
for (const file of valueSetFiles) {
  const valueSet = JSON.parse(await readFile(join(here, file), 'utf8'));
  const { created } = await createIfMissing(valueSet, `url=${encodeURIComponent(valueSet.url)}`);
  console.log(`${created ? 'Created' : 'Exists '} ValueSet ${valueSet.name}`);
}

console.log('\nDone. Open the schedule: http://localhost:3001/Calendar/Schedule');
