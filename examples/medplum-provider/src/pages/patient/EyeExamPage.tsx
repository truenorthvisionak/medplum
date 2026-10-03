// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Autocomplete,
  Button,
  Card,
  Divider,
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
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Encounter, Observation, Practitioner } from '@medplum/fhirtypes';
import { Loading, useMedplum, useMedplumProfile } from '@medplum/react';
import { IconCircleCheck, IconCircleOff } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { VaCorrection } from '../../eyecare/codes';
import {
  ANTERIOR_SEGMENT_FIELDS,
  EYE_EXAM_PANEL_CODE,
  POSTERIOR_SEGMENT_FIELDS,
  SNOMED,
} from '../../eyecare/codes';
import { EXAM_TEMPLATES } from '../../eyecare/examTemplates';
import type { EyeExamValues, NumericInput, RefractionEyeValues } from '../../eyecare/observations';
import { EMPTY_EYE_EXAM, buildEyeExamBundle } from '../../eyecare/observations';
import { summarizeEyeExam } from '../../eyecare/summary';
import type { EyeExamSummary } from '../../eyecare/summary';
import { usePatient } from '../../hooks/usePatient';

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

// Encounter statuses that count as an "open" visit an exam can attach to
const OPEN_ENCOUNTER_STATUSES = new Set(['planned', 'arrived', 'triaged', 'in-progress', 'onleave']);

const VA_ROWS: { correction: VaCorrection; label: string }[] = [
  { correction: 'uncorrected', label: 'Uncorrected (sc)' },
  { correction: 'corrected', label: 'Corrected (cc)' },
  { correction: 'pinhole', label: 'Pinhole (ph)' },
];

export function EyeExamPage(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile() as Practitioner;
  const patient = usePatient();
  const [values, setValues] = useState<EyeExamValues>(structuredClone(EMPTY_EYE_EXAM));
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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

  const setVa = (correction: VaCorrection, eye: 'OD' | 'OS', value: string): void => {
    setValues((prev) => ({
      ...prev,
      visualAcuity: { ...prev.visualAcuity, [correction]: { ...prev.visualAcuity[correction], [eye]: value } },
    }));
  };

  const setRefraction = (eye: 'OD' | 'OS', field: keyof RefractionEyeValues, value: NumericInput): void => {
    // Keep the raw value (including in-progress strings like "1." or "-") so
    // typing decimals isn't interrupted; parsing happens on save.
    setValues((prev) => ({
      ...prev,
      refraction: {
        ...prev.refraction,
        [eye]: { ...prev.refraction[eye], [field]: value === '' ? undefined : value },
      },
    }));
  };

  const setIop = (eye: 'OD' | 'OS', value: NumericInput): void => {
    setValues((prev) => ({ ...prev, iop: { ...prev.iop, [eye]: value === '' ? undefined : value } }));
  };

  const setSegmentField = (
    segment: 'anteriorSegment' | 'posteriorSegment',
    key: string,
    value: string
  ): void => {
    setValues((prev) => ({ ...prev, [segment]: { ...prev[segment], [key]: value } }));
  };

  const applyTemplate = (): void => {
    const template = EXAM_TEMPLATES.find((t) => t.name === selectedTemplate);
    if (!template) {
      return;
    }
    setValues((prev) => ({
      ...prev,
      anteriorSegment: { ...template.anteriorSegment },
      posteriorSegment: { ...template.posteriorSegment },
    }));
  };

  const handleSave = async (): Promise<void> => {
    const bundle = buildEyeExamBundle(
      { patient, performer: profile, encounter: activeEncounter, effectiveDateTime: new Date().toISOString() },
      values
    );
    if (!bundle) {
      notifications.show({
        color: 'yellow',
        icon: <IconCircleOff />,
        title: 'Nothing to save',
        message: 'Enter at least one exam value first.',
      });
      return;
    }
    setSaving(true);
    try {
      await medplum.executeBatch(bundle);
      notifications.show({
        color: 'green',
        icon: <IconCircleCheck />,
        title: 'Eye exam saved',
        message: 'Observations recorded for this patient.',
      });
      setValues(structuredClone(EMPTY_EYE_EXAM));
      await loadHistory();
    } catch (err) {
      notifications.show({ color: 'red', icon: <IconCircleOff />, title: 'Error', message: normalizeErrorString(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="md" p="md">
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
          />
          <NumberInput
            size="xs"
            label="OS (mmHg)"
            min={0}
            max={80}
            value={values.iop.OS ?? ''}
            onChange={(v) => setIop('OS', v)}
            style={{ width: 110 }}
          />
          <Select
            size="xs"
            label="Method"
            data={TONOMETRY_OPTIONS}
            value={values.iop.method ?? null}
            onChange={(v) => setValues((prev) => ({ ...prev, iop: { ...prev.iop, method: v ?? undefined } }))}
            style={{ width: 200 }}
            clearable
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
            />
            <Button size="xs" variant="light" onClick={applyTemplate} disabled={!selectedTemplate}>
              Fill from template
            </Button>
          </Group>
        </Group>

        <Text fw={600} size="sm" mt="md">
          Anterior segment (slit lamp)
        </Text>
        <Grid mt={4}>
          {ANTERIOR_SEGMENT_FIELDS.map((field) => (
            <Grid.Col key={field.key} span={{ base: 12, sm: 6 }}>
              <TextInput
                size="xs"
                label={field.label}
                value={values.anteriorSegment[field.key] ?? ''}
                onChange={(e) => setSegmentField('anteriorSegment', field.key, e.target.value)}
              />
            </Grid.Col>
          ))}
        </Grid>

        <Text fw={600} size="sm" mt="md">
          Posterior segment (fundus)
        </Text>
        <Grid mt={4}>
          {POSTERIOR_SEGMENT_FIELDS.map((field) => (
            <Grid.Col key={field.key} span={{ base: 12, sm: 6 }}>
              <TextInput
                size="xs"
                label={field.label}
                value={values.posteriorSegment[field.key] ?? ''}
                onChange={(e) => setSegmentField('posteriorSegment', field.key, e.target.value)}
              />
            </Grid.Col>
          ))}
        </Grid>

        <Textarea
          mt="md"
          label="Notes"
          placeholder="Additional notes for this exam..."
          autosize
          minRows={2}
          value={values.notes ?? ''}
          onChange={(e) => setValues((prev) => ({ ...prev, notes: e.target.value }))}
        />
      </Card>

      <Group align="center">
        <Button onClick={() => handleSave().catch(console.error)} loading={saving}>
          Save Eye Exam
        </Button>
        {activeEncounter ? (
          <Text size="sm" c="dimmed">
            Will attach to the open visit: {activeEncounter.type?.[0]?.text ?? 'Visit'} ({activeEncounter.status})
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            No open visit — this exam will be saved to the chart only.
          </Text>
        )}
      </Group>

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
