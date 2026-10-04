// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Box, Card, Checkbox, Group, Stack, Text, Textarea, Title } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { CodeableConcept, Condition, Encounter, Observation } from '@medplum/fhirtypes';
import { CodeableConceptInput, useMedplum, useMedplumProfile } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { SAVE_TIMEOUT_MS } from '../../config/constants';
import { EXAM_CATEGORY, PROBLEM_ASSESSMENT_CODE } from '../../eyecare/codes';
import type { SaveState } from '../eyecare/SaveBadge';
import { SaveBadge } from '../eyecare/SaveBadge';

const ICD10CM = 'http://hl7.org/fhir/sid/icd-10-cm';
const CONDITION_CODE_VALUE_SET = 'http://hl7.org/fhir/us/core/ValueSet/us-core-condition-code';

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
 * Diagnosis-first assessment (ECW/Nextech model): search an ICD-10 code to
 * add it to the problem list AND today's assessment, then document under
 * each code. Notes autosave; everything locks when the note is signed.
 * @param props - The component props.
 * @returns The assessment card.
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
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [pickerKey, setPickerKey] = useState(0);
  const stateRef = useRef({ problems, notes, addressed, existing });
  stateRef.current = { problems, notes, addressed, existing };

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
      setAddressed(new Set(byCondition.keys()));
    };
    load().catch(console.error);
  }, [medplum, patientRef, encounter.id]);

  const save = async (): Promise<void> => {
    setSaveState('saving');
    try {
      const { problems: probs, notes: currentNotes, addressed: marked, existing: current } = stateRef.current;
      const updated = new Map(current);
      for (const problem of probs) {
        const conditionId = problem.id as string;
        const note = marked.has(conditionId) ? (currentNotes[conditionId]?.trim() ?? '') : '';
        const obs = updated.get(conditionId);
        if (note && !obs) {
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
        } else if (note && obs && obs.valueString !== note) {
          const saved = await medplum.updateResource<Observation>({ ...obs, valueString: note });
          updated.set(conditionId, saved);
        } else if (!note && obs?.id) {
          await medplum.deleteResource('Observation', obs.id);
          updated.delete(conditionId);
        }
      }
      setExisting(updated);
      setSaveState('saved');
    } catch (err) {
      setSaveState('error');
      notifications.show({ color: 'red', title: 'Assessment autosave failed', message: normalizeErrorString(err) });
    }
  };

  const debouncedSave = useDebouncedCallback(() => {
    save().catch(console.error);
  }, SAVE_TIMEOUT_MS);

  const markDirty = (): void => {
    setSaveState('dirty');
    debouncedSave();
  };

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
    markDirty();
  };

  const addDiagnosis = async (concept: CodeableConcept | undefined): Promise<void> => {
    if (!concept?.coding?.length || !patientRef) {
      return;
    }
    try {
      const condition = await medplum.createResource<Condition>({
        resourceType: 'Condition',
        clinicalStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }],
        },
        category: [
          {
            coding: [
              { system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' },
            ],
          },
        ],
        code: concept,
        subject: { reference: patientRef },
        encounter: { reference: `Encounter/${encounter.id}` },
      });
      setProblems((prev) => [condition, ...prev]);
      setAddressed((prev) => new Set(prev).add(condition.id));
      setPickerKey((k) => k + 1);
      notifications.show({
        color: 'green',
        title: 'Diagnosis added',
        message: `${problemLabel(condition).text} added to the problem list and today's assessment.`,
      });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: normalizeErrorString(err) });
    }
  };

  return (
    <Card withBorder shadow="sm" mt="md">
      <Group justify="space-between">
        <Title order={4}>Assessment</Title>
        <Group gap="sm">
          {enabled && <SaveBadge state={saveState} />}
          {problems.length > 0 && (
            <Text c="dimmed" size="sm">
              {addressed.size} of {problems.length} problem{problems.length === 1 ? '' : 's'} addressed
            </Text>
          )}
        </Group>
      </Group>
      <Text c="dimmed" size="sm">
        Search a diagnosis to add it to the problem list and document under it; check off problems addressed today.
      </Text>

      {enabled && (
        <Box mt="sm" maw={520}>
          <CodeableConceptInput
            key={pickerKey}
            name="add-diagnosis"
            placeholder="Add diagnosis (ICD-10 search)..."
            binding={CONDITION_CODE_VALUE_SET}
            path="Condition.code"
            onChange={(concept) => addDiagnosis(concept).catch(console.error)}
          />
        </Box>
      )}

      {problems.length === 0 && (
        <Text c="dimmed" size="sm" mt="sm">
          No active problems yet — search above to add the first diagnosis.
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
                  placeholder="Documentation for this diagnosis..."
                  value={notes[conditionId] ?? ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    setNotes((prev) => ({ ...prev, [conditionId]: value }));
                    markDirty();
                  }}
                  disabled={!enabled}
                  ml={28}
                />
              )}
            </div>
          );
        })}
      </Stack>
    </Card>
  );
}
