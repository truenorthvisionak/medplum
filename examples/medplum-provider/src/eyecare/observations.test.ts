// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Bundle, Encounter, Observation, Patient, Practitioner } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { EYE_EXAM_PANEL_CODE, IOP_CODE, VISUAL_ACUITY_CODE } from './codes';
import type { EyeExamValues } from './observations';
import { EMPTY_EYE_EXAM, buildEyeExamBundle, buildEyeExamObservations, valuesFromExam } from './observations';

const patient: Patient = { resourceType: 'Patient', id: 'patient-1' };
const performer: Practitioner = { resourceType: 'Practitioner', id: 'doc-1' };
const ctx = { patient, performer, effectiveDateTime: '2026-08-29T10:00:00.000Z' };

function makeValues(overrides: Partial<EyeExamValues>): EyeExamValues {
  return { ...structuredClone(EMPTY_EYE_EXAM), ...overrides };
}

describe('buildEyeExamObservations', () => {
  test('empty form produces no observations', () => {
    expect(buildEyeExamObservations(ctx, structuredClone(EMPTY_EYE_EXAM))).toHaveLength(0);
  });

  test('visual acuity observations per eye and correction', () => {
    const values = makeValues({
      visualAcuity: { uncorrected: { OD: '20/40', OS: '20/30' }, corrected: { OD: '20/20' }, pinhole: {} },
    });
    const result = buildEyeExamObservations(ctx, values);
    expect(result).toHaveLength(3);
    const odUncorrected = result.find(
      (o) =>
        o.code.coding?.[0]?.code === VISUAL_ACUITY_CODE.uncorrected.coding?.[0]?.code &&
        o.bodySite?.text?.includes('Right eye')
    );
    expect(odUncorrected?.valueString).toBe('20/40');
    expect(odUncorrected?.method?.coding?.[0]?.display).toBe('Snellen chart');
    expect(odUncorrected?.subject?.reference).toBe('Patient/patient-1');
    expect(odUncorrected?.performer?.[0]?.reference).toBe('Practitioner/doc-1');
    expect(odUncorrected?.status).toBe('final');
  });

  test('IOP observation has mmHg quantity and method', () => {
    const values = makeValues({ iop: { OD: 17, OS: 18, method: 'goldmann' } });
    const result = buildEyeExamObservations(ctx, values);
    expect(result).toHaveLength(2);
    const od = result.find(
      (o) => o.code.coding?.[0]?.code === IOP_CODE.OD.coding?.[0]?.code && o.bodySite?.text?.includes('Right eye')
    );
    expect(od?.valueQuantity).toMatchObject({ value: 17, code: 'mm[Hg]' });
    expect(od?.code.coding?.[1]?.code).toBe('79892-6'); // per-eye LOINC secondary coding
    expect(od?.method?.coding?.[0]?.display).toContain('Goldmann');
  });

  test('refraction components include sphere, cylinder, axis, add', () => {
    const values = makeValues({
      refraction: { OD: { sphere: -2.25, cylinder: -0.75, axis: 90, add: 2 }, OS: {} },
    });
    const result = buildEyeExamObservations(ctx, values);
    expect(result).toHaveLength(1);
    expect(result[0].component).toHaveLength(4);
    const sphere = result[0].component?.find((c) => c.code.coding?.[0]?.display?.includes('sphere'));
    expect(sphere?.valueQuantity).toMatchObject({ value: -2.25, code: '[diop]' });
  });

  test('zero values are still recorded', () => {
    const values = makeValues({ refraction: { OD: { sphere: 0 }, OS: {} } });
    const result = buildEyeExamObservations(ctx, values);
    expect(result).toHaveLength(1);
    expect(result[0].component?.[0]?.valueQuantity?.value).toBe(0);
  });

  test('numeric fields accept typed string values, including decimals', () => {
    const values = makeValues({
      refraction: { OD: { sphere: '-1.5', axis: '90' }, OS: { sphere: '1.' } },
      iop: { OD: '17.5' },
    });
    const result = buildEyeExamObservations(ctx, values);
    const od = result.find((o) => o.code.coding?.[0]?.code === '251794006' && o.bodySite?.text?.includes('Right'));
    expect(od?.component?.find((c) => c.code.coding?.[0]?.display === 'Power of sphere')?.valueQuantity?.value).toBe(
      -1.5
    );
    const os = result.find((o) => o.code.coding?.[0]?.code === '251794006' && o.bodySite?.text?.includes('Left'));
    expect(os?.component?.[0]?.valueQuantity?.value).toBe(1);
    const iop = result.find((o) => o.code.coding?.[0]?.code === '41633001');
    expect(iop?.valueQuantity?.value).toBe(17.5);
  });

  test('unparseable numeric strings are dropped', () => {
    const values = makeValues({ refraction: { OD: { sphere: '-' }, OS: {} } });
    expect(buildEyeExamObservations(ctx, values)).toHaveLength(0);
  });

  test('observations link to the encounter when one is in context', () => {
    const encounter: Encounter = { resourceType: 'Encounter', id: 'enc-1', status: 'in-progress', class: { code: 'AMB' } };
    const values = makeValues({ iop: { OD: 15 } });
    const result = buildEyeExamObservations({ ...ctx, encounter }, values);
    expect(result[0].encounter?.reference).toBe('Encounter/enc-1');
    const bundle = buildEyeExamBundle({ ...ctx, encounter }, values);
    const panel = bundle?.entry?.map((e) => e.resource as Observation).find((o) => o.hasMember);
    expect(panel?.encounter?.reference).toBe('Encounter/enc-1');
  });

  test('segment fields become components on segment observations', () => {
    const values = makeValues({
      anteriorSegment: { lidsLashes: 'Normal', iris: 'No NVI OU' },
      posteriorSegment: { cdRatio: '0.3 OU' },
    });
    const result = buildEyeExamObservations(ctx, values);
    expect(result).toHaveLength(2);
    const anterior = result.find((o) => o.code.text?.includes('Anterior'));
    expect(anterior?.component).toHaveLength(2);
    expect(anterior?.component?.find((c) => c.code.text === 'Iris')?.valueString).toBe('No NVI OU');
    const posterior = result.find((o) => o.code.text?.includes('Posterior'));
    expect(posterior?.component?.[0]).toMatchObject({ code: { text: 'C/D Ratio' }, valueString: '0.3 OU' });
  });
});

