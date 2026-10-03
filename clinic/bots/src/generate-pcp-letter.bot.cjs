// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0
//
// Drafts a letter to the referring/primary care provider from a visit
// (the daily "diabetic eye exam report back to the PCP" workflow).
// Input: Encounter resource or { encounterId, recipient? }.
// Output: Binary + DocumentReference (LOINC 11488-4 Consult note,
// docStatus preliminary — review before sending).

const SNOMED = 'http://snomed.info/sct';
const LOINC = 'http://loinc.org';
const IOP_CODE = '41633001';
const VA_CODES = { 420050001: 'uncorrected', 419775003: 'best corrected', 419475002: 'pinhole' };

function laterality(obs) {
  const code = obs.bodySite?.coding?.[0]?.code;
  if (code === '1290032005') {
    return 'OD';
  }
  if (code === '1290031003') {
    return 'OS';
  }
  return 'OU';
}

function hasSnomed(obs, code) {
  return (obs.code?.coding ?? []).some((c) => c.system === SNOMED && c.code === code);
}

exports.handler = async function handler(medplum, event) {
  const input = event.input ?? {};
  const encounterId = input.resourceType === 'Encounter' ? input.id : input.encounterId;
  const recipient = input.recipient ?? '';
  if (!encounterId) {
    throw new Error('Expected an Encounter or { encounterId }');
  }

  const encounter = await medplum.readResource('Encounter', encounterId);
  const patient = await medplum.readReference(encounter.subject);
  const encounterRef = `Encounter/${encounterId}`;

  const [observations, responses] = await Promise.all([
    medplum.searchResources('Observation', { encounter: encounterRef, _count: '200' }),
    medplum.searchResources('QuestionnaireResponse', { encounter: encounterRef, _count: '50' }),
  ]);

  const patientName = `${patient.name?.[0]?.given?.join(' ') ?? ''} ${patient.name?.[0]?.family ?? ''}`.trim();
  const visitDate = (encounter.period?.start ?? '').slice(0, 10);
  const provider =
    encounter.participant?.find((p) => p.individual?.reference?.startsWith('Practitioner/'))?.individual?.display ??
    'the undersigned';

  // Exam highlights: best VA line, IOP, assessments, plan
  const vaParts = [];
  for (const [code, label] of Object.entries(VA_CODES)) {
    const eyes = {};
    for (const obs of observations) {
      if (hasSnomed(obs, code) && obs.valueString) {
        eyes[laterality(obs)] = obs.valueString;
      }
    }
    if (eyes.OD || eyes.OS) {
      vaParts.push(`Visual acuity (${label}): ${eyes.OD ?? '—'} OD, ${eyes.OS ?? '—'} OS.`);
    }
  }
  const iop = {};
  for (const obs of observations) {
    if (hasSnomed(obs, IOP_CODE)) {
      iop[laterality(obs)] = obs.valueQuantity?.value;
    }
  }
  const iopLine =
    iop.OD !== undefined || iop.OS !== undefined
      ? `Intraocular pressure: ${iop.OD ?? '—'} mmHg OD, ${iop.OS ?? '—'} mmHg OS.`
      : '';

  const assessments = observations
    .filter((o) => o.code?.text === 'Assessment' && o.valueString)
    .map((o) => ({ problem: o.focus?.[0]?.display ?? 'Problem', note: o.valueString }));

  let planText = '';
  for (const qr of responses) {
    const findPlan = (items) => {
      for (const item of items ?? []) {
        if (item.linkId === 'plan' && item.answer?.[0]?.valueString) {
          return item.answer[0].valueString;
        }
        const nested = findPlan(item.item);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    };
    planText = planText || findPlan(qr.item) || '';
  }

  const content = [
    { text: new Date().toISOString().slice(0, 10), alignment: 'right' },
    { text: recipient ? `Dear ${recipient},` : 'Dear colleague,', margin: [0, 16, 0, 8] },
    {
      text:
        `Thank you for the opportunity to participate in the care of ${patientName} ` +
        `(DOB ${patient.birthDate ?? 'unknown'}), who was seen in our office on ${visitDate} ` +
        `for ${encounter.type?.[0]?.text?.toLowerCase() ?? 'an eye examination'}.`,
      margin: [0, 0, 0, 8],
    },
  ];

  const findings = [...vaParts, iopLine].filter(Boolean);
  if (findings.length) {
    content.push({ text: 'Examination findings:', bold: true, margin: [0, 4, 0, 2] });
    for (const f of findings) {
      content.push({ text: f, margin: [10, 0, 0, 1] });
    }
  }
  if (assessments.length) {
    content.push({ text: 'Assessment:', bold: true, margin: [0, 8, 0, 2] });
    for (const a of assessments) {
      content.push({ text: `${a.problem} — ${a.note}`, margin: [10, 0, 0, 2] });
    }
  }
  if (planText) {
    content.push({ text: 'Plan:', bold: true, margin: [0, 8, 0, 2] });
    content.push({ text: planText, margin: [10, 0, 0, 2] });
  }
  content.push({
    text:
      '\nPlease do not hesitate to contact our office with any questions regarding this ' +
      "patient's ophthalmic care.",
    margin: [0, 8, 0, 16],
  });
  content.push({ text: 'Sincerely,' });
  content.push({ text: `\n${provider}`, bold: true });

  const binary = await medplum.createPdf({
    content,
    defaultStyle: { font: 'Helvetica', fontSize: 10, lineHeight: 1.15 },
  });

  const today = new Date().toISOString().slice(0, 10);
  const docRef = await medplum.createResource({
    resourceType: 'DocumentReference',
    status: 'current',
    docStatus: 'preliminary',
    type: { coding: [{ system: LOINC, code: '11488-4', display: 'Consult note' }], text: 'Referring provider letter' },
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
    subject: { reference: `Patient/${patient.id}`, display: patientName },
    context: { encounter: [{ reference: encounterRef }], period: encounter.period },
    date: new Date().toISOString(),
    description: `PCP letter — ${visitDate || today} (draft)`,
    content: [
      {
        attachment: {
          contentType: 'application/pdf',
          url: `Binary/${binary.id}`,
          title: `pcp-letter-${visitDate || today}.pdf`,
        },
      },
    ],
  });

  return { documentReference: docRef.id, binary: binary.id };
};
