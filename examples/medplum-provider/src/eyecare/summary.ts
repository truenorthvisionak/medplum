// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// Turns a stored eye exam (panel observation + member observations)
// back into compact display strings for the exam history table.

import type { Observation } from '@medplum/fhirtypes';
import type { Laterality } from './codes';
import {
  IOP_CODE,
  REFRACTION_CODE,
  REFRACTION_COMPONENT,
  VISUAL_ACUITY_CODE,
  codingEquals,
  getLaterality,
  observationMatches,
} from './codes';

export interface EyeExamSummary {
  panelId: string;
  date: string;
  vaUncorrected: string;
  vaCorrected: string;
  iop: string;
  refraction: string;
  notes: string;
}

function formatSigned(value: number | undefined): string {
  if (value === undefined) {
    return 'pl';
  }
  return value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}

function getComponent(obs: Observation, kind: keyof typeof REFRACTION_COMPONENT): number | undefined {
  const target = REFRACTION_COMPONENT[kind].coding?.[0];
  const comp = obs.component?.find((c) => c.code?.coding?.some((coding) => codingEquals(coding, target)));
  return comp?.valueQuantity?.value;
}

function formatRefraction(obs: Observation | undefined): string | undefined {
  if (!obs?.component?.length) {
    return undefined;
  }
  const sphere = getComponent(obs, 'sphere');
  const cylinder = getComponent(obs, 'cylinder');
  const axis = getComponent(obs, 'axis');
  const add = getComponent(obs, 'add');
  let result = formatSigned(sphere);
  if (cylinder !== undefined || axis !== undefined) {
    result += ` ${formatSigned(cylinder)} x ${axis ?? '?'}`;
  }
  if (add !== undefined) {
    result += ` Add +${add.toFixed(2)}`;
  }
  return result;
}

export function summarizeEyeExam(panel: Observation, members: Map<string, Observation>): EyeExamSummary {
  const resolved = (panel.hasMember ?? [])
    .map((ref) => (ref.reference ? members.get(ref.reference) : undefined))
    .filter((obs): obs is Observation => !!obs);

  const byEye = (obs: Observation, eye: Laterality): boolean => getLaterality(obs) === eye;

  const findVa = (correction: 'uncorrected' | 'corrected', eye: 'OD' | 'OS'): string | undefined =>
    resolved.find((obs) => observationMatches(obs, VISUAL_ACUITY_CODE[correction]) && byEye(obs, eye))?.valueString;

  const findIop = (eye: 'OD' | 'OS'): number | undefined =>
    resolved.find((obs) => observationMatches(obs, IOP_CODE[eye]) && byEye(obs, eye))?.valueQuantity?.value;

  const findRefraction = (eye: 'OD' | 'OS'): Observation | undefined =>
    resolved.find((obs) => observationMatches(obs, REFRACTION_CODE[eye]) && byEye(obs, eye));

  const vaPair = (correction: 'uncorrected' | 'corrected'): string => {
    const od = findVa(correction, 'OD');
    const os = findVa(correction, 'OS');
    return od || os ? `${od ?? '—'} / ${os ?? '—'}` : '—';
  };

  const iopOd = findIop('OD');
  const iopOs = findIop('OS');

  const refractionOd = formatRefraction(findRefraction('OD'));
  const refractionOs = formatRefraction(findRefraction('OS'));

  return {
    panelId: panel.id as string,
    date: panel.effectiveDateTime ? new Date(panel.effectiveDateTime).toLocaleDateString() : '—',
    vaUncorrected: vaPair('uncorrected'),
    vaCorrected: vaPair('corrected'),
    iop: iopOd !== undefined || iopOs !== undefined ? `${iopOd ?? '—'} / ${iopOs ?? '—'} mmHg` : '—',
    refraction: refractionOd || refractionOs ? `OD ${refractionOd ?? '—'}  OS ${refractionOs ?? '—'}` : '—',
    notes: panel.note?.[0]?.text ?? '',
  };
}
