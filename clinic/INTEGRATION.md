# Clinic Integration Architecture

Medplum (EMR) + **Orthanc** (DICOM archive + Modality Worklist) + **Topcon
fleet** with IMAGEnet 6, glued by the Open Integration Engine (Mirth fork).
Follows IHE Eye Care **U-EYECARE** transactions with Orthanc playing the
Image Manager/Archive + MWL SCP role.

> Superseded plan: an earlier revision of this document assumed Zeiss FORUM as
> the PACS/worklist. The stack is now settled on Orthanc + Topcon; the FORUM
> topology is retired (see git history if ever needed).

## Device fleet and how each connects

| Device | What it is | Data out | Worklist in |
| --- | --- | --- | --- |
| **Topcon OMNIA** | Auto kerato-refracto-**tonometer** (AR + keratometry + NCT IOP) | DICOM-capable; exports to IMAGEnet / shared folder | via IMAGEnet / DICOM (confirm MWL support on unit) |
| **Topcon SOLOS Lite** | Automatic lensmeter (habitual Rx) | JOIA-compliant XML export | n/a (operator-driven) |
| **Topcon Maestro2** | OCT + color fundus camera | DICOM (OPT/OP) via IMAGEnet 6 | DICOM MWL via IMAGEnet 6 |
| **Topcon TERA** | Placido topography + dry eye imaging suite | images/reports; confirm DICOM vs file export with Topcon DICOM conformance docs | confirm |
| **Topcon DC-4** | Slit lamp digital camera | DICOM (OP) via IMAGEnet 6 | via IMAGEnet 6 |
| **Zeiss IOLMaster** (future) | Optical biometry for IOL calc | DICOM (SR + Encapsulated PDF) | DICOM MWL client (native) |
| **IMAGEnet 6** | Topcon image management | DICOM store-and-forward + review viewer | MWL client for attached devices |

## Topology

```
┌─────────────┐ FHIR Subscription ┌──────────────┐  JSON   ┌───────────┐  .wl file  ┌──────────────┐
│   Medplum   │ ────────────────► │  OIE (Mirth) │ ──────► │ wl-writer │ ─────────► │   Orthanc    │
│  (EMR/FHIR) │                   │              │         └───────────┘            │ MWL SCP +    │
│             │ ◄──────────────── │  channels    │ ◄──── JOIA XML / shared folder   │ DICOM archive│
└─────┬───────┘  Bot $execute /   └──────┬───────┘       (OMNIA, SOLOS, TERA?)      └──────┬───────┘
      │          FHIR REST               │ poll /changes                            MWL C-FIND │ ▲ C-STORE
      │                                  ▼                                                    ▼ │
      │  ImagingStudy /          ┌──────────────────────────────────────────────────────────────┐
      └─ DocumentReference ◄──── │  IMAGEnet 6  ◄─►  Maestro2 (OCT/fundus), DC-4 (slit lamp)    │
                                 │  IOLMaster (direct MWL + store) · OMNIA · TERA               │
                                 └──────────────────────────────────────────────────────────────┘
```

Orthanc is the **single DICOM system of record** and the **worklist source**.
IMAGEnet 6 stays as Topcon's capture/review layer, configured to (a) query
Orthanc's MWL for its attached devices and (b) auto-forward stored studies to
Orthanc (C-STORE). IOLMaster talks to Orthanc directly. Medplum never speaks
DICOM itself — OIE and the changes-feed bridge translate both ways.

## The five flows

### 1. Worklist out (Medplum → Orthanc → devices)

Proven in the earlier OpenEMR prototype (`~/Code/openemr-local/mwl/`) against
a real device — port it as-is:

- Medplum `Subscription` on Appointment (status `booked`/`arrived`) → OIE HTTP
  listener → transform to the wl-writer's JSON shape → **wl-writer** (small
  pydicom HTTP service) writes `<accession>.wl` into Orthanc's worklist
  directory → Orthanc's ModalityWorklists plugin answers device **C-FIND**.
- **Identity contract (the keystone):** DICOM `PatientID` = the clinic MRN
  (`urn:clinic:mrn` value); `AccessionNumber` = the Medplum Appointment id.
  Every study a device produces then round-trips those IDs, so results
  auto-match the patient AND the visit with zero manual reconciliation.
- One worklist entry per appointment; a scheduled-procedure-step Modality per
  lane (OPT for OCT, OP for photography, `OAM`/`OT` per device config —
  devices are configured for Broad or Patient-Based query per IHE EYECARE-1).
