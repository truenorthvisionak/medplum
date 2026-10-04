// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0
//
// Composes a visit's complete documentation into a rendered PDF note — the
// immutable system-of-record artifact. Triggered on Sign & Lock (and after
// addenda); can also be run on demand for a draft rendering.
//
// Input: the Encounter resource (or { encounterId }).
// Gathers: patient, questionnaire responses (CC/HPI, entrance testing, plan),
// eye exam observations, per-problem assessments, chart note, signature
// provenances + addenda. Output: Binary (PDF) + DocumentReference
// (LOINC 11506-3 Progress note, category clinical-note) linked to the
// encounter; any previous note for the visit is superseded.

const SNOMED = 'http://snomed.info/sct';
const LOINC = 'http://loinc.org';

const PANEL_CODE = '36228007';
const IOP_CODE = '41633001';
const REFRACTION_CODE = '251794006';
const VA_CODES = { 420050001: 'Uncorrected', 419775003: 'Best corrected', 419475002: 'Pinhole' };
const REFRACTION_COMPONENTS = {
  251795007: 'sphere',
  251797004: 'cylinder',
  251799001: 'axis',
  251796008: 'add',
};

function hasCode(resource, system, code) {
  return (resource.code?.coding ?? []).some((c) => c.system === system && c.code === code);
}

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

function formatQuantity(value) {
  return typeof value === 'number' ? String(value) : '';
}

function answerToString(answer) {
  if (!answer) {
    return '';
  }
  for (const key of ['valueString', 'valueDate', 'valueDateTime', 'valueTime', 'valueInteger', 'valueDecimal']) {
    if (answer[key] !== undefined) {
      return String(answer[key]);
    }
  }
  if (answer.valueBoolean !== undefined) {
    return answer.valueBoolean ? 'Yes' : 'No';
  }
  if (answer.valueCoding) {
    return answer.valueCoding.display ?? answer.valueCoding.code ?? '';
  }
  return '';
}

function questionnaireItems(items, rows, depth) {
  for (const item of items ?? []) {
    const answers = (item.answer ?? []).map(answerToString).filter(Boolean).join('; ');
    if (answers) {
      rows.push([{ text: item.text ?? item.linkId, bold: false, margin: [depth * 10, 0, 0, 0] }, answers]);
    }
    if (item.item) {
      questionnaireItems(item.item, rows, depth + 1);
    }
  }
}

function formatSigned(value) {
  if (value === undefined) {
    return 'pl';
  }
  return value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}

function buildExamSection(observations) {
  const byId = new Map(observations.map((o) => [`Observation/${o.id}`, o]));
  const panels = observations.filter((o) => hasCode(o, SNOMED, PANEL_CODE));
  const members = [];
  for (const panel of panels) {
    for (const ref of panel.hasMember ?? []) {
      const obs = byId.get(ref.reference);
      if (obs) {
        members.push(obs);
      }
    }
  }
  // Include device observations not inside a panel (instrument feeds)
  for (const obs of observations) {
    if (!hasCode(obs, SNOMED, PANEL_CODE) && !members.includes(obs) && obs.code?.text !== 'Assessment') {
      members.push(obs);
    }
  }

  const lines = [];

  const vaLines = {};
  for (const obs of members) {
    const vaCode = (obs.code?.coding ?? []).find((c) => c.system === SNOMED && VA_CODES[c.code]);
    if (vaCode && obs.valueString) {
      const label = VA_CODES[vaCode.code];
      vaLines[label] = vaLines[label] ?? {};
      vaLines[label][laterality(obs)] = obs.valueString;
    }
  }
  for (const [label, eyes] of Object.entries(vaLines)) {
    lines.push(`Visual acuity (${label.toLowerCase()}): OD ${eyes.OD ?? '—'}   OS ${eyes.OS ?? '—'}`);
  }

  const refraction = {};
  for (const obs of members) {
    if (hasCode(obs, SNOMED, REFRACTION_CODE)) {
      const parts = {};
      for (const comp of obs.component ?? []) {
        const kind = (comp.code?.coding ?? []).map((c) => REFRACTION_COMPONENTS[c.code]).find(Boolean);
        if (kind) {
          parts[kind] = comp.valueQuantity?.value;
        }
      }
      refraction[laterality(obs)] = parts;
    }
  }
  for (const eye of ['OD', 'OS']) {
    const r = refraction[eye];
    if (r) {
      let text = `Refraction ${eye}: ${formatSigned(r.sphere)}`;
      if (r.cylinder !== undefined || r.axis !== undefined) {
        text += ` ${formatSigned(r.cylinder)} x ${r.axis ?? '?'}`;
      }
      if (r.add !== undefined) {
        text += `  Add +${r.add.toFixed(2)}`;
      }
      lines.push(text);
    }
  }

  const iop = {};
  let iopMethod;
  for (const obs of members) {
    if (hasCode(obs, SNOMED, IOP_CODE)) {
      iop[laterality(obs)] = obs.valueQuantity?.value;
      iopMethod = iopMethod ?? obs.method?.coding?.[0]?.display;
    }
  }
  if (iop.OD !== undefined || iop.OS !== undefined) {
    lines.push(
      `IOP: OD ${formatQuantity(iop.OD) || '—'}  OS ${formatQuantity(iop.OS) || '—'} mmHg` +
        (iopMethod ? ` (${iopMethod})` : '')
    );
  }

  // Segments are stored per eye; merge into one row per structure (OD / OS)
  const segmentMap = new Map();
  for (const obs of members) {
    const codeText = obs.code?.text ?? '';
    if (codeText.includes('segment exam') && obs.component?.length) {
      const eye = laterality(obs);
      const structures = segmentMap.get(codeText) ?? new Map();
      for (const c of obs.component) {
        const name = c.code?.text;
        const value = c.valueString;
        if (name && value) {
          const entry = structures.get(name) ?? {};
          if (eye === 'OU') {
            entry.OD = entry.OD ?? value;
            entry.OS = entry.OS ?? value;
          } else {
            entry[eye] = value;
          }
          structures.set(name, entry);
        }
      }
      segmentMap.set(codeText, structures);
    }
  }
  const segments = [...segmentMap.entries()].map(([title, structures]) => ({
    title,
    findings: [...structures.entries()].map(([name, e]) =>
      e.OD && e.OD === e.OS
        ? `${name}: ${e.OD} (OU)`
        : `${name}: OD ${e.OD ?? '—'}   OS ${e.OS ?? '—'}`
    ),
  }));

  const panelNotes = panels.map((p) => p.note?.[0]?.text).filter(Boolean);

  return { lines, segments, panelNotes };
}

