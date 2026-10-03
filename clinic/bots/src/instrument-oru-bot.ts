// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0

// Receives HL7v2 ORU^R01 results from pre-test instruments (autorefractor,
// keratometer, non-contact tonometer, lensmeter) — normally relayed through
// the Open Integration Engine — and stores them as FHIR Observations using
// the same LOINC/SNOMED codes as the provider app's eye exam feature.
//
// Expected inbound mapping (configure the OIE channel to emit OBX-3 as one of
// the OBSERVATION_MAP keys, or extend the map to match your instruments'
// native codes):
//
//   OBX|1|NM|IOP_OD||17|mm[Hg]
//   OBX|2|NM|SPH_OD||-2.25|[diop]
//   ...
//
// Patient matching is by MRN in PID-3 against Patient.identifier.

import type { BotEvent, Hl7Message, MedplumClient } from '@medplum/core';
import type { CodeableConcept, Observation } from '@medplum/fhirtypes';

const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';
const UCUM = 'http://unitsofmeasure.org';

export const MRN_SYSTEM = 'urn:clinic:mrn';

interface ObservationMapping {
  code: CodeableConcept;
  bodySite: CodeableConcept;
  unit?: { unit: string; code: string };
}

const RIGHT_EYE: CodeableConcept = {
  coding: [{ system: SNOMED, code: '1290032005', display: 'Structure of right eye proper' }],
  text: 'Right eye (OD)',
};
const LEFT_EYE: CodeableConcept = {
  coding: [{ system: SNOMED, code: '1290031003', display: 'Structure of left eye proper' }],
  text: 'Left eye (OS)',
};

const DIOPTERS = { unit: 'diopters', code: '[diop]' };
const MM_HG = { unit: 'mmHg', code: 'mm[Hg]' };
const DEGREES = { unit: 'degrees', code: 'deg' };
const MM = { unit: 'mm', code: 'mm' };

/** Instrument observation IDs (OBX-3) to FHIR codes. */
export const OBSERVATION_MAP: Record<string, ObservationMapping> = {
  IOP_OD: {
    code: { coding: [{ system: LOINC, code: '79892-6', display: 'Right eye Intraocular pressure' }] },
    bodySite: RIGHT_EYE,
    unit: MM_HG,
  },
  IOP_OS: {
    code: { coding: [{ system: LOINC, code: '79893-4', display: 'Left eye Intraocular pressure' }] },
    bodySite: LEFT_EYE,
    unit: MM_HG,
  },
  SPH_OD: {
    code: { coding: [{ system: LOINC, code: '65890-6', display: 'Spherical power Right eye' }] },
    bodySite: RIGHT_EYE,
    unit: DIOPTERS,
  },
  SPH_OS: {
    code: { coding: [{ system: LOINC, code: '65894-8', display: 'Spherical power Left eye' }] },
    bodySite: LEFT_EYE,
    unit: DIOPTERS,
  },
  CYL_OD: {
    code: { coding: [{ system: LOINC, code: '65892-2', display: 'Cylindrical power Right eye' }] },
    bodySite: RIGHT_EYE,
    unit: DIOPTERS,
  },
  CYL_OS: {
    code: { coding: [{ system: LOINC, code: '65896-3', display: 'Cylindrical power Left eye' }] },
    bodySite: LEFT_EYE,
    unit: DIOPTERS,
  },
  AXIS_OD: {
    code: { coding: [{ system: LOINC, code: '65891-4', display: 'Cylinder axis Right eye' }] },
    bodySite: RIGHT_EYE,
    unit: DEGREES,
  },
  AXIS_OS: {
    code: { coding: [{ system: LOINC, code: '65895-5', display: 'Cylinder axis Left eye' }] },
    bodySite: LEFT_EYE,
    unit: DEGREES,
  },
  // Keratometry: text-only codes; replace with your instrument's preferred
  // coding if the clinic standardizes one.
  K1_OD: {
    code: { text: 'Keratometry K1 (right eye)' },
    bodySite: RIGHT_EYE,
    unit: MM,
  },
  K1_OS: {
    code: { text: 'Keratometry K1 (left eye)' },
    bodySite: LEFT_EYE,
    unit: MM,
  },
};

export async function handler(medplum: MedplumClient, event: BotEvent): Promise<Hl7Message> {
  const input = event.input as Hl7Message;

  const messageType = input.getSegment('MSH')?.getField(9)?.getComponent(1);
  if (messageType !== 'ORU') {
    return input.buildAck();
  }

  const mrn = input.getSegment('PID')?.getField(3)?.getComponent(1);
  if (!mrn) {
    console.log('ORU message missing PID-3 MRN; ignoring');
    return input.buildAck();
  }

  const patient = await medplum.searchOne('Patient', `identifier=${MRN_SYSTEM}|${mrn}`);
  if (!patient) {
    // Do not auto-create patients from instrument results — flag for a human.
    console.log(`No patient found for MRN ${mrn}`);
    await medplum.createResource({
      resourceType: 'Task',
      status: 'requested',
      intent: 'order',
      code: { text: 'Unmatched instrument result' },
      description: `Received instrument ORU for unknown MRN ${mrn}. Match the patient and re-send.`,
    });
    return input.buildAck();
  }

  const sendingApp = input.getSegment('MSH')?.getField(3)?.getComponent(1) ?? 'instrument';
  const observationDateTime = new Date().toISOString();

  const created: string[] = [];
  for (const segment of input.getAllSegments('OBX')) {
    const obsId = segment.getField(3)?.getComponent(1);
    const rawValue = segment.getField(5)?.getComponent(1);
    if (!obsId || !rawValue) {
      continue;
    }
    const mapping = OBSERVATION_MAP[obsId];
    if (!mapping) {
      console.log(`Unmapped observation ID ${obsId}; skipping`);
      continue;
    }

    const observation: Observation = {
      resourceType: 'Observation',
      status: 'final',
      code: mapping.code,
      bodySite: mapping.bodySite,
      subject: { reference: `Patient/${patient.id}` },
      effectiveDateTime: observationDateTime,
      device: { display: sendingApp },
    };

    const numericValue = Number(rawValue);
    if (!Number.isNaN(numericValue) && mapping.unit) {
      observation.valueQuantity = {
        value: numericValue,
        unit: mapping.unit.unit,
        system: UCUM,
        code: mapping.unit.code,
      };
    } else {
      observation.valueString = rawValue;
    }

    const result = await medplum.createResource(observation);
    created.push(result.id as string);
  }

  console.log(`Created ${created.length} observations for patient ${patient.id}`);
  return input.buildAck();
}
