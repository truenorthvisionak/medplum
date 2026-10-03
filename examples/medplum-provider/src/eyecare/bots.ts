// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';

/** Identifier system the clinic deploy script stamps on every bot. */
export const CLINIC_BOT_SYSTEM = 'urn:clinic:bot';

export const VISIT_NOTE_BOT = 'generate-visit-note';
export const SPECTACLE_RX_BOT = 'generate-spectacle-rx';
export const PCP_LETTER_BOT = 'generate-pcp-letter';

/** Executes a clinic bot by its stable identifier (see clinic/seed/deploy-bots.mjs). */
export function executeClinicBot(medplum: MedplumClient, name: string, body: unknown): Promise<any> {
  return medplum.executeBot({ system: CLINIC_BOT_SYSTEM, value: name }, body, 'application/fhir+json');
}