- Cleanup: entries for past days pruned by a nightly OIE poll (or the
  wl-writer's DELETE endpoint).

### 2. Images/studies in (devices → Orthanc)

Maestro2 + DC-4 → IMAGEnet 6 → C-STORE forward → Orthanc. IOLMaster (and
OMNIA/TERA if their DICOM licenses allow) → C-STORE direct to Orthanc.
Orthanc keeps everything; storage is cheap, DICOM is the archival format.

### 3. Studies visible in the chart (Orthanc → Medplum)

A small bridge (OIE polling Orthanc's `/changes` REST feed, or an Orthanc
Python-plugin webhook) creates per study:

- a FHIR **`ImagingStudy`** (modality, date, series count, accession) linked
  to Patient + Encounter via the identity contract, and
- a **`DocumentReference`** for any Encapsulated PDF report (IOLMaster
  printouts, TERA dry-eye reports).

Chart-side viewing: link out to Orthanc's built-in viewer (or OHIF over
Orthanc DICOMweb) — clinicians review Topcon image quality in IMAGEnet as
today; the chart guarantees *findability*, not pixel rendering.

### 4. Numeric pre-test data (OMNIA / SOLOS → Medplum)

The refraction-lane numbers should land as **coded FHIR Observations**, same
codes as the Eye Exam tab (one longitudinal record):

- **OMNIA** (AR sphere/cyl/axis, keratometry, **NCT IOP**): shared-folder
  export → OIE file-reader channel → normalize to the clinic observation IDs →
  existing `instrument-oru` bot (`clinic/bots/`). The bot's map already covers
  autorefraction (LOINC 65890-6 …) and IOP (79892-6/79893-4); add keratometry
  rows.
- **SOLOS Lite** (habitual Rx lensometry): JOIA XML export → OIE channel →
  same bot (add lensometry entries to `OBSERVATION_MAP`).
- **TERA** dry-eye indices: file/CSV export if available → same path;
  otherwise its PDF report flows via flow 3.

### 5. IOL biometry (future IOLMaster)

MWL from Orthanc (flow 1) → biometry to Orthanc as DICOM SR + PDF → flow 3
puts the PDF report on the chart pre-op. Parsing the SR into discrete FHIR
Observations (AL, K1/K2, ACD, IOL calcs) is a later enhancement if surgical
planning wants structured data.

## Deployment status

**Implemented and verified (flow 1, end to end):**

- `orthanc` service (`orthancteam/orthanc`, worklists plugin) — host ports
  **4243** (DICOM) / **8043** (web), avoiding the legacy OpenEMR stack's
  4242/8042. Config: `clinic/mwl/orthanc/orthanc.json`.
- `wl-writer` service (`clinic/mwl/wl-writer`, ported from the prototype) —
  takes ISO timestamps and formats scheduled date/time in its own `TZ`
  (`CLINIC_TZ`, default America/Anchorage), so "today" always matches the
  devices' clocks. Adds per-entry DELETE and `?before=` pruning.
- Medplum **`appointment-to-worklist` bot** + Subscription on Appointment
  (`clinic/bots/src/appointment-to-worklist.bot.cjs`, deployed by
  `clinic/seed/deploy-worklist-bot.mjs`; requires the project's `bots`
  feature, vmcontext runtime, CommonJS). Booked/arrived → entry written;
  cancelled/no-show → entry removed.
- Verified with dcmtk `findscu` posing as a device (AET MAESTRO2): C-FIND by
  Modality+date returned the patient name, MRN, DOB, appointment-id
  accession, and local start time.

**Still to build:** flow 3 (`orthanc-changes-to-medplum` bridge →
ImagingStudy/DocumentReference), flow 4 OIE channels
(`omnia-folder-to-medplum`, `solos-joia-to-medplum`) once device export
formats are in hand, and a nightly `worklist-prune` (wl-writer already
supports `DELETE /worklist?before=YYYYMMDD`). Keep all DICOM + shared-folder
traffic LAN/VLAN-only (see `SECURITY.md`).

## Open questions to confirm with Topcon / on delivery

1. **OMNIA**: does the unit do MWL C-FIND itself, or only via IMAGEnet? And
   is DICOM output licensed on the purchased configuration?
2. **TERA**: DICOM conformance (request Topcon's DICOM notes) vs file export
   only.
3. **IMAGEnet 6**: confirm auto-forward (C-STORE) to a second archive and its
   MWL AE configuration — this is standard but must be enabled/licensed.
4. **SOLOS Lite JOIA XML**: export transport (network share vs USB vs serial
   bridge) — determines the OIE reader type.

## Eye exam data model (unchanged)

The coded-observation model (Eye Care IG patterns, SNOMED/LOINC verified
against tx.fhir.org, laterality via bodySite, exams grouped by panel
Observation, per-problem assessments referencing Conditions with ICD-10) is
documented in `examples/medplum-provider/src/eyecare/codes.ts` and unchanged
by the device-stack decision — flows 4–5 write into it.
