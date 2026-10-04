// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Autocomplete,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Encounter, Observation, Patient, Practitioner } from '@medplum/fhirtypes';
import { Loading, useMedplum, useMedplumProfile } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { SAVE_TIMEOUT_MS } from '../../config/constants';
import type { AnteriorSegmentField, PosteriorSegmentField, VaCorrection } from '../../eyecare/codes';
import {
  ANTERIOR_SEGMENT_FIELDS,
  EYE_EXAM_PANEL_CODE,
  POSTERIOR_SEGMENT_FIELDS,
  SNOMED,
} from '../../eyecare/codes';
import { EXAM_TEMPLATES } from '../../eyecare/examTemplates';
import type { EyeExamValues, NumericInput, RefractionEyeValues } from '../../eyecare/observations';
import {
  EMPTY_EYE_EXAM,
  EXAM_SLOT_SYSTEM,
  buildExamPanel,
  buildExamUpsertBundle,
  examHasValues,
  valuesFromExam,
  valuesFromObservations,
} from '../../eyecare/observations';
import type { SaveState } from './SaveBadge';
import { SaveBadge } from './SaveBadge';

const SNELLEN_OPTIONS = [
  '20/10',
  '20/15',
  '20/20',
  '20/25',
  '20/30',
  '20/40',
  '20/50',
  '20/60',
  '20/70',
  '20/80',
  '20/100',
  '20/150',
  '20/200',
  '20/400',
  'CF',
  'HM',
  'LP',
  'NLP',
];

const TONOMETRY_OPTIONS = [
  { value: 'goldmann', label: 'Goldmann applanation' },
  { value: 'ncr', label: 'Non-contact (air puff)' },
  { value: 'icare', label: 'iCare (rebound)' },
  { value: 'tonopen', label: 'Tono-Pen (applanation)' },
];

const VA_ROWS: { correction: VaCorrection; label: string }[] = [
  { correction: 'uncorrected', label: 'Uncorrected (sc)' },
  { correction: 'corrected', label: 'Corrected (cc)' },
  { correction: 'pinhole', label: 'Pinhole (ph)' },
];

export interface EyeExamFormProps {
  readonly patient: Patient;
  /** The visit this exam belongs to — the exam is a living document until the visit ends. */
  readonly encounter: Encounter;
  readonly readOnly?: boolean;
  /** Called after each successful autosave (e.g. to refresh a summary). */
  readonly onChanged?: () => void;
}

/**
 * ECW/Nextech-style exam charting: every element has separate OD and OS
 * fields, and the exam autosaves continuously — it stays editable for the
 * whole visit and locks when the encounter ends or the note is signed.
 * @param props - The component props.
 * @returns The autosaving per-eye exam form.
 */
