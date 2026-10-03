// SPDX-FileCopyrightText: Copyright the clinic
// SPDX-License-Identifier: Apache-2.0
//
// Fired by a Subscription on Appointment. For booked/arrived appointments,
// POSTs a JSON order to the wl-writer service, which writes a DICOM Modality
// Worklist entry that Orthanc serves to the devices (see clinic/INTEGRATION.md).
//
// Identity contract: patient_id = clinic MRN (urn:clinic:mrn), accession =
// Appointment id. Cancelled/no-show appointments remove their entry.
//
// Deployed as plain CommonJS (vmcontext runtime) by clinic/seed/deploy-worklist-bot.mjs.

const MRN_SYSTEM = 'urn:clinic:mrn';

exports.handler = async function handler(medplum, event) {
  const appointment = event.input;
  if (!appointment || appointment.resourceType !== 'Appointment') {
    return { skipped: 'input is not an Appointment' };
  }

  const wlWriterUrl =
    event.secrets?.['WL_WRITER_URL']?.valueString ?? 'http://wl-writer:8500';

  // Cancelled or no-show: pull the entry off the worklist
  if (['cancelled', 'noshow', 'entered-in-error'].includes(appointment.status)) {
    const res = await fetch(`${wlWriterUrl}/worklist/${appointment.id}`, { method: 'DELETE' });
    return { removed: appointment.id, status: res.status };
  }

  if (!['booked', 'arrived', 'checked-in'].includes(appointment.status)) {
    return { skipped: `status ${appointment.status}` };
  }

  const patientRef = appointment.participant?.find((p) =>
    p.actor?.reference?.startsWith('Patient/')
  )?.actor;
  if (!patientRef) {
    return { skipped: 'no patient participant' };
  }
  const patient = await medplum.readReference(patientRef);

  const practitionerRef = appointment.participant?.find((p) =>
    p.actor?.reference?.startsWith('Practitioner/')
  )?.actor;

  const mrn =
    patient.identifier?.find((i) => i.system === MRN_SYSTEM)?.value ?? patient.id;
  const name = patient.name?.[0];

  const order = {
    patient_name: `${name?.family ?? ''}^${(name?.given ?? []).join(' ')}`,
    patient_id: mrn,
    issuer_of_patient_id: MRN_SYSTEM,
    birth_date: (patient.birthDate ?? '').replaceAll('-', ''),
    sex: patient.gender === 'male' ? 'M' : patient.gender === 'female' ? 'F' : 'O',
    accession: appointment.id,
    sps_start_iso: appointment.start,
    sps_description:
      appointment.description ?? appointment.serviceType?.[0]?.text ?? 'Eye exam',
    requested_procedure_description:
      appointment.serviceType?.[0]?.text ?? appointment.description ?? 'Eye exam',
    performing_physician: practitionerRef?.display ?? '',
    // One entry per appointment for now; devices doing Broad/Patient-Based
    // queries see it regardless of this value. Split into per-modality
    // entries if a device turns out to hard-match its own modality.
    modality: event.secrets?.['WL_DEFAULT_MODALITY']?.valueString ?? 'OPT',
  };

  const response = await fetch(`${wlWriterUrl}/worklist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  });
  if (!response.ok) {
    throw new Error(`wl-writer returned ${response.status}: ${await response.text()}`);
  }
  return await response.json();
};
