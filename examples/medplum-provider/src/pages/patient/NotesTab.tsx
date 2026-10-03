// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Badge, Card, Collapse, Group, Stack, Text, Title } from '@mantine/core';
import type { DocumentReference } from '@medplum/fhirtypes';
import { Loading, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { PdfAttachment } from '../../components/eyecare/PdfAttachment';
import { usePatient } from '../../hooks/usePatient';

/**
 * Chronological list of the patient's rendered visit notes — the "flip
 * through the chart" view. Each row expands to the signed (or draft) PDF.
 */
export function NotesTab(): JSX.Element {
  const medplum = useMedplum();
  const patient = usePatient();
  const [notes, setNotes] = useState<DocumentReference[] | undefined>(undefined);
  const [openId, setOpenId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!patient?.id) {
      return;
    }
    medplum
      .searchResources(
        'DocumentReference',
        {
          patient: `Patient/${patient.id}`,
          type: 'http://loinc.org|11506-3',
          status: 'current',
          _sort: '-date',
          _count: '50',
        },
        { cache: 'no-cache' }
      )
      .then(setNotes)
      .catch(console.error);
  }, [medplum, patient?.id]);

  if (!patient || !notes) {
    return <Loading />;
  }

  return (
    <Stack gap="sm" p="md">
      <Title order={3}>Visit Notes</Title>
      {notes.length === 0 && (
        <Text c="dimmed" size="sm">
          No visit notes yet. Notes are generated when a visit is signed (or on demand from the visit page).
        </Text>
      )}
      {notes.map((note) => {
        const encounterId = note.context?.encounter?.[0]?.reference?.split('/')[1];
        const isOpen = openId === note.id;
        return (
          <Card key={note.id} withBorder shadow="sm">
            <Group justify="space-between">
              <Group gap="xs">
                <Anchor component="button" type="button" onClick={() => setOpenId(isOpen ? undefined : note.id)}>
                  {note.description ?? 'Visit note'}
                </Anchor>
                <Badge variant="light" color={note.docStatus === 'final' ? 'green' : 'yellow'}>
                  {note.docStatus === 'final' ? 'Signed' : 'Draft'}
                </Badge>
              </Group>
              {encounterId && patient.id && (
                <Anchor component={Link} to={`/Patient/${patient.id}/Encounter/${encounterId}`} size="sm">
                  Open visit
                </Anchor>
              )}
            </Group>
            {note.content?.[0]?.attachment && (
              <Collapse in={isOpen} mt="sm">
                {isOpen && <PdfAttachment attachment={note.content[0].attachment} />}
              </Collapse>
            )}
          </Card>
        );
      })}
    </Stack>
  );
}
