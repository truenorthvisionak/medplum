# Security & HIPAA Posture

Assessment of the clinic stack as built, and the hardening checklist required
before real patient data (PHI) touches it. The current configuration is a
**development/demo posture**: correct architecture, deliberately weak defaults.

## What the customizations did and did not change

The clinic changes (eye exam charting, assessments, seeds, terminology) do
**not** add attack surface:

- No new endpoints, services, or auth paths — everything goes through
  Medplum's existing authenticated FHIR REST API.
- No PHI leaves the system: terminology imports (RxNorm, ICD-10-CM, CVX,
  SNOMED) download public code files *into* the server; nothing is uploaded.
- Note signing creates `Provenance` records (who signed what, when) — a net
  *gain* for integrity/attestation and HIPAA audit expectations.
- All demo patients/visits are synthetic. Do not mix them with real PHI:
  create a fresh Medplum **Project** (or fresh deployment) for production and
  leave the demo project for training.
- The change surface on vendor code is 6 files / ~15 lines, all listed in
  [UPSTREAM-CHANGES.md](./UPSTREAM-CHANGES.md) — small enough to re-audit on
  every upstream merge.

## Hardening checklist for production (in order of importance)

1. **TLS everywhere.** All ports currently speak plain HTTP. Put a TLS reverse
   proxy (Caddy is simplest) in front of 8103/3000/3001 and stop publishing
   those ports directly. PHI in transit must be encrypted — this is
   non-negotiable, even "inside the office".
2. **Rotate every default credential.** Set strong values in `clinic/.env`
   (`MEDPLUM_DB_PASSWORD`, `MEDPLUM_REDIS_PASSWORD`, `OIE_DB_PASSWORD`);
   change the OIE admin login (`admin`/`admin`); delete or re-password the
   demo accounts (`doctor@example.com`, super admin `admin@example.com`).
3. **Close open registration.** Recaptcha was removed for LAN convenience, so
   anyone who can reach the server can register a project. In production set
   `MEDPLUM_REGISTER_ENABLED: 'false'` on the app and create users only
   through the admin console invite flow.
4. **Tighten CORS and binding.** Replace `MEDPLUM_ALLOWED_ORIGINS: '*'` with
   the exact app origins. Bind published ports to the LAN interface (or
   localhost behind the proxy); Postgres/Redis are already 127.0.0.1-only.
5. **Least-privilege access.** Today every user is a project admin. Before
   staff onboarding, create Medplum `AccessPolicy` resources per role (front
   desk: scheduling + demographics; technician: observations; provider: full
   chart; billing: claims) and attach them to each `ProjectMembership`.
6. **Encryption at rest + backups.** Docker volumes inherit the host disk, so
   enable full-disk encryption on the clinic server. Nightly `pg_dump` of the
   `medplum-postgres-data` volume to an **encrypted** destination; test
   restores. Retain per your policy (HIPAA: 6 years for required records).
7. **Audit trail.** Medplum writes `AuditEvent` resources and the signing flow
   writes `Provenance`. Decide retention, and export server logs
   (`docker compose logs`) to persistent storage so access history survives
   container rebuilds.
8. **Automatic logoff.** The app's session expiry you've seen *is* a HIPAA
   safeguard (§164.312(a)(2)(iii)). Keep short sessions on shared exam-lane
   workstations; reserve "Remember me" for private offices, and give every
   staff member their own login — no shared accounts.
9. **Integration plane.** HL7v2 over MLLP (OIE ports 6671+) is cleartext by
   protocol: keep it strictly LAN/VLAN-bound, never internet-exposed — same
   for FORUM DICOM traffic. Give OIE its own Medplum `ClientApplication`
   with a scoped access policy (only the resources its channels need), not a
   human login.
10. **Patch cadence.** The fork model means *you* own updates: schedule a
    monthly `git fetch upstream && merge` + image rebuild, and subscribe to
    Medplum security advisories (GitHub releases) and OIE releases.

## Business-associate notes

- Self-hosting means no BAA is needed for the EHR itself — the trade is that
  the technical safeguards above are entirely your responsibility.
- Vendors that *do* touch PHI (e.g., a cloud fax service, e-prescribing,
  clearinghouse, remote backup target) each need a BAA.
- Zeiss FORUM and the instruments sit inside your network boundary; include
  them in the same risk analysis (they hold PHI + images).

## Standing rule for future work

Keep all customizations modular: new code goes in `clinic/` or new files in
the provider app; upstream files get minimal insertion points only, each
recorded in [UPSTREAM-CHANGES.md](./UPSTREAM-CHANGES.md). A small, enumerable
diff against the vendor codebase is itself a security control — it is what
makes each upstream merge reviewable.
