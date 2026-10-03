// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0
import { Hl7Message, indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { SEARCH_PARAMETER_BUNDLE_FILES, readJson } from '@medplum/definitions';
import type { Bot, Bundle, Observation, Reference, SearchParameter, Task } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { beforeAll, describe, expect, test } from 'vitest';
import { MRN_SYSTEM, handler } from './instrument-oru-bot';

const bot: Reference<Bot> = { reference: 'Bot/123' };
const contentType = 'x-application/hl7-v2+er7';
const secrets = {};

function oruMessage(mrn: string): Hl7Message {
  return Hl7Message.parse(
    [
      `MSH|^~\\&|TONOREF3|PRETEST|MEDPLUM|CLINIC|20260829080000||ORU^R01|MSG0001|P|2.5.1`,
      `PID|1||${mrn}^^^CLINIC^MR||TEST^PATIENT||19800101|F`,
      `OBR|1|||AUTOREF^Autorefraction and tonometry`,
      `OBX|1|NM|IOP_OD||17|mm[Hg]`,
      `OBX|2|NM|IOP_OS||18|mm[Hg]`,
      `OBX|3|NM|SPH_OD||-2.25|[diop]`,
      `OBX|4|NM|CYL_OD||-0.75|[diop]`,
      `OBX|5|NM|AXIS_OD||90|deg`,
      `OBX|6|NM|UNKNOWN_CODE||42|`,
    ].join('\r')
  );
}

describe('instrument-oru-bot', () => {
  beforeAll(() => {
    indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
    indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
    for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
      indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
    }
  });

  test('creates observations for matched patient', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({
      resourceType: 'Patient',
      identifier: [{ system: MRN_SYSTEM, value: 'MRN1234' }],
    });

    const ack = await handler(medplum, { bot, input: oruMessage('MRN1234'), contentType, secrets });
    expect(ack.getSegment('MSA')).toBeDefined();

    const observations = await medplum.searchResources('Observation', `subject=Patient/${patient.id}`);
    expect(observations).toHaveLength(5); // UNKNOWN_CODE skipped

    const iopOd = observations.find((o: Observation) => o.code?.coding?.[0]?.code === '79892-6');
    expect(iopOd?.valueQuantity).toMatchObject({ value: 17, code: 'mm[Hg]' });
    expect(iopOd?.bodySite?.text).toContain('Right eye');
  });

  test('creates task for unknown MRN instead of auto-creating patient', async () => {
    const medplum = new MockClient();
    const ack = await handler(medplum, { bot, input: oruMessage('NOPE999'), contentType, secrets });
    expect(ack.getSegment('MSA')).toBeDefined();

    const tasks = await medplum.searchResources('Task', 'status=requested');
    expect(tasks.some((t: Task) => t.description?.includes('NOPE999'))).toBe(true);

    const observations = await medplum.searchResources('Observation', '_count=100');
    expect(observations.filter((o: Observation) => o.code?.coding?.[0]?.system === 'http://loinc.org')).toHaveLength(0);
  });

  test('ignores non-ORU messages', async () => {
    const medplum = new MockClient();
    const adt = Hl7Message.parse(
      `MSH|^~\\&|EMR||FORUM||20260829080000||ADT^A08|MSG0002|P|2.5.1\rPID|1||MRN1234^^^CLINIC^MR||TEST^PATIENT`
    );
    const ack = await handler(medplum, { bot, input: adt, contentType, secrets });
    expect(ack.getSegment('MSA')).toBeDefined();
  });
});
