# Clinic Bots

Medplum [Bots](https://www.medplum.com/docs/bots) for instrument/EMR workflows.
This folder is an npm workspace of the monorepo (uses the local `@medplum/*` packages).

| Bot                     | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `instrument-oru-bot.ts` | HL7 ORU^R01 from pre-test instruments (via OIE) → FHIR Observations with the same eye care codes as the provider UI. Unmatched MRNs become Tasks for staff review instead of auto-created patients. |

## Test

```bash
npm test
```

## Deploy

One-time: create the Bot and save its id.

```bash
npx medplum login --base-url http://localhost:8103/
npx medplum bot create instrument-oru "clinic" "src/instrument-oru-bot.ts" --runtime-version vmcontext
```

Every deploy after code changes:

```bash
npx medplum bot deploy instrument-oru
```

Then point the OIE channel destination at the bot's `$execute` endpoint:

```
POST http://medplum-server:8103/fhir/R4/Bot/<bot-id>/$execute
Content-Type: x-application/hl7-v2+er7
Authorization: Bearer <client-credentials token>
```

(Within the docker network, `medplum-server:8103` resolves from the OIE container.)

Notes:
- `MRN_SYSTEM` in the bot (`urn:clinic:mrn`) must match the identifier system
  used on your Patient resources — change it to the clinic's real MRN system URI.
- Extend `OBSERVATION_MAP` as instruments are added; configure each OIE channel
  to normalize the device's native OBX-3 codes to these keys.
