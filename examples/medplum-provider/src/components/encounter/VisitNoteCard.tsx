// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Button, Card, Collapse, Group, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { DocumentReference, Encounter } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconFileText } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { PCP_LETTER_BOT, VISIT_NOTE_BOT, executeClinicBot } from '../../eyecare/bots';
import { PdfAttachment } from '../eyecare/PdfAttachment';

export interface VisitNoteCardProps {
  readonly encounter: Encounter;
  /** Bump to reload after an external event (signing, addendum). */
  readonly refreshKey?: number;
}

/**
 * The visit's rendered note document — the system-of-record artifact.
 * Shows the current PDF note (draft or signed), lets the clinician
 * (re)generate it on demand, and drafts the referring-provider letter.
 */
export function VisitNoteCard(props: VisitNoteCardProps): JSX.Element {
  const { encounter, refreshKey } = props;
  const medplum = useMedplum();
  const [note, setNote] = useState<DocumentReference | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState(false);
  const [letterWorking, setLetterWorking] = useState(false);
  const [opened, { toggle }] = useDisclosure(false);

  const load = useCallback(async (): Promise<void> => {
    const results = await medplum.searchResources(
      'DocumentReference',
      {
        encounter: `Encounter/${encounter.id}`,
        type: 'http://loinc.org|11506-3',
        status: 'current',
        _sort: '-_lastUpdated',
        _count: '1',
      },
      { cache: 'no-cache' }
    );
    setNote(results[0]);
    setLoaded(true);
  }, [medplum, encounter.id]);

  useEffect(() => {
    load().catch(console.error);
  }, [load, refreshKey]);

  const generate = async (): Promise<void> => {
    setWorking(true);
    try {
      await executeClinicBot(medplum, VISIT_NOTE_BOT, encounter);
      await load();
      notifications.show({ color: 'green', title: 'Note generated', message: 'The visit note PDF is ready.' });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: normalizeErrorString(err) });
    } finally {
      setWorking(false);
    }
  };

  const generateLetter = async (): Promise<void> => {
    setLetterWorking(true);
    try {
      await executeClinicBot(medplum, PCP_LETTER_BOT, encounter);
      notifications.show({
        color: 'green',
        title: 'PCP letter drafted',
        message: 'Review it on the Documents tab before sending.',
      });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: normalizeErrorString(err) });
    } finally {
      setLetterWorking(false);
    }
  };

  return (
    <Card withBorder shadow="sm" mt="md">
      <Group justify="space-between">
        <Group gap="xs">
          <IconFileText size={18} />
          <Title order={4}>Visit Note</Title>
          {note && (
            <Badge variant="light" color={note.docStatus === 'final' ? 'green' : 'yellow'}>
              {note.docStatus === 'final' ? 'Signed' : 'Draft'}
            </Badge>
          )}
        </Group>
        <Group gap="xs">
          <Button
            size="xs"
            variant="light"
            onClick={() => generate().catch(console.error)}
            loading={working}
            disabled={!loaded}
          >
            {note ? 'Regenerate note' : 'Generate draft note'}
          </Button>
          <Button
            size="xs"
            variant="default"
            onClick={() => generateLetter().catch(console.error)}
            loading={letterWorking}
          >
            Draft PCP letter
          </Button>
          {note && (
            <Button size="xs" variant="subtle" onClick={toggle}>
              {opened ? 'Hide' : 'View'}
            </Button>
          )}
        </Group>
      </Group>
      {!note && loaded && (
        <Text c="dimmed" size="sm" mt="xs">
          No rendered note yet. Signing the visit generates it automatically; use "Generate draft note" for a
          preview at any time.
        </Text>
      )}
      {note && (
        <Text c="dimmed" size="sm" mt={4}>
          {note.description} — generated {note.date ? new Date(note.date).toLocaleString() : ''}
        </Text>
      )}
      {note?.content?.[0]?.attachment && (
        <Collapse in={opened} mt="sm">
          <PdfAttachment attachment={note.content[0].attachment} />
        </Collapse>
      )}
    </Card>
  );
}
