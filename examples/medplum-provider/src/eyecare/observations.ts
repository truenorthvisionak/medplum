// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// Builders that turn eye exam form values into a FHIR transaction bundle of
// Observations, following the HL7 FHIR Eye Care IG observation patterns:
// one observation per eye (laterality via bodySite), quantities in UCUM units,
// and a parent "panel" observation grouping the exam via hasMember.

import { createReference } from '@medplum/core';
import type {
  Bundle,
  BundleEntry,
  CodeableConcept,
  Encounter,
  Observation,
  Patient,
  Practitioner,
  Reference,
} from '@medplum/fhirtypes';
import type { AnteriorSegmentField, Laterality, PosteriorSegmentField, VaCorrection } from './codes';
import {
  ANTERIOR_SEGMENT_CODE,
  ANTERIOR_SEGMENT_FIELDS,
  EXAM_CATEGORY,
  EYE_BODY_SITE,
  EYE_EXAM_PANEL_CODE,
  IOP_CODE,
  POSTERIOR_SEGMENT_CODE,
  POSTERIOR_SEGMENT_FIELDS,
  REFRACTION_CODE,
  REFRACTION_COMPONENT,
  TONOMETRY_METHOD,
  UCUM,
  VA_METHOD_SNELLEN,
  VISUAL_ACUITY_CODE,
  codingEquals,
  getLaterality,
  observationMatches,
} from './codes';

// Numeric form fields hold `number | string` so typing an in-progress value
// like "1." or "-" doesn't get wiped by the controlled input; strings are
// parsed when the exam is saved.
export type NumericInput = number | string;

export interface RefractionEyeValues {
  sphere?: NumericInput;
  cylinder?: NumericInput;
  axis?: NumericInput;
  add?: NumericInput;
}

export interface EyeExamValues {
  visualAcuity: Record<VaCorrection, { OD?: string; OS?: string }>;
  refraction: { OD: RefractionEyeValues; OS: RefractionEyeValues };
  iop: { OD?: NumericInput; OS?: NumericInput; method?: string };
  anteriorSegment: Record<'OD' | 'OS', Partial<Record<AnteriorSegmentField, string>>>;
  posteriorSegment: Record<'OD' | 'OS', Partial<Record<PosteriorSegmentField, string>>>;
  notes?: string;
}

export const EMPTY_EYE_EXAM: EyeExamValues = {
  visualAcuity: { uncorrected: {}, corrected: {}, pinhole: {} },
  refraction: { OD: {}, OS: {} },
  iop: {},
  anteriorSegment: { OD: {}, OS: {} },
  posteriorSegment: { OD: {}, OS: {} },
};

function toNumber(value: NumericInput | undefined): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

export interface BuildContext {
  patient: Patient;
  performer: Practitioner;
  encounter?: Encounter;
  effectiveDateTime: string;
}

function baseObservation(ctx: BuildContext, code: CodeableConcept, eye?: Laterality): Observation {
  const result: Observation = {
    resourceType: 'Observation',
    status: 'final',
    category: EXAM_CATEGORY,
    code,
    subject: createReference(ctx.patient),
    performer: [createReference(ctx.performer)],
    effectiveDateTime: ctx.effectiveDateTime,
  };
  if (ctx.encounter) {
    result.encounter = createReference(ctx.encounter);
  }
  if (eye) {
    result.bodySite = EYE_BODY_SITE[eye];
  }
  return result;
}

function quantity(value: number, unit: string, code: string): { value: number; unit: string; system: string; code: string } {
  return { value, unit, system: UCUM, code };
}

/**
 * Builds the individual member observations for an eye exam.
 * Only sections with values entered produce observations.
 * @param ctx - Patient, performer, encounter, and effective time for the observations.
 * @param values - The exam form values.
 * @returns One observation per filled exam element.
 */
