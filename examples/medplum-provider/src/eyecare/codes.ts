// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// Terminology for the eye exam feature, aligned with the HL7 FHIR Eye Care IG
// ("Ophthalmology Retinal", hl7.fhir.uv.eyecare, STU1 ballot) and IHE Eye Care.
//
// The IG's observation pattern: category=exam, code=SNOMED observable entity,
// laterality expressed via bodySite (this implementation uses pre-coordinated
// SNOMED eye-structure codes rather than the IG's BodyStructure references),
// UCUM units mm[Hg] / [diop] / deg.
//
// All SNOMED/LOINC codes below were verified against tx.fhir.org.

import type { CodeableConcept, Coding, Observation } from '@medplum/fhirtypes';

export const LOINC = 'http://loinc.org';
export const SNOMED = 'http://snomed.info/sct';
export const UCUM = 'http://unitsofmeasure.org';

/** Custom code system from the Eye Care IG for IOP methods not in SNOMED (e.g. rebound tonometry). */
export const EYECARE_IOP_METHODS = 'http://terminology.hl7.org/uv/eyecare/CodeSystem/iop-methods';

export type Laterality = 'OD' | 'OS' | 'OU';

/** SNOMED CT body site codes for laterality (right eye / left eye / both eyes). */
export const EYE_BODY_SITE: Record<Laterality, CodeableConcept> = {
  OD: {
    coding: [{ system: SNOMED, code: '1290032005', display: 'Structure of right eye proper' }],
    text: 'Right eye (OD)',
  },
  OS: {
    coding: [{ system: SNOMED, code: '1290031003', display: 'Structure of left eye proper' }],
    text: 'Left eye (OS)',
  },
  OU: {
    coding: [{ system: SNOMED, code: '362508001', display: 'Both eyes, entire' }],
    text: 'Both eyes (OU)',
  },
};

/** Reads the laterality back out of a stored observation's bodySite. */
export function getLaterality(obs: Observation): Laterality | undefined {
  const code = obs.bodySite?.coding?.[0]?.code;
  for (const laterality of ['OD', 'OS', 'OU'] as const) {
    if (EYE_BODY_SITE[laterality].coding?.[0]?.code === code) {
      return laterality;
    }
  }
  return undefined;
}

export type VaCorrection = 'uncorrected' | 'corrected' | 'pinhole';

/**
 * Visual acuity observation codes (SNOMED observable entities from the IG's
 * required value set). Laterality comes from bodySite, not the code.
 */
export const VISUAL_ACUITY_CODE: Record<VaCorrection, CodeableConcept> = {
  uncorrected: { coding: [{ system: SNOMED, code: '420050001', display: 'Uncorrected visual acuity' }] },
  corrected: { coding: [{ system: SNOMED, code: '419775003', display: 'Best corrected visual acuity' }] },
  pinhole: { coding: [{ system: SNOMED, code: '419475002', display: 'Pinhole visual acuity' }] },
};

/** The IG requires Observation.method on visual acuity; we record Snellen chart values. */
export const VA_METHOD_SNELLEN: CodeableConcept = {
  coding: [{ system: SNOMED, code: '400913005', display: 'Snellen chart' }],
};

/**
 * Intraocular pressure. The IG's observation-iop profile fixes the code to
 * SNOMED 41633001; the per-eye LOINC codes are included as secondary codings.
 */
export const IOP_CODE: Record<'OD' | 'OS', CodeableConcept> = {
  OD: {
    coding: [
      { system: SNOMED, code: '41633001', display: 'Intraocular pressure' },
      { system: LOINC, code: '79892-6', display: 'Right eye Intraocular pressure' },
    ],
    text: 'Intraocular pressure OD',
  },
  OS: {
    coding: [
      { system: SNOMED, code: '41633001', display: 'Intraocular pressure' },
      { system: LOINC, code: '79893-4', display: 'Left eye Intraocular pressure' },
    ],
    text: 'Intraocular pressure OS',
  },
};

/** Tonometry method codes from the IG's iop-methods value set. */
export const TONOMETRY_METHOD: Record<string, CodeableConcept> = {
  goldmann: { coding: [{ system: SNOMED, code: '389152008', display: 'Goldmann applanation tonometry' }] },
  ncr: { coding: [{ system: SNOMED, code: '389150000', display: 'Non-contact tonometry' }] },
  icare: { coding: [{ system: EYECARE_IOP_METHODS, code: 'rebound-tonometry', display: 'Rebound tonometry' }] },
  tonopen: { coding: [{ system: SNOMED, code: '252803002', display: 'Applanation tonometry' }] },
};