export function EyeExamForm(props: EyeExamFormProps): JSX.Element {
  const { patient, encounter, readOnly = false, onChanged } = props;
  const medplum = useMedplum();
  const profile = useMedplumProfile() as Practitioner;
  const [values, setValues] = useState<EyeExamValues>(structuredClone(EMPTY_EYE_EXAM));
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [copying, setCopying] = useState(false);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  // Pre-slot-autosave exam observations on this encounter, replaced on the next save
  const legacyIdsRef = useRef<string[]>([]);

  // Load the visit's existing exam so editing resumes where it left off
  useEffect(() => {
    let active = true;
    medplum
      .searchResources(
        'Observation',
        { encounter: `Encounter/${encounter.id}`, _count: '100' },
        { cache: 'no-cache' }
      )
      .then((observations) => {
        if (!active) {
          return;
        }
        const { values: loaded, notes, legacyIds } = valuesFromObservations(observations);
        legacyIdsRef.current = legacyIds;
        setValues({ ...loaded, notes });
        setSaveState('clean');
      })
      .catch((err) => {
        if (active) {
          setSaveState('error');
          console.error(err);
        }
      });
    return () => {
      active = false;
    };
  }, [medplum, encounter.id]);

  const save = async (): Promise<void> => {
    setSaveState('saving');
    try {
      const ctx = {
        patient,
        performer: profile,
        encounter,
        effectiveDateTime: encounter.period?.start ?? new Date().toISOString(),
      };
      const bundle = buildExamUpsertBundle(ctx, valuesRef.current);
      // Their values were loaded into the form, so slot observations now carry them
      for (const id of legacyIdsRef.current) {
        bundle.entry?.push({ request: { method: 'DELETE', url: `Observation/${id}` } });
      }
      const result = await medplum.executeBatch(bundle);
      legacyIdsRef.current = [];
      const members = (result.entry ?? [])
        .map((e) => e.resource as Observation | undefined)
        .filter((r): r is Observation => r?.resourceType === 'Observation' && !!r.id);

      const panelUrl = `${medplum.fhirUrl('Observation')}?identifier=${EXAM_SLOT_SYSTEM}|${encodeURIComponent(
        `${encounter.id}:panel`
      )}`;
      if (members.length > 0 || valuesRef.current.notes?.trim()) {
        const panel = buildExamPanel(ctx, members, valuesRef.current.notes);
        await medplum.put(panelUrl, panel);
      } else {
        await medplum.delete(panelUrl);
      }
      setSaveState('saved');
      onChanged?.();
    } catch (err) {
      setSaveState('error');
      notifications.show({ color: 'red', title: 'Exam autosave failed', message: normalizeErrorString(err) });
    }
  };

  const debouncedSave = useDebouncedCallback(() => {
    save().catch(console.error);
  }, SAVE_TIMEOUT_MS);

  const update = (fn: (prev: EyeExamValues) => EyeExamValues): void => {
    setValues(fn);
    setSaveState('dirty');
    debouncedSave();
  };

  const setVa = (correction: VaCorrection, eye: 'OD' | 'OS', value: string): void => {
    update((prev) => ({
      ...prev,
      visualAcuity: { ...prev.visualAcuity, [correction]: { ...prev.visualAcuity[correction], [eye]: value } },
    }));
  };

  const setRefraction = (eye: 'OD' | 'OS', field: keyof RefractionEyeValues, value: NumericInput): void => {
    update((prev) => ({
      ...prev,
      refraction: {
        ...prev.refraction,
        [eye]: { ...prev.refraction[eye], [field]: value === '' ? undefined : value },
      },
    }));
  };

  const setIop = (eye: 'OD' | 'OS', value: NumericInput): void => {
    update((prev) => ({ ...prev, iop: { ...prev.iop, [eye]: value === '' ? undefined : value } }));
  };

  const setSegmentField = (
    segment: 'anteriorSegment' | 'posteriorSegment',
    eye: 'OD' | 'OS',
    key: string,
    value: string
  ): void => {
    update((prev) => ({
      ...prev,
      [segment]: { ...prev[segment], [eye]: { ...prev[segment][eye], [key]: value } },
    }));
  };

  const applyTemplate = (): void => {
    const template = EXAM_TEMPLATES.find((t) => t.name === selectedTemplate);
    if (!template) {
      return;
    }
    update((prev) => ({
      ...prev,
      anteriorSegment: { OD: { ...template.anteriorSegment }, OS: { ...template.anteriorSegment } },
      posteriorSegment: { OD: { ...template.posteriorSegment }, OS: { ...template.posteriorSegment } },
    }));
  };

  const copyForward = async (): Promise<void> => {
    setCopying(true);
    try {
      const bundle = await medplum.search(
        'Observation',
        {
          patient: `Patient/${patient.id}`,
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
      let copied;
      let fromDate: string | undefined;
      for (const panel of resources.filter(
        (obs) => obs.hasMember && obs.encounter?.reference !== `Encounter/${encounter.id}`
      )) {
        const candidate = valuesFromExam(panel, members);
        if (examHasValues(candidate)) {
          copied = candidate;
          fromDate = panel.effectiveDateTime?.slice(0, 10);
          break;
        }
      }
      if (!copied) {
        notifications.show({ color: 'yellow', title: 'Nothing to copy', message: 'No previous exam on file.' });
        return;
      }
      update(() => copied);
      notifications.show({
        color: 'blue',
        title: 'Copied forward',
        message: `Loaded exam from ${fromDate ?? 'previous visit'} — review and edit.`,
      });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error', message: normalizeErrorString(err) });
    } finally {
      setCopying(false);
    }
  };

  if (saveState === 'loading') {
    return <Loading />;
  }

  const segmentTable = (
    segment: 'anteriorSegment' | 'posteriorSegment',
    fields: readonly { key: AnteriorSegmentField | PosteriorSegmentField; label: string }[],
    title: string
  ): JSX.Element => (
    <>
      <Text fw={600} size="sm" mt="md">
        {title}
      </Text>
      <Table mt={4} withRowBorders={false} verticalSpacing={4}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: '18%' }} />
            <Table.Th>OD (Right)</Table.Th>
            <Table.Th>OS (Left)</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {fields.map((field) => (
            <Table.Tr key={field.key}>
              <Table.Td>
                <Text size="sm">{field.label}</Text>
              </Table.Td>
              {(['OD', 'OS'] as const).map((eye) => (
                <Table.Td key={eye}>
                  <TextInput
                    size="xs"
                    value={(values[segment][eye] as Record<string, string>)[field.key] ?? ''}
                    onChange={(e) => setSegmentField(segment, eye, field.key, e.target.value)}
                    aria-label={`${field.label} ${eye}`}
                    disabled={readOnly}
                  />
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            onClick={() => copyForward().catch(console.error)}
            loading={copying}
            disabled={readOnly}
          >
            Copy forward last exam
          </Button>
          {readOnly && (
            <Badge variant="light" color="gray">
              Visit ended — exam locked
            </Badge>
          )}
        </Group>
        {!readOnly && <SaveBadge state={saveState} />}
      </Group>

      <Card withBorder shadow="sm">
        <Title order={4}>Visual Acuity (Distance)</Title>
        <Table mt="xs" withRowBorders={false} style={{ maxWidth: 480 }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th />
              <Table.Th>OD (Right)</Table.Th>
              <Table.Th>OS (Left)</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {VA_ROWS.map((row) => (
              <Table.Tr key={row.correction}>
                <Table.Td>
                  <Text size="sm">{row.label}</Text>
                </Table.Td>
                {(['OD', 'OS'] as const).map((eye) => (
                  <Table.Td key={eye}>
                    <Autocomplete
                      size="xs"
                      data={SNELLEN_OPTIONS}
                      value={values.visualAcuity[row.correction][eye] ?? ''}
                      onChange={(value) => setVa(row.correction, eye, value)}
                      placeholder="20/20"
                      aria-label={`${row.label} ${eye}`}
                      disabled={readOnly}
                    />
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>

      <Card withBorder shadow="sm">
        <Title order={4}>Refraction (Manifest)</Title>
        {(['OD', 'OS'] as const).map((eye) => (
          <Grid key={eye} mt="xs" align="flex-end">
            <Grid.Col span={1}>
              <Text size="sm" fw={600}>
                {eye}
              </Text>
            </Grid.Col>
            <Grid.Col span={2}>
              <NumberInput
                size="xs"
                label="Sphere"
                step={0.25}
                decimalScale={2}
                min={-30}
                max={30}
                value={values.refraction[eye].sphere ?? ''}
                onChange={(v) => setRefraction(eye, 'sphere', v)}
                aria-label={`Sphere ${eye}`}
                disabled={readOnly}
              />
            </Grid.Col>
            <Grid.Col span={2}>
              <NumberInput
                size="xs"
                label="Cylinder"
                step={0.25}
                decimalScale={2}
                min={-15}
                max={15}
                value={values.refraction[eye].cylinder ?? ''}
                onChange={(v) => setRefraction(eye, 'cylinder', v)}
                aria-label={`Cylinder ${eye}`}
                disabled={readOnly}
              />
            </Grid.Col>
            <Grid.Col span={2}>
              <NumberInput
                size="xs"
                label="Axis"
                step={1}
                min={0}
                max={180}
                value={values.refraction[eye].axis ?? ''}
                onChange={(v) => setRefraction(eye, 'axis', v)}
                aria-label={`Axis ${eye}`}
                disabled={readOnly}
              />
            </Grid.Col>
            <Grid.Col span={2}>
              <NumberInput
                size="xs"
                label="Add"
                step={0.25}
                decimalScale={2}
                min={0}
                max={5}
                value={values.refraction[eye].add ?? ''}
                onChange={(v) => setRefraction(eye, 'add', v)}
                aria-label={`Add ${eye}`}
                disabled={readOnly}
              />
            </Grid.Col>
          </Grid>
        ))}
      </Card>

      <Card withBorder shadow="sm">
        <Title order={4}>Intraocular Pressure</Title>
        <Group mt="xs" align="flex-end">
          <NumberInput
            size="xs"
            label="OD (mmHg)"
            min={0}
            max={80}
            value={values.iop.OD ?? ''}
            onChange={(v) => setIop('OD', v)}
            style={{ width: 110 }}
            disabled={readOnly}
          />
          <NumberInput
            size="xs"
            label="OS (mmHg)"
            min={0}
            max={80}
            value={values.iop.OS ?? ''}
            onChange={(v) => setIop('OS', v)}
            style={{ width: 110 }}
            disabled={readOnly}
          />
          <Select
            size="xs"
            label="Method"
            data={TONOMETRY_OPTIONS}
            value={values.iop.method ?? null}
            onChange={(v) => update((prev) => ({ ...prev, iop: { ...prev.iop, method: v ?? undefined } }))}
            style={{ width: 200 }}
            clearable
            disabled={readOnly}
          />
        </Group>
      </Card>

      <Card withBorder shadow="sm">
        <Group justify="space-between" align="flex-end">
          <Title order={4}>Exam Findings</Title>
          <Group gap="xs" align="flex-end">
            <Select
              size="xs"
              label="Template"
              placeholder="Choose a template"
              data={EXAM_TEMPLATES.map((t) => t.name)}
              value={selectedTemplate}
              onChange={setSelectedTemplate}
              style={{ width: 230 }}
              clearable
              disabled={readOnly}
            />
            <Button size="xs" variant="light" onClick={applyTemplate} disabled={!selectedTemplate || readOnly}>
              Fill both eyes from template
            </Button>
          </Group>
        </Group>

        {segmentTable('anteriorSegment', ANTERIOR_SEGMENT_FIELDS, 'Anterior segment (slit lamp)')}
        {segmentTable('posteriorSegment', POSTERIOR_SEGMENT_FIELDS, 'Posterior segment (fundus)')}

        <Textarea
          mt="md"
          label="Notes"
          placeholder="Additional notes for this exam..."
          autosize
          minRows={2}
          value={values.notes ?? ''}
          onChange={(e) => update((prev) => ({ ...prev, notes: e.target.value }))}
          disabled={readOnly}
        />
      </Card>
    </Stack>
  );
}