export function buildEyeExamObservations(ctx: BuildContext, values: EyeExamValues): Observation[] {
  const result: Observation[] = [];

  // Visual acuity: one observation per correction type per eye
  for (const correction of Object.keys(values.visualAcuity) as VaCorrection[]) {
    for (const eye of ['OD', 'OS'] as const) {
      const va = values.visualAcuity[correction][eye]?.trim();
      if (va) {
        // Laterality is carried by bodySite (per the Eye Care IG), not the code
        const obs = baseObservation(ctx, VISUAL_ACUITY_CODE[correction], eye);
        obs.method = VA_METHOD_SNELLEN;
        obs.valueString = va;
        result.push(obs);
      }
    }
  }

  // Refraction: one observation per eye with sphere/cylinder/axis/add components
  for (const eye of ['OD', 'OS'] as const) {
    const r = values.refraction[eye];
    const sphere = toNumber(r.sphere);
    const cylinder = toNumber(r.cylinder);
    const axis = toNumber(r.axis);
    const add = toNumber(r.add);
    if (sphere !== undefined || cylinder !== undefined || axis !== undefined || add !== undefined) {
      const obs = baseObservation(ctx, REFRACTION_CODE[eye], eye);
      obs.component = [];
      if (sphere !== undefined) {
        obs.component.push({
          code: REFRACTION_COMPONENT.sphere,
          valueQuantity: quantity(sphere, 'diopters', '[diop]'),
        });
      }
      if (cylinder !== undefined) {
        obs.component.push({
          code: REFRACTION_COMPONENT.cylinder,
          valueQuantity: quantity(cylinder, 'diopters', '[diop]'),
        });
      }
      if (axis !== undefined) {
        obs.component.push({
          code: REFRACTION_COMPONENT.axis,
          valueQuantity: quantity(axis, 'degrees', 'deg'),
        });
      }
      if (add !== undefined) {
        obs.component.push({
          code: REFRACTION_COMPONENT.add,
          valueQuantity: quantity(add, 'diopters', '[diop]'),
        });
      }
      result.push(obs);
    }
  }

  // Intraocular pressure: one observation per eye
  for (const eye of ['OD', 'OS'] as const) {
    const iop = toNumber(values.iop[eye]);
    if (iop !== undefined) {
      const obs = baseObservation(ctx, IOP_CODE[eye], eye);
      obs.valueQuantity = quantity(iop, 'mmHg', 'mm[Hg]');
      if (values.iop.method && TONOMETRY_METHOD[values.iop.method]) {
        obs.method = TONOMETRY_METHOD[values.iop.method];
      }
      result.push(obs);
    }
  }

  // Segment findings: one observation per segment PER EYE, one component per structure
  const segments = [
    { code: ANTERIOR_SEGMENT_CODE, fields: ANTERIOR_SEGMENT_FIELDS, values: values.anteriorSegment },
    { code: POSTERIOR_SEGMENT_CODE, fields: POSTERIOR_SEGMENT_FIELDS, values: values.posteriorSegment },
  ] as const;
  for (const segment of segments) {
    for (const eye of ['OD', 'OS'] as const) {
      const components = [];
      for (const field of segment.fields) {
        const value = (segment.values[eye] as Record<string, string | undefined>)[field.key]?.trim();
        if (value) {
          components.push({ code: { text: field.label }, valueString: value });
        }
      }
      if (components.length > 0) {
        const obs = baseObservation(ctx, segment.code, eye);
        obs.component = components;
        result.push(obs);
      }
    }
  }

  return result;
}

/**
 * Builds a FHIR transaction bundle: a parent "eye exam" panel observation
 * whose hasMember references the individual observations.
 * Returns undefined if the form has no values at all.
 * @param ctx - Patient, performer, encounter, and effective time for the observations.
 * @param values - The exam form values.
 * @returns The transaction bundle, or undefined for an empty form.
 */
export function buildEyeExamBundle(ctx: BuildContext, values: EyeExamValues): Bundle | undefined {
  const members = buildEyeExamObservations(ctx, values);
  if (members.length === 0 && !values.notes?.trim()) {
    return undefined;
  }

  const entries: BundleEntry[] = [];
  const memberRefs: Reference<Observation>[] = [];

  for (const obs of members) {
    const fullUrl = `urn:uuid:${crypto.randomUUID()}`;
    entries.push({ fullUrl, resource: obs, request: { method: 'POST', url: 'Observation' } });
    memberRefs.push({ reference: fullUrl });
  }

  const panel = baseObservation(ctx, EYE_EXAM_PANEL_CODE);
  panel.hasMember = memberRefs;
  if (values.notes?.trim()) {
    panel.note = [{ text: values.notes.trim() }];
  }
  entries.push({
    fullUrl: `urn:uuid:${crypto.randomUUID()}`,
    resource: panel,
    request: { method: 'POST', url: 'Observation' },
  });

  return { resourceType: 'Bundle', type: 'transaction', entry: entries };
}

/**
 * Inverse of buildEyeExamObservations: reconstructs form values from a stored
 * exam (panel + members), used by "Copy forward last exam". Panel notes are
 * intentionally not copied — they are visit-specific.
 * @param panel - The exam panel observation (hasMember references).
 * @param members - Lookup of member observations by `Observation/<id>` reference.
 * @returns The reconstructed form values.
 */