/**
 * Manifest (subjective) refraction, following the IG's example instances:
 * code SNOMED 251794006 "Refraction" with SNOMED-coded components,
 * laterality via bodySite.
 */
export const REFRACTION_CODE: Record<'OD' | 'OS', CodeableConcept> = {
  OD: { coding: [{ system: SNOMED, code: '251794006', display: 'Refraction' }], text: 'Manifest refraction OD' },
  OS: { coding: [{ system: SNOMED, code: '251794006', display: 'Refraction' }], text: 'Manifest refraction OS' },
};

/** SNOMED component codes for refraction values (same for both eyes; eye is in bodySite). */
export const REFRACTION_COMPONENT: Record<'sphere' | 'cylinder' | 'axis' | 'add', CodeableConcept> = {
  sphere: { coding: [{ system: SNOMED, code: '251795007', display: 'Power of sphere' }] },
  cylinder: { coding: [{ system: SNOMED, code: '251797004', display: 'Power of cylinder' }] },
  axis: { coding: [{ system: SNOMED, code: '251799001', display: 'Axis of cylinder' }] },
  add: { coding: [{ system: SNOMED, code: '251796008', display: 'Spherical addition' }] },
};

/** Parent "panel" observation code that groups the individual eye exam observations. */
export const EYE_EXAM_PANEL_CODE: CodeableConcept = {
  coding: [{ system: SNOMED, code: '36228007', display: 'Ophthalmic examination and evaluation' }],
  text: 'Eye examination',
};

// Narrative segment findings use text-only codes (per the IG's
// observation-eye-region-finding pattern); add SNOMED codings here if the
// clinic standardizes on specific exam procedure codes.
export const ANTERIOR_SEGMENT_CODE: CodeableConcept = {
  text: 'Anterior segment exam (slit lamp)',
};

export const POSTERIOR_SEGMENT_CODE: CodeableConcept = {
  text: 'Posterior segment exam (fundus)',
};

// Individual structures documented within each segment exam. Each becomes a
// component (text-only code + valueString) on the segment observation.
export const ANTERIOR_SEGMENT_FIELDS = [
  { key: 'general', label: 'General' },
  { key: 'lidsLashes', label: 'Lids/Lashes' },
  { key: 'adnexa', label: 'Adnexa' },
  { key: 'conjSclera', label: 'Conjunctiva/Sclera' },
  { key: 'cornea', label: 'Cornea' },
  { key: 'anteriorChamber', label: 'Anterior Chamber' },
  { key: 'iris', label: 'Iris' },
  { key: 'lens', label: 'Lens' },
] as const;

export const POSTERIOR_SEGMENT_FIELDS = [
  { key: 'vitreous', label: 'Vitreous' },
  { key: 'opticDisc', label: 'Optic Disc' },
  { key: 'cdRatio', label: 'C/D Ratio' },
  { key: 'macula', label: 'Macula' },
  { key: 'vessels', label: 'Vessels' },
  { key: 'periphery', label: 'Periphery' },
] as const;

export type AnteriorSegmentField = (typeof ANTERIOR_SEGMENT_FIELDS)[number]['key'];
export type PosteriorSegmentField = (typeof POSTERIOR_SEGMENT_FIELDS)[number]['key'];

/**
 * Per-problem assessment note (Nextech-style): one member observation per
 * problem-list Condition documented this visit. The Condition (with its ICD-10
 * coding) is referenced via Observation.focus.
 */
export const PROBLEM_ASSESSMENT_CODE: CodeableConcept = {
  text: 'Assessment',
};

export const EXAM_CATEGORY: CodeableConcept[] = [
  {
    coding: [
      {
        system: 'http://terminology.hl7.org/CodeSystem/observation-category',
        code: 'exam',
        display: 'Exam',
      },
    ],
  },
];

export function codingEquals(a: Coding | undefined, b: Coding | undefined): boolean {
  return !!a && !!b && a.system === b.system && a.code === b.code;
}

/** True if the observation's primary coding matches the concept's primary coding. */
export function observationMatches(obs: Observation | undefined, concept: CodeableConcept): boolean {
  return !!obs?.code?.coding?.some((c) => codingEquals(c, concept.coding?.[0]));
}