exports.handler = async function handler(medplum, event) {
  const input = event.input ?? {};
  const encounterId = input.resourceType === 'Encounter' ? input.id : input.encounterId;
  if (!encounterId) {
    throw new Error('Expected an Encounter or { encounterId }');
  }

  const encounter = await medplum.readResource('Encounter', encounterId);
  const patient = await medplum.readReference(encounter.subject);
  const encounterRef = `Encounter/${encounterId}`;

  const [observations, responses, impressions, provenances, tasks, addendumDocs] = await Promise.all([
    medplum.searchResources('Observation', { encounter: encounterRef, _count: '200' }),
    medplum.searchResources('QuestionnaireResponse', { encounter: encounterRef, _count: '50' }),
    medplum.searchResources('ClinicalImpression', { encounter: encounterRef, _count: '10' }),
    medplum.searchResources('Provenance', { target: encounterRef, _count: '50', _sort: '_lastUpdated' }),
    medplum.searchResources('Task', { encounter: encounterRef, _count: '50' }),
    medplum.searchResources('DocumentReference', {
      encounter: encounterRef,
      type: `${LOINC}|55107-7`,
      status: 'current',
      _sort: '_lastUpdated',
      _count: '50',
    }),
  ]);

  const mrn = patient.identifier?.find((i) => i.system === 'urn:clinic:mrn')?.value ?? patient.id;
  const patientName = `${patient.name?.[0]?.given?.join(' ') ?? ''} ${patient.name?.[0]?.family ?? ''}`.trim();
  const visitDate = (encounter.period?.start ?? '').slice(0, 10);
  const visitType = encounter.type?.[0]?.text ?? 'Office visit';
  const provider =
    encounter.participant?.find((p) => p.individual?.reference?.startsWith('Practitioner/'))?.individual?.display ??
    '';

  const content = [];

  content.push({ text: 'VISIT NOTE', style: 'docTitle' });
  content.push({
    columns: [
      [
        { text: patientName, bold: true },
        { text: `MRN: ${mrn}` },
        { text: `DOB: ${patient.birthDate ?? ''}   Sex: ${patient.gender ?? ''}` },
      ],
      [
        { text: visitType, bold: true, alignment: 'right' },
        { text: `Visit date: ${visitDate}`, alignment: 'right' },
        { text: provider ? `Provider: ${provider}` : '', alignment: 'right' },
      ],
    ],
    margin: [0, 4, 0, 10],
  });

  // Questionnaire sections in task order (History, Entrance Testing, Plan, ...)
  const responseById = new Map(responses.map((r) => [`QuestionnaireResponse/${r.id}`, r]));
  const renderedResponses = new Set();
  const orderedSections = [];
  for (const task of tasks) {
    const qrRef = (task.output ?? []).find((o) => o.valueReference?.reference?.startsWith('QuestionnaireResponse/'));
    const qr = qrRef && responseById.get(qrRef.valueReference.reference);
    if (qr) {
      orderedSections.push({ title: task.code?.text ?? 'Form', qr });
      renderedResponses.add(qr.id);
    }
  }
  for (const qr of responses) {
    if (!renderedResponses.has(qr.id)) {
      orderedSections.push({ title: 'Form', qr });
    }
  }
  for (const section of orderedSections) {
    const rows = [];
    questionnaireItems(section.qr.item, rows, 0);
    if (rows.length) {
      content.push({ text: section.title, style: 'sectionTitle' });
      content.push({
        table: { widths: ['40%', '60%'], body: rows },
        layout: 'noBorders',
        margin: [0, 0, 0, 6],
      });
    }
  }

  // Eye exam
  const exam = buildExamSection(observations);
  if (exam.lines.length || exam.segments.length) {
    content.push({ text: 'Eye Exam', style: 'sectionTitle' });
    for (const line of exam.lines) {
      content.push({ text: line, margin: [0, 0, 0, 2] });
    }
    for (const segment of exam.segments) {
      content.push({ text: segment.title, bold: true, margin: [0, 4, 0, 2] });
      for (const finding of segment.findings) {
        content.push({ text: finding, margin: [10, 0, 0, 1] });
      }
    }
    for (const note of exam.panelNotes) {
      content.push({ text: `Note: ${note}`, italics: true, margin: [0, 2, 0, 0] });
    }
  }

  // Per-problem assessment
  const assessments = observations.filter((o) => o.code?.text === 'Assessment' && o.valueString);
  if (assessments.length) {
    content.push({ text: 'Assessment', style: 'sectionTitle' });
    for (const a of assessments) {
      content.push({
        text: [{ text: `${a.focus?.[0]?.display ?? 'Problem'}: `, bold: true }, a.valueString],
        margin: [0, 0, 0, 3],
      });
    }
  }

  // Free-text chart note
  const chartNote = impressions.map((ci) => ci.note?.[0]?.text).filter(Boolean).join('\n');
  if (chartNote) {
    content.push({ text: 'Chart Note', style: 'sectionTitle' });
    content.push({ text: chartNote });
  }

  // Addenda (DocumentReference LOINC 55107-7 with inline text, written by SignAddendum)
  if (addendumDocs.length) {
    content.push({ text: 'Addenda', style: 'sectionTitle' });
    for (const doc of addendumDocs) {
      const data = doc.content?.[0]?.attachment?.data;
      let text = '';
      if (data) {
        if (typeof Buffer !== 'undefined') {
          text = Buffer.from(data, 'base64').toString('utf8');
        } else if (typeof atob !== 'undefined') {
          text = atob(data);
        }
      }
      content.push({
        text: [
          { text: `${doc.author?.[0]?.display ?? 'Provider'} (${(doc.date ?? '').slice(0, 10)}): `, bold: true },
          text,
        ],
        margin: [0, 0, 0, 3],
      });
    }
  }

  // Signatures
  const signatures = provenances.filter((p) =>
    (p.reason ?? []).some((r) => r.coding?.some((c) => c.code === 'SIGN'))
  );
  if (signatures.length) {
    content.push({ text: 'Attestation', style: 'sectionTitle' });
    for (const s of signatures) {
      content.push({
        text: `Electronically signed by ${s.agent?.[0]?.who?.display ?? 'provider'} on ${s.recorded?.slice(0, 19).replace('T', ' ')}`,
        italics: true,
      });
    }
  } else {
    content.push({ text: 'DRAFT — not signed', style: 'sectionTitle', color: '#b00000' });
  }

  const binary = await medplum.createPdf({
    content,
    styles: {
      docTitle: { fontSize: 14, bold: true, margin: [0, 0, 0, 2] },
      sectionTitle: { fontSize: 11, bold: true, margin: [0, 10, 0, 4] },
    },
    defaultStyle: { font: 'Helvetica', fontSize: 9 },
    footer: (currentPage, pageCount) => ({
      text: `${patientName} (MRN ${mrn}) — visit ${visitDate} — page ${currentPage} of ${pageCount}`,
      alignment: 'center',
      fontSize: 7,
      margin: [0, 6, 0, 0],
    }),
  });

  // Supersede any previous note for this encounter
  const previous = await medplum.searchResources('DocumentReference', {
    encounter: encounterRef,
    type: `${LOINC}|11506-3`,
    status: 'current',
  });

  const docRef = await medplum.createResource({
    resourceType: 'DocumentReference',
    status: 'current',
    docStatus: signatures.length ? 'final' : 'preliminary',
    type: { coding: [{ system: LOINC, code: '11506-3', display: 'Progress note' }], text: 'Visit note' },
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
    description: `${visitType} — ${visitDate}`,
    relatesTo: previous.map((p) => ({ code: 'replaces', target: { reference: `DocumentReference/${p.id}` } })),
    content: [
      {
        attachment: {
          contentType: 'application/pdf',
          url: `Binary/${binary.id}`,
          title: `visit-note-${visitDate}.pdf`,
        },
      },
    ],
  });

  for (const p of previous) {
    await medplum.patchResource('DocumentReference', p.id, [
      { op: 'replace', path: '/status', value: 'superseded' },
    ]);
  }

  return { documentReference: docRef.id, binary: binary.id, superseded: previous.length };
};
