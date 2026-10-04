// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Button, Card, Group, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Encounter, Patient } from '@medplum/fhirtypes';
import { Loading, useMedplum, useResource } from '@medplum/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';
import { SPECTACLE_RX_BOT, executeClinicBot } from '../../eyecare/bots';
import { EyeExamForm } from '../eyecare/EyeExamForm';

export interface EyeExamCardProps {
  readonly encounter: Encounter;
  readonly enabled?: boolean;
}

/**
 * The visit's eye exam, charted inline on the encounter page. The exam
 * autosaves and stays editable until the visit ends or the note is signed;
 * after that it renders read-only.
 * @param props - The component props.
 * @returns The eye exam card.
 */
export function EyeExamCard(props: EyeExamCardProps): JSX.Element | null {
  const { encounter, enabled = true } = props;
  const medplum = useMedplum();
  const patient = useResource<Patient>(
    encounter.subject?.reference ? { reference: encounter.subject.reference } : undefined
  );
  const [rxWorking, setRxWorking] = useState(false);
  const patientId = encounter.subject?.reference?.split('/')[1];

  const visitEnded = ['finished', 'cancelled'].includes(encounter.status);
  const readOnly = !enabled || visitEnded;

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

  return (
    <Card withBorder shadow="sm" mt="md">
      <Group justify="space-between" mb="sm">
        <Title order={4}>Eye Exam</Title>
        <Group gap="xs">
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
      {patient ? <EyeExamForm patient={patient} encounter={encounter} readOnly={readOnly} /> : <Loading />}
    </Card>
  );
}
