// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Card, Group, Table, Text, Title } from '@mantine/core';
import type { Encounter, Observation } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { EYE_EXAM_PANEL_CODE, SNOMED } from '../../eyecare/codes';
import type { EyeExamSummary } from '../../eyecare/summary';
import { summarizeEyeExam } from '../../eyecare/summary';

export interface EyeExamCardProps {
  readonly encounter: Encounter;
}

/**
 * Shows the structured eye exam(s) recorded during this visit, with a link to
 * the patient's Eye Exam tab where they are charted.
 */
export function EyeExamCard(props: EyeExamCardProps): JSX.Element | null {
  const { encounter } = props;
  const medplum = useMedplum();
  const [exams, setExams] = useState<EyeExamSummary[] | undefined>(undefined);
  const patientId = encounter.subject?.reference?.split('/')[1];

  useEffect(() => {
    let active = true;
    medplum
      .search(
        'Observation',
        {
          encounter: `Encounter/${encounter.id}`,
          code: `${SNOMED}|${EYE_EXAM_PANEL_CODE.coding?.[0]?.code}`,
          _sort: '-date',
          _count: '10',
          _include: 'Observation:has-member',
        },
        { cache: 'no-cache' }
      )
      .then((bundle) => {
        if (!active) {
          return;
        }
        const resources = (bundle.entry ?? []).map((e) => e.resource as Observation).filter(Boolean);
        const members = new Map<string, Observation>();
        for (const obs of resources) {
          members.set(`Observation/${obs.id}`, obs);
        }
        const panels = resources.filter((obs) => obs.hasMember);
        setExams(panels.map((panel) => summarizeEyeExam(panel, members)));
      })
      .catch(console.error);
    return () => {
      active = false;
    };
  }, [medplum, encounter.id]);

  return (
    <Card withBorder shadow="sm" mt="md">
      <Group justify="space-between">
        <Title order={4}>Eye Exam</Title>
        {patientId && (
          <Anchor component={Link} to={`/Patient/${patientId}/eye-exam`} size="sm">
            Open Eye Exam tab
          </Anchor>
        )}
      </Group>
      {exams && exams.length === 0 && (
        <Text c="dimmed" size="sm" mt="xs">
          No eye exam recorded for this visit yet. Chart it in the Eye Exam tab while this visit is open and it will
          attach here automatically.
        </Text>
      )}
      {exams && exams.length > 0 && (
        <Table mt="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>VA (sc)</Table.Th>
              <Table.Th>VA (cc)</Table.Th>
              <Table.Th>IOP</Table.Th>
              <Table.Th>Refraction</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {exams.map((exam) => (
              <Table.Tr key={exam.panelId}>
                <Table.Td>{exam.date}</Table.Td>
                <Table.Td>{exam.vaUncorrected}</Table.Td>
                <Table.Td>{exam.vaCorrected}</Table.Td>
                <Table.Td>{exam.iop}</Table.Td>
                <Table.Td>{exam.refraction}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Card>
  );
}
