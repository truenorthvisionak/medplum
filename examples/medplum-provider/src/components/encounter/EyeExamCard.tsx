// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Button, Card, Collapse, Group, Table, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Encounter, Observation, Patient } from '@medplum/fhirtypes';
import { useMedplum, useResource } from '@medplum/react';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { SPECTACLE_RX_BOT, executeClinicBot } from '../../eyecare/bots';
import { EYE_EXAM_PANEL_CODE, SNOMED } from '../../eyecare/codes';
import type { EyeExamSummary } from '../../eyecare/summary';
import { summarizeEyeExam } from '../../eyecare/summary';
import { EyeExamForm } from '../eyecare/EyeExamForm';

export interface EyeExamCardProps {
  readonly encounter: Encounter;
  readonly enabled?: boolean;
}

/**
 * Eye exam charting for this visit: shows the exam(s) recorded during the
 * encounter and opens the full charting form inline (with copy-forward), so
 * the whole visit is documented on one screen. Also prints the spectacle Rx.
 */
export function EyeExamCard(props: EyeExamCardProps): JSX.Element | null {
  const { encounter, enabled = true } = props;
  const medplum = useMedplum();
  const patient = useResource<Patient>(encounter.subject?.reference ? { reference: encounter.subject.reference } : undefined);
  const [exams, setExams] = useState<EyeExamSummary[] | undefined>(undefined);
  const [rxWorking, setRxWorking] = useState(false);
  const [chartOpen, { toggle: toggleChart, close: closeChart }] = useDisclosure(false);
  const patientId = encounter.subject?.reference?.split('/')[1];

  const load = useCallback(async (): Promise<void> => {
    const bundle = await medplum.search(
      'Observation',
      {
        encounter: `Encounter/${encounter.id}`,
        code: `${SNOMED}|${EYE_EXAM_PANEL_CODE.coding?.[0]?.code}`,
        _sort: '-date',
        _count: '10',
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
    setExams(panels.map((panel) => summarizeEyeExam(panel, members)));
  }, [medplum, encounter.id]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const printRx = async (): Promise<void> => {
    setRxWorking(true);
    try {
      await executeClinicBot(medplum, SPECTACLE_RX_BOT, { patientId });
      notifications.show({
        color: 'green',
        title: 'Spectacle Rx generated',
        message: 'The prescription PDF is on the Documents tab.',
      });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: normalizeErrorString(err) });
    } finally {
      setRxWorking(false);
    }
  };

  const handleSaved = async (): Promise<void> => {
    closeChart();
    await load();
  };

  return (
    <Card withBorder shadow="sm" mt="md">
      <Group justify="space-between">
        <Title order={4}>Eye Exam</Title>
        <Group gap="xs">
          <Button size="xs" variant="light" onClick={toggleChart} disabled={!enabled || !patient}>
            {chartOpen ? 'Close exam form' : exams?.length ? 'Chart another exam' : 'Chart exam'}
          </Button>
          <Button size="xs" variant="default" onClick={() => printRx().catch(console.error)} loading={rxWorking}>
            Spectacle Rx
          </Button>
          {patientId && (
            <Anchor component={Link} to={`/Patient/${patientId}/eye-exam`} size="sm">
              History
            </Anchor>
          )}
        </Group>
      </Group>
      {exams && exams.length === 0 && !chartOpen && (
        <Text c="dimmed" size="sm" mt="xs">
          No eye exam recorded for this visit yet.
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
      {patient && (
        <Collapse in={chartOpen} mt="sm">
          <EyeExamForm
            patient={patient}
            encounter={encounter}
            attachLabel={`Attaches to this visit (${encounter.type?.[0]?.text ?? 'visit'})`}
            onSaved={handleSaved}
          />
        </Collapse>
      )}
    </Card>
  );
}
