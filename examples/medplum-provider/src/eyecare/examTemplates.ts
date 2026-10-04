// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// Exam templates: named sets of default findings that pre-fill every anterior
// and posterior segment field in one click. The clinician then edits only what
// is abnormal. Add clinic-specific templates to EXAM_TEMPLATES.

import type { AnteriorSegmentField, PosteriorSegmentField } from './codes';

export interface EyeExamTemplate {
  name: string;
  anteriorSegment: Record<AnteriorSegmentField, string>;
  posteriorSegment: Record<PosteriorSegmentField, string>;
}

const NORMAL_ANTERIOR: Record<AnteriorSegmentField, string> = {
  general: 'Alert and oriented, no acute distress',
  lidsLashes: 'Normal, no blepharitis or lesions',
  adnexa: 'Normal, no ptosis or proptosis',
  conjSclera: 'White and quiet',
  cornea: 'Clear, no staining',
  anteriorChamber: 'Deep and quiet',
  iris: 'Flat and intact, no NVI',
  lens: 'Clear',
};

const NORMAL_POSTERIOR: Record<PosteriorSegmentField, string> = {
  vitreous: 'Clear',
  opticDisc: 'Pink, healthy rim, distinct margins',
  cdRatio: '0.3',
  macula: 'Flat, even pigmentation, no drusen',
  vessels: 'Normal course and caliber, A/V 2/3',
  periphery: 'Flat and intact 360°, no holes or tears',
};

export const EXAM_TEMPLATES: EyeExamTemplate[] = [
  {
    name: 'Normal Comprehensive Exam',
    anteriorSegment: NORMAL_ANTERIOR,
    posteriorSegment: NORMAL_POSTERIOR,
  },
  {
    name: 'Diabetic Eye Exam',
    anteriorSegment: {
      ...NORMAL_ANTERIOR,
      iris: 'No NVI',
    },
    posteriorSegment: {
      ...NORMAL_POSTERIOR,
      vitreous: 'Clear, no hemorrhage',
      opticDisc: 'Pink, healthy rim, no NVD',
      macula: 'No CSME, no exudates or hemorrhages',
      vessels: 'No NVE, no venous beading or IRMA',
      periphery: 'No dot-blot hemorrhages or microaneurysms',
    },
  },
  {
    name: 'Glaucoma Evaluation',
    anteriorSegment: {
      ...NORMAL_ANTERIOR,
      anteriorChamber: 'Deep and quiet, angles open Van Herick IV',
    },
    posteriorSegment: {
      ...NORMAL_POSTERIOR,
      opticDisc: 'No notching, hemorrhage, or pallor',
      cdRatio: '0.5, symmetric',
      vessels: 'Normal course and caliber, no baring',
    },
  },
];
