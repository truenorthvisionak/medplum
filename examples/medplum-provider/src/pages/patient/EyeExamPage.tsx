// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Divider, Stack, Table, Text } from '@mantine/core';
import type { Encounter, Observation } from '@medplum/fhirtypes';
import { Loading, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { EyeExamForm } from '../../components/eyecare/EyeExamForm';
import { EYE_EXAM_PANEL_CODE, SNOMED } from '../../eyecare/codes';
import type { EyeExamSummary } from '../../eyecare/summary';
import { summarizeEyeExam } from '../../eyecare/summary';
import { usePatient } from '../../hooks/usePatient';

// Encounter statuses that count as an "open" visit an exam can attach to
const OPEN_ENCOUNTER_STATUSES = new Set(['planned', 'arrived', 'triaged', 'in-progress', 'onleave']);

export function EyeExamPage(): JSX.Element {
  const medplum = useMedplum();
  const patient = usePatient();
  const [history, setHistory] = useState<EyeExamSummary[] | undefined>(undefined);
  const [activeEncounter, setActiveEncounter] = useState<Encounter | undefined>(undefined);

  // The most recent open visit for this patient; saved exams attach to it
  useEffect(() => {
    if (!patient?.id) {
      return;
    }
    medplum
      .searchResources(
        'Encounter',
        { subject: `Patient/${patient.id}`, _sort: '-_lastUpdated', _count: '20' },
        { cache: 'no-cache' }
      )
      .then((encounters) => setActiveEncounter(encounters.find((e) => OPEN_ENCOUNTER_STATUSES.has(e.status))))
      .catch(console.error);
  }, [medplum, patient?.id]);

  const loadHistory = useCallback(async (): Promise<void> => {
    if (!patient?.id) {
      return;
    }
    const bundle = await medplum.search(
      'Observation',
      {
        patient: `Patient/${patient.id}`,
        code: `${SNOMED}|${EYE_EXAM_PANEL_CODE.coding?.[0]?.code}`,
        _sort: '-date',
        _count: '20',
        _include: 'Observation:has-member',
      },
      { cache: 'no-cache' }
    );
    const resources = (bundle.entry ?? []).map((e) => e.resource as Observation).filter(Boolean);
    const members = new Map<string, Observation>();
    for (const obs of resources) {
      members.set(`Observation/${obs.id}`, obs);
    }
    const panels = resources.filter((obs) => obs.hasMember);
    setHistory(panels.map((panel) => summarizeEyeExam(panel, members)));
  }, [medplum, patient?.id]);

  useEffect(() => {
    loadHistory().catch(console.error);
  }, [loadHistory]);

  if (!patient) {
    return <Loading />;
  }

  const attachLabel = activeEncounter
    ? `Will attach to the open visit: ${activeEncounter.type?.[0]?.text ?? 'Visit'} (${activeEncounter.status})`
    : 'No open visit — this exam will be saved to the chart only.';

  return (
    <Stack gap="md" p="md">
      <EyeExamForm patient={patient} encounter={activeEncounter} attachLabel={attachLabel} onSaved={loadHistory} />

      <Divider label="Previous Exams" labelPosition="left" />
      {!history && <Loading />}
      {history && history.length === 0 && (
        <Text c="dimmed" size="sm">
          No previous eye exams recorded.
        </Text>
      )}
      {history && history.length > 0 && (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>VA (sc)</Table.Th>
              <Table.Th>VA (cc)</Table.Th>
              <Table.Th>IOP</Table.Th>
              <Table.Th>Refraction</Table.Th>
              <Table.Th>Notes</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {history.map((exam) => (
              <Table.Tr key={exam.panelId}>
                <Table.Td>{exam.date}</Table.Td>
                <Table.Td>{exam.vaUncorrected}</Table.Td>
                <Table.Td>{exam.vaCorrected}</Table.Td>
                <Table.Td>{exam.iop}</Table.Td>
                <Table.Td>{exam.refraction}</Table.Td>
                <Table.Td>{exam.notes}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