export function valuesFromExam(panel: Observation, members: Map<string, Observation>): EyeExamValues {
  const values = structuredClone(EMPTY_EYE_EXAM);
  const resolved = (panel.hasMember ?? [])
    .map((ref) => (ref.reference ? members.get(ref.reference) : undefined))
    .filter((obs): obs is Observation => !!obs);

  for (const obs of resolved) {
    const eye = getLaterality(obs);

    for (const correction of Object.keys(values.visualAcuity) as VaCorrection[]) {
      if (observationMatches(obs, VISUAL_ACUITY_CODE[correction]) && (eye === 'OD' || eye === 'OS') && obs.valueString) {
        values.visualAcuity[correction][eye] = obs.valueString;
      }
    }

    if ((eye === 'OD' || eye === 'OS') && observationMatches(obs, REFRACTION_CODE[eye])) {
      for (const [kind, concept] of Object.entries(REFRACTION_COMPONENT)) {
        const comp = obs.component?.find((c) => c.code?.coding?.some((coding) => codingEquals(coding, concept.coding?.[0])));
        if (comp?.valueQuantity?.value !== undefined) {
          values.refraction[eye][kind as keyof RefractionEyeValues] = comp.valueQuantity.value;
        }
      }
    }

    if ((eye === 'OD' || eye === 'OS') && observationMatches(obs, IOP_CODE[eye]) && obs.valueQuantity?.value !== undefined) {
      values.iop[eye] = obs.valueQuantity.value;
      const methodCoding = obs.method?.coding?.[0];
      if (methodCoding && !values.iop.method) {
        values.iop.method = Object.entries(TONOMETRY_METHOD).find(([, concept]) =>
          codingEquals(concept.coding?.[0], methodCoding)
        )?.[0];
      }
    }

    const codeText = obs.code?.text ?? '';
    const segmentSpecs = [
      { match: ANTERIOR_SEGMENT_CODE.text as string, key: 'anteriorSegment' as const, fields: ANTERIOR_SEGMENT_FIELDS },
      { match: POSTERIOR_SEGMENT_CODE.text as string, key: 'posteriorSegment' as const, fields: POSTERIOR_SEGMENT_FIELDS },
    ];
    for (const spec of segmentSpecs) {
      if (codeText === spec.match && obs.component?.length) {
        // Legacy exams stored one OU observation per segment; write those into both eyes
        const targetEyes: ('OD' | 'OS')[] = eye === 'OD' || eye === 'OS' ? [eye] : ['OD', 'OS'];
        for (const comp of obs.component) {
          const field = spec.fields.find((f) => f.label === comp.code?.text);
          if (field && comp.valueString) {
            for (const targetEye of targetEyes) {
              (values[spec.key][targetEye] as Record<string, string>)[field.key] = comp.valueString;
            }
          }
        }
      }
    }
  }

  return values;
}

/**
 * True if the values contain any chartable exam content.
 * @param values - The exam form values.
 * @returns Whether any exam element is filled in.
 */
export function examHasValues(values: EyeExamValues): boolean {
  const vaFilled = Object.values(values.visualAcuity).some((eyes) => eyes.OD || eyes.OS);
  const refractionFilled = (['OD', 'OS'] as const).some((eye) =>
    Object.values(values.refraction[eye]).some((v) => v !== undefined)
  );
  const iopFilled = values.iop.OD !== undefined || values.iop.OS !== undefined;
  const segmentsFilled = (['OD', 'OS'] as const).some(
    (eye) =>
      Object.values(values.anteriorSegment[eye]).some(Boolean) ||
      Object.values(values.posteriorSegment[eye]).some(Boolean)
  );
  return vaFilled || refractionFilled || iopFilled || segmentsFilled;
}

/** Identifier system for the per-slot upsert of a visit's live exam. */
export const EXAM_SLOT_SYSTEM = 'urn:clinic:exam-slot';

/**
 * Builds a FHIR transaction that upserts the visit's exam in place, one
 * conditional PUT per filled observation "slot" (keyed by encounter + slot
 * identifier) and one conditional DELETE per emptied slot — so the exam is a
 * living document the clinician edits for the whole visit, with each slot
 * keeping its own version history. Requires an encounter.
 * @param ctx - Patient, performer, and the visit encounter the exam belongs to.
 * @param values - The current exam form values.
 * @returns A transaction bundle of conditional PUTs and DELETEs.
 */