describe('valuesFromExam', () => {
  test('round-trips a full exam back into form values (minus notes)', () => {
    const original = makeValues({
      visualAcuity: { uncorrected: { OD: '20/40', OS: '20/30' }, corrected: { OD: '20/20', OS: '20/25' }, pinhole: {} },
      refraction: { OD: { sphere: -2.25, cylinder: -0.75, axis: 90, add: 2 }, OS: { sphere: -1.5 } },
      iop: { OD: 17, OS: 18, method: 'goldmann' },
      anteriorSegment: { lidsLashes: 'Normal', iris: 'No NVI OU' },
      posteriorSegment: { cdRatio: '0.3 OU' },
      notes: 'visit-specific note',
    });
    const bundle = buildEyeExamBundle(ctx, original);
    const resources = (bundle?.entry ?? []).map((e, i) => ({ ...(e.resource as Observation), id: `obs-${i}` }));
    // Relink hasMember the way the search path keys members (Observation/<id>)
    const byUrl = new Map<string, Observation>();
    const panel = resources.find((o) => o.hasMember) as Observation;
    const urls = (bundle?.entry ?? []).map((e) => e.fullUrl as string);
    resources.forEach((obs, i) => byUrl.set(urls[i], obs));
    const linkedPanel: Observation = {
      ...panel,
      hasMember: panel.hasMember?.map((m) => ({ reference: `Observation/${byUrl.get(m.reference as string)?.id}` })),
    };
    const lookup = new Map(resources.map((o) => [`Observation/${o.id}`, o] as const));

    const restored = valuesFromExam(linkedPanel, lookup);
    expect(restored.visualAcuity).toEqual(original.visualAcuity);
    expect(restored.refraction).toEqual(original.refraction);
    expect(restored.iop).toEqual(original.iop);
    expect(restored.anteriorSegment).toEqual(original.anteriorSegment);
    expect(restored.posteriorSegment).toEqual(original.posteriorSegment);
    expect(restored.notes).toBeUndefined();
  });
});

describe('buildEyeExamBundle', () => {
  test('returns undefined for empty form', () => {
    expect(buildEyeExamBundle(ctx, structuredClone(EMPTY_EYE_EXAM))).toBeUndefined();
  });

  test('builds transaction bundle with panel referencing members', () => {
    const values = makeValues({
      visualAcuity: { uncorrected: { OD: '20/20' }, corrected: {}, pinhole: {} },
      iop: { OD: 15 },
      notes: 'Healthy exam',
    });
    const bundle = buildEyeExamBundle(ctx, values) as Bundle;
    expect(bundle.type).toBe('transaction');
    expect(bundle.entry).toHaveLength(3);
    for (const entry of bundle.entry ?? []) {
      expect(entry.fullUrl).toMatch(/^urn:uuid:/);
      expect(entry.request).toMatchObject({ method: 'POST', url: 'Observation' });
    }
    const panel = bundle.entry?.map((e) => e.resource as Observation).find((o) => o.hasMember) as Observation;
    expect(panel.code).toEqual(EYE_EXAM_PANEL_CODE);
    expect(panel.hasMember).toHaveLength(2);
    expect(panel.note?.[0]?.text).toBe('Healthy exam');
    const memberUrls = new Set(panel.hasMember?.map((m) => m.reference));
    const entryUrls = new Set(bundle.entry?.map((e) => e.fullUrl));
    for (const url of memberUrls) {
      expect(entryUrls.has(url as string)).toBe(true);
    }
  });
});
