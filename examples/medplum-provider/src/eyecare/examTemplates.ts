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
  conjSclera: 'White and quiet OU',
  cornea: 'Clear, no staining OU',
  anteriorChamber: 'Deep and quiet OU',
  iris: 'Flat and intact, no NVI OU',
  lens: 'Clear OU',
};

const NORMAL_POSTERIOR: Record<PosteriorSegmentField, string> = {
  vitreous: 'Clear OU',
  opticDisc: 'Pink, healthy rim, distinct margins OU',
  cdRatio: '0.3 OU',
  macula: 'Flat, even pigmentation, no drusen OU',
  vessels: 'Normal course and caliber, A/V 2/3 OU',
  periphery: 'Flat and intact 360 OU, no holes or tears',
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
      iris: 'No NVI OU',
    },
    posteriorSegment: {
      ...NORMAL_POSTERIOR,
      vitreous: 'Clear, no hemorrhage OU',
      opticDisc: 'Pink, healthy rim, no NVD OU',
      macula: 'No CSME, no exudates or hemorrhages OU',
      vessels: 'No NVE, no venous beading or IRMA OU',
      periphery: 'No dot-blot hemorrhages or microaneurysms OU',
    },
  },
  {
    name: 'Glaucoma Evaluation',
    anteriorSegment: {
      ...NORMAL_ANTERIOR,
      anteriorChamber: 'Deep and quiet, angles open Van Herick IV OU',
    },
    posteriorSegment: {
      ...NORMAL_POSTERIOR,
      opticDisc: 'No notching, hemorrhage, or pallor OU',
      cdRatio: '0.5 OU, symmetric',
      vessels: 'Normal course and caliber, no baring OU',
    },
  },
];