export function buildExamUpsertBundle(ctx: BuildContext & { encounter: Encounter }, values: EyeExamValues): Bundle {
  const observations = buildEyeExamObservations(ctx, values);

  const slotKey = (obs: Observation): string => {
    const code = obs.code?.coding?.[0]?.code ?? obs.code?.text ?? 'obs';
    const eye = obs.bodySite?.coding?.[0]?.code ?? 'na';
    return `${ctx.encounter.id}:${code}:${eye}`;
  };

  const filled = new Map<string, Observation>();
  for (const obs of observations) {
    filled.set(slotKey(obs), obs);
  }

  const entries: BundleEntry[] = [];
  for (const [key, obs] of filled) {
    entries.push({
      resource: { ...obs, identifier: [{ system: EXAM_SLOT_SYSTEM, value: key }] },
      request: { method: 'PUT', url: `Observation?identifier=${EXAM_SLOT_SYSTEM}|${encodeURIComponent(key)}` },
    });
  }

  // Delete every possible slot that is not currently filled
  const allSlots: string[] = [];
  for (const correction of ['420050001', '419775003', '419475002']) {
    for (const eye of ['1290032005', '1290031003']) {
      allSlots.push(`${ctx.encounter.id}:${correction}:${eye}`);
    }
  }
  for (const code of ['251794006', '41633001']) {
    for (const eye of ['1290032005', '1290031003']) {
      allSlots.push(`${ctx.encounter.id}:${code}:${eye}`);
    }
  }
  for (const segment of [ANTERIOR_SEGMENT_CODE.text, POSTERIOR_SEGMENT_CODE.text]) {
    for (const eye of ['1290032005', '1290031003', '362508001']) {
      allSlots.push(`${ctx.encounter.id}:${segment}:${eye}`);
    }
  }
  for (const key of allSlots) {
    if (!filled.has(key)) {
      entries.push({
        request: { method: 'DELETE', url: `Observation?identifier=${EXAM_SLOT_SYSTEM}|${encodeURIComponent(key)}` },
      });
    }
  }

  return { resourceType: 'Bundle', type: 'transaction', entry: entries };
}

/**
 * Upserts the panel observation that groups a visit's exam (used by history
 * views and copy-forward). Call after buildExamUpsertBundle executes, with the
 * member observations the server returned.
 * @param ctx - Patient, performer, and the visit encounter the exam belongs to.
 * @param members - The saved member observations (must have server ids).
 * @param notes - Visit-specific note text for the panel.
 * @returns The panel observation to conditionally PUT.
 */
export function buildExamPanel(
  ctx: BuildContext & { encounter: Encounter },
  members: Observation[],
  notes: string | undefined
): Observation {
  const panel = baseObservation(ctx, EYE_EXAM_PANEL_CODE);
  panel.identifier = [{ system: EXAM_SLOT_SYSTEM, value: `${ctx.encounter.id}:panel` }];
  panel.hasMember = members.map((obs) => ({ reference: `Observation/${obs.id}` }));
  if (notes?.trim()) {
    panel.note = [{ text: notes.trim() }];
  }
  return panel;
}

const EXAM_OBSERVATION_CODES = new Set(['420050001', '419775003', '419475002', '251794006', '41633001', '36228007']);

/**
 * True if the observation is part of an eye exam (VA, refraction, IOP,
 * segment findings, or the exam panel itself).
 * @param obs - The observation to classify.
 * @returns Whether the observation belongs to an eye exam.
 */
export function isExamObservation(obs: Observation): boolean {
  const code = obs.code?.coding?.[0]?.code;
  if (code && EXAM_OBSERVATION_CODES.has(code)) {
    return true;
  }
  const text = obs.code?.text;
  return text === ANTERIOR_SEGMENT_CODE.text || text === POSTERIOR_SEGMENT_CODE.text;
}

/**
 * Rebuilds form values from a flat list of a visit's exam observations
 * (as loaded by encounter search), plus the panel's visit note text.
 * Also reports legacy exam observations saved before slot-based autosave
 * (no exam-slot identifier) so the form can replace them on its next save —
 * otherwise a cleared field would reappear from the legacy copy on reload.
 * @param observations - All observations attached to the encounter.
 * @returns The reconstructed form values, the panel's note text, and legacy exam observation ids.
 */
export function valuesFromObservations(observations: Observation[]): {
  values: EyeExamValues;
  notes?: string;
  legacyIds: string[];
} {
  const members = observations.filter(
    (obs) => !observationMatches(obs, EYE_EXAM_PANEL_CODE) && obs.code?.text !== 'Assessment'
  );
  const panel = observations.find((obs) => observationMatches(obs, EYE_EXAM_PANEL_CODE));
  const lookup = new Map(members.map((obs) => [`Observation/${obs.id}`, obs] as const));
  const syntheticPanel: Observation = {
    resourceType: 'Observation',
    status: 'final',
    code: EYE_EXAM_PANEL_CODE,
    hasMember: members.map((obs) => ({ reference: `Observation/${obs.id}` })),
  };
  const legacyIds = observations
    .filter(
      (obs) =>
        isExamObservation(obs) && !!obs.id && !obs.identifier?.some((i) => i.system === EXAM_SLOT_SYSTEM)
    )
    .map((obs) => obs.id as string);
  return { values: valuesFromExam(syntheticPanel, lookup), notes: panel?.note?.[0]?.text, legacyIds };
}
