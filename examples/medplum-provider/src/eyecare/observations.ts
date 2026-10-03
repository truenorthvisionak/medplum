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
  anteriorSegment: Partial<Record<AnteriorSegmentField, string>>;
  posteriorSegment: Partial<Record<PosteriorSegmentField, string>>;
  notes?: string;
}

export const EMPTY_EYE_EXAM: EyeExamValues = {
  visualAcuity: { uncorrected: {}, corrected: {}, pinhole: {} },
  refraction: { OD: {}, OS: {} },
  iop: {},
  anteriorSegment: {},
  posteriorSegment: {},
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

interface BuildContext {
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

  // Segment findings: one observation per segment, one component per structure
  const segments = [
    { code: ANTERIOR_SEGMENT_CODE, fields: ANTERIOR_SEGMENT_FIELDS, values: values.anteriorSegment },
    { code: POSTERIOR_SEGMENT_CODE, fields: POSTERIOR_SEGMENT_FIELDS, values: values.posteriorSegment },
  ] as const;
  for (const segment of segments) {
    const components = [];
    for (const field of segment.fields) {
      const value = (segment.values as Record<string, string | undefined>)[field.key]?.trim();
      if (value) {
        components.push({ code: { text: field.label }, valueString: value });
      }
    }
    if (components.length > 0) {
      const obs = baseObservation(ctx, segment.code, 'OU');
      obs.component = components;
      result.push(obs);
    }
  }

  return result;
}

/**
 * Builds a FHIR transaction bundle: a parent "eye exam" panel observation
 * whose hasMember references the individual observations.
 * Returns undefined if the form has no values at all.
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
