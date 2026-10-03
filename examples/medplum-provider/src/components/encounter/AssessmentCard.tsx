// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Button, Card, Checkbox, Group, Stack, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { Condition, Encounter, Observation } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconCircleCheck } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { EXAM_CATEGORY, PROBLEM_ASSESSMENT_CODE } from '../../eyecare/codes';

const ICD10CM = 'http://hl7.org/fhir/sid/icd-10-cm';

function problemLabel(condition: Condition): { text: string; icd10?: string } {
  const icd10 = condition.code?.coding?.find((c) => c.system === ICD10CM)?.code;
  const text =
    condition.code?.text ?? condition.code?.coding?.[0]?.display ?? condition.code?.coding?.[0]?.code ?? 'Problem';
  return { text, icd10 };
}

export interface AssessmentCardProps {
  readonly encounter: Encounter;
  readonly enabled: boolean;
}

/**
 * Nextech-style assessment: the patient's problem list drives the assessment.
 * Check off the problems addressed this visit; each checked problem gets its
 * own note field, tied to the Condition and its ICD-10 code. Notes are stored
 * as Observations (focus = the Condition) on this visit.
 */
export function AssessmentCard(props: AssessmentCardProps): JSX.Element {
  const { encounter, enabled } = props;
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const patientRef = encounter.subject?.reference;
  const [problems, setProblems] = useState<Condition[]>([]);
  const [existing, setExisting] = useState<Map<string, Observation>>(new Map());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [addressed, setAddressed] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!patientRef) {
      return;
    }
    const load = async (): Promise<void> => {
      const conditions = await medplum.searchResources(
        'Condition',
        { patient: patientRef, 'clinical-status': 'active', _count: '50', _sort: '-_lastUpdated' },
        { cache: 'no-cache' }
      );
      const observations = await medplum.searchResources(
        'Observation',
        { encounter: `Encounter/${encounter.id}`, _count: '100' },
        { cache: 'no-cache' }
      );
      const byCondition = new Map<string, Observation>();
      const initialNotes: Record<string, string> = {};
      for (const obs of observations) {
        const conditionId = obs.focus?.[0]?.reference?.split('/')[1];
        if (obs.code?.text === PROBLEM_ASSESSMENT_CODE.text && conditionId && obs.valueString) {
          byCondition.set(conditionId, obs);
          initialNotes[conditionId] = obs.valueString;
        }
      }
      setProblems(conditions);
      setExisting(byCondition);
      setNotes(initialNotes);
      // Problems already documented this visit start checked
      setAddressed(new Set(byCondition.keys()));
    };
    load().catch(console.error);
  }, [medplum, patientRef, encounter.id]);

  const toggleAddressed = (conditionId: string, checked: boolean): void => {
    setAddressed((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(conditionId);
      } else {
        next.delete(conditionId);
      }
      return next;
    });
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      const updated = new Map(existing);
      for (const problem of problems) {
        const conditionId = problem.id as string;
        const isAddressed = addressed.has(conditionId);
        const note = isAddressed ? (notes[conditionId]?.trim() ?? '') : '';
        const current = updated.get(conditionId);
        if (note && !current) {
          const { text, icd10 } = problemLabel(problem);
          const created = await medplum.createResource<Observation>({
            resourceType: 'Observation',
            status: 'final',
            category: EXAM_CATEGORY,
            code: PROBLEM_ASSESSMENT_CODE,
            subject: { reference: patientRef },
            encounter: { reference: `Encounter/${encounter.id}` },
            performer: profile ? [createReference(profile)] : undefined,
            effectiveDateTime: new Date().toISOString(),
            focus: [{ reference: `Condition/${conditionId}`, display: icd10 ? `${text} (${icd10})` : text }],
            valueString: note,
          });
          updated.set(conditionId, created);
        } else if (note && current && current.valueString !== note) {
          const saved = await medplum.updateResource<Observation>({ ...current, valueString: note });
          updated.set(conditionId, saved);
        } else if (!note && current?.id) {
          // Unchecked (or emptied) problems drop their note for this visit
          await medplum.deleteResource('Observation', current.id);
          updated.delete(conditionId);
        }
      }
      setExisting(updated);
      notifications.show({
        color: 'green',
        icon: <IconCircleCheck />,
        title: 'Assessment saved',
        message: 'Problem assessments recorded for this visit.',
      });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: normalizeErrorString(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card withBorder shadow="sm" mt="md">
      <Group justify="space-between">
        <Title order={4}>Assessment</Title>
        {problems.length > 0 && (
          <Text c="dimmed" size="sm">
            {addressed.size} of {problems.length} problem{problems.length === 1 ? '' : 's'} addressed this visit
          </Text>
        )}
      </Group>
      <Text c="dimmed" size="sm">
        Populated from the problem list — check the problems addressed today and document each individually.
      </Text>
      {problems.length === 0 && (
        <Text c="dimmed" size="sm" mt="sm">
          No active problems on the problem list. Add problems from the patient sidebar and they will appear here.
        </Text>
      )}
      <Stack gap="sm" mt="sm">
        {problems.map((problem) => {
          const { text, icd10 } = problemLabel(problem);
          const conditionId = problem.id as string;
          const isAddressed = addressed.has(conditionId);
          return (
            <div key={conditionId}>
              <Group gap="xs" mb={4}>
                <Checkbox
                  size="sm"
                  checked={isAddressed}
                  onChange={(e) => toggleAddressed(conditionId, e.currentTarget.checked)}
                  disabled={!enabled}
                  aria-label={`Addressed: ${text}`}
                />
                <Text size="sm" fw={600} c={isAddressed ? undefined : 'dimmed'}>
                  {text}
                </Text>
                {icd10 ? (
                  <Badge variant="light" size="sm" color={isAddressed ? undefined : 'gray'}>
                    {icd10}
                  </Badge>
                ) : (
                  <Badge variant="light" color="yellow" size="sm">
                    No ICD-10 code
                  </Badge>
                )}
              </Group>
              {isAddressed && (
                <Textarea
                  autosize
                  minRows={1}
                  placeholder="Assessment and plan for this problem..."
                  value={notes[conditionId] ?? ''}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [conditionId]: e.target.value }))}
                  disabled={!enabled}
                  ml={28}
                />
              )}
            </div>
          );
        })}
      </Stack>
      {problems.length > 0 && (
        <Group mt="sm">
          <Button size="xs" onClick={() => handleSave().catch(console.error)} loading={saving} disabled={!enabled}>
            Save Assessment
          </Button>
        </Group>
      )}
    </Card>
  );
}
