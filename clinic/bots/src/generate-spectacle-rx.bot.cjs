// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0
//
// Renders a printable spectacle prescription PDF from the patient's most
// recent manifest refraction observations (SNOMED 251794006, charted by the
// Eye Exam form). Input: Patient resource or { patientId }.
// Output: Binary + DocumentReference (shows on the patient's Documents tab).

const SNOMED = 'http://snomed.info/sct';
const REFRACTION_CODE = '251794006';
const COMPONENTS = { 251795007: 'sphere', 251797004: 'cylinder', 251799001: 'axis', 251796008: 'add' };

function formatSigned(value) {
  if (value === undefined || value === null) {
    return 'plano';
  }
  return value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}

exports.handler = async function handler(medplum, event) {
  const input = event.input ?? {};
  const patientId = input.resourceType === 'Patient' ? input.id : input.patientId;
  if (!patientId) {
    throw new Error('Expected a Patient or { patientId }');
  }
  const patient = await medplum.readResource('Patient', patientId);

  const observations = await medplum.searchResources('Observation', {
    patient: `Patient/${patientId}`,
    code: `${SNOMED}|${REFRACTION_CODE}`,
    _sort: '-date',
    _count: '10',
  });

  const rx = {};
  let effective;
  for (const obs of observations) {
    const eye = obs.bodySite?.coding?.[0]?.code === '1290032005' ? 'OD' : 'OS';
    if (rx[eye]) {
      continue; // already have the most recent for this eye
    }
    const parts = {};
    for (const comp of obs.component ?? []) {
      const kind = (comp.code?.coding ?? []).map((c) => COMPONENTS[c.code]).find(Boolean);
      if (kind) {
        parts[kind] = comp.valueQuantity?.value;
      }
    }
    rx[eye] = parts;
    effective = effective ?? obs.effectiveDateTime;
  }
  if (!rx.OD && !rx.OS) {
    throw new Error('No refraction on file for this patient');
  }

  const performer = observations[0]?.performer?.[0]?.display ?? '';
  const patientName = `${patient.name?.[0]?.given?.join(' ') ?? ''} ${patient.name?.[0]?.family ?? ''}`.trim();
  const mrn = patient.identifier?.find((i) => i.system === 'urn:clinic:mrn')?.value ?? patient.id;
  const today = new Date().toISOString().slice(0, 10);
  const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const row = (eye) => [
    { text: eye, bold: true },
    formatSigned(rx[eye]?.sphere),
    rx[eye]?.cylinder !== undefined ? formatSigned(rx[eye].cylinder) : '—',
    rx[eye]?.axis !== undefined ? String(rx[eye].axis) : '—',
    rx[eye]?.add !== undefined ? `+${rx[eye].add.toFixed(2)}` : '—',
  ];

  const binary = await medplum.createPdf({
    content: [
      { text: 'SPECTACLE PRESCRIPTION', style: 'title' },
      {
        columns: [
          [{ text: patientName, bold: true }, { text: `MRN: ${mrn}   DOB: ${patient.birthDate ?? ''}` }],
          [
            { text: `Date: ${today}`, alignment: 'right' },
            { text: `Refraction of: ${(effective ?? '').slice(0, 10)}`, alignment: 'right' },
            { text: `Expires: ${expires}`, alignment: 'right' },
          ],
        ],
        margin: [0, 8, 0, 12],
      },
      {
        table: {
          widths: [40, '*', '*', '*', '*'],
          body: [
            [{ text: '', bold: true }, 'Sphere', 'Cylinder', 'Axis', 'Add'].map((h) =>
              typeof h === 'string' ? { text: h, bold: true } : h
            ),
            rx.OD ? row('OD') : [{ text: 'OD', bold: true }, '—', '—', '—', '—'],
            rx.OS ? row('OS') : [{ text: 'OS', bold: true }, '—', '—', '—', '—'],
          ],
        },
        margin: [0, 0, 0, 14],
      },
      { text: 'PD: ______________        Notes: ____________________________________________' },
      { text: '\n\n' },
      { text: `Prescriber: ${performer}`, margin: [0, 10, 0, 0] },
      { text: 'Signature: ____________________________________', margin: [0, 14, 0, 0] },
    ],
    styles: { title: { fontSize: 14, bold: true } },
    defaultStyle: { font: 'Helvetica', fontSize: 10 },
  });

  const docRef = await medplum.createResource({
    resourceType: 'DocumentReference',
    status: 'current',
    docStatus: 'final',
    type: { text: 'Spectacle prescription' },
    category: [
      {
        coding: [
          {
            system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category',
            code: 'clinical-note',
            display: 'Clinical Note',
          },
        ],
      },
    ],
    subject: { reference: `Patient/${patientId}`, display: patientName },
    date: new Date().toISOString(),
    description: `Spectacle Rx — ${today}`,
    content: [
      {
        attachment: {
          contentType: 'application/pdf',
          url: `Binary/${binary.id}`,
          title: `spectacle-rx-${today}.pdf`,
        },
      },
    ],
  });

  return { documentReference: docRef.id, binary: binary.id };
};
