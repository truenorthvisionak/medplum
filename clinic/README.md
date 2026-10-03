# Clinic Deployment — Medplum EHR for Eye Care

This directory contains everything needed to build and run the clinic's
Medplum instance **from this repo's source code**, so local modifications
(like the eye exam feature in `examples/medplum-provider`) ship to production.

## Stack

| Service          | Port(s)              | What it is                                                    |
| ---------------- | -------------------- | ------------------------------------------------------------- |
| `medplum-server` | 8103                 | FHIR API server, built from `packages/server` source           |
| `medplum-app`    | 3000                 | Medplum admin console (project/user admin, resource browser)   |
| `provider`       | 3001                 | Provider EHR UI, built from `examples/medplum-provider` source |
| `oie`            | 8444 (admin), 6661+  | Open Integration Engine (Mirth fork) for HL7 workflows         |
| `postgres`       | 5432 (localhost)     | Medplum database                                               |
| `redis`          | 6379 (localhost)     | Medplum cache and queues                                       |
| `oie-db`         | internal             | Integration engine database                                    |

## First-time setup

```bash
cd clinic
docker compose build     # compiles server + provider app from source (slow the first time)
docker compose up -d
```

Then:

1. Open the admin console at http://localhost:3000 and **register a new project**
   (this creates your project and your admin user).
2. **Load the US Core profiles** into the project (the provider app's patient
   Edit tab validates against them; without this it shows "Could not find the
   US Core Patient Profile"):

   ```bash
   EMAIL=you@example.com PASSWORD=... node clinic/seed/load-us-core-profiles.mjs
   ```

3. Optional: seed demo patients, a schedule, appointments, and the care
   templates (idempotent, safe to re-run):

   ```bash
   EMAIL=you@example.com PASSWORD=... node clinic/seed/seed-demo-schedule.mjs
   ```

4. Load clinical terminologies (RxNorm, ICD-10-CM, CVX — all free downloads,
   fetched automatically) so medication/problem/allergy/vaccine pickers work:

   ```bash
   EMAIL=you@example.com PASSWORD=... node clinic/seed/import-terminology.mjs
   ```

5. Optional but recommended: load **SNOMED CT** (license-gated; free for US
   users). Create a UMLS account at https://uts.nlm.nih.gov/uts/signup-login,
   download the SNOMED CT US Edition RF2 zip from
   https://www.nlm.nih.gov/healthit/snomedct/us_edition.html, then:

   ```bash
   EMAIL=you@example.com PASSWORD=... node clinic/seed/import-snomed.mjs ~/Downloads/SnomedCT_USEditionRF2_PRODUCTION_*.zip
   ```

   This imports ~370k concepts plus the is-a hierarchy (expect 15-45 minutes),
   which turns on SNOMED results in hierarchy-filtered pickers like the
   problem list.

6. Wire the DICOM Modality Worklist (Orthanc + wl-writer must be up; the
   project needs the `bots` feature enabled once by a super admin —
   Project.features = ["bots"]):

   ```bash
   EMAIL=you@example.com PASSWORD=... node clinic/seed/deploy-worklist-bot.mjs
   ```

   Booking/updating an Appointment then writes a worklist entry that devices
   C-FIND from Orthanc (port 4243). Test like a device:

   ```bash
   docker build -t clinic-dcmtk clinic/mwl/dcmtk
   docker run --rm --network medplum-clinic_default clinic-dcmtk \
     findscu -W -aet MAESTRO2 -aec ORTHANC orthanc 4242 \
     -k "(0040,0100)[0].(0008,0060)=OPT" \
     -k "(0040,0100)[0].(0040,0002)=$(date +%Y%m%d)" \
     -k "(0010,0010)" -k "(0010,0020)" -k "(0008,0050)"
   ```

7. Sign in to the provider app at http://localhost:3001 with the same account.
8. Open a patient → **Eye Exam** tab.

The first server boot runs database migrations and seeds base FHIR resources;
it can take a couple of minutes before the healthcheck goes green. Watch with
`docker compose logs -f medplum-server`.

## Development workflow

Day-to-day iteration does not require Docker rebuilds:

```bash
# Terminal 1: infra only
cd clinic && docker compose up -d postgres redis medplum-server medplum-app

# Terminal 2: provider app with hot reload (uses local source)
cd examples/medplum-provider
echo 'MEDPLUM_BASE_URL=http://localhost:8103/' > .env
npm run dev        # http://localhost:3001
```

If you change **server** source (`packages/server`, `packages/core`, ...):

```bash
cd clinic
docker compose build medplum-server && docker compose up -d medplum-server
```

Run tests:

```bash
cd examples/medplum-provider
npm test
```

## Pushing to production (in clinic)

The production box only needs Docker + this repo.

1. Commit your changes to the fork. This is already configured: `origin` =
   `truenorthvisionak/medplum` (public fork — never commit PHI or real
   credentials), `upstream` = `medplum/medplum`, and all clinic work lives on
   the **`clinic`** branch (the fork's `main` stays tracking upstream):

   ```bash
   git add -A
   git commit
   git push
   ```

2. On the clinic server:

   ```bash
   git clone -b clinic https://github.com/truenorthvisionak/medplum.git  # first time
   git pull                  # thereafter
   cd clinic
   docker compose build
   docker compose up -d      # rolling restart of changed services
   ```

3. Set real values in `clinic/.env` on the production box (never commit it):

   ```bash
   MEDPLUM_DB_PASSWORD=<strong password>
   MEDPLUM_REDIS_PASSWORD=<strong password>
   OIE_DB_PASSWORD=<strong password>
   MEDPLUM_BASE_URL=https://api.your-clinic-domain.example/
   MEDPLUM_APP_BASE_URL=https://admin.your-clinic-domain.example/
   MEDPLUM_STORAGE_BASE_URL=https://api.your-clinic-domain.example/storage/
   ```

   Before real patient data: work through [SECURITY.md](./SECURITY.md)
   (TLS, credentials, registration, access policies, backups, audit).
   Track every edit to upstream files in [UPSTREAM-CHANGES.md](./UPSTREAM-CHANGES.md).

   Production checklist:
   - Put a TLS reverse proxy (Caddy/nginx/Traefik) in front of ports 8103/3000/3001.
     HTTPS is required for anything handling PHI.
   - `MEDPLUM_BASE_URL` is baked into the provider app at **build** time —
     rebuild the `provider` image whenever it changes.
   - Change `restart: unless-stopped` to `always` if desired.
   - Back up the `medplum-postgres-data` and `oie-appdata` volumes nightly
     (`pg_dump` via cron is the simplest reliable option).
   - Keep MLLP ports (6661+) on the clinic LAN only — never expose them to the internet.

## Syncing with upstream Medplum

```bash
git fetch upstream
git merge upstream/main     # on the clinic branch; resolve conflicts, mostly none — customizations live in
                            # clinic/ and examples/medplum-provider/src/eyecare
cd clinic && docker compose build && docker compose up -d
```

Note: this repo was originally cloned with `--depth 1`. Before the first merge, run
`git fetch --unshallow upstream` to get full history.

## Integrations (FORUM, instruments, OIE)

See [INTEGRATION.md](./INTEGRATION.md) for the DICOM Modality Worklist / Zeiss
FORUM topology and the Open Integration Engine channel designs.
