# Upstream Change Registry

Every clinic customization lives in additive locations that upstream Medplum
never touches — `clinic/` and new files under `examples/medplum-provider/src/`
(`eyecare/`, `EyeExamPage.tsx`, `EyeExamCard.tsx`, `AssessmentCard.tsx`).

This file is the complete list of edits to files that upstream DOES own.
Keep it current: every time an upstream file is modified, add it here with the
reason. This is the whole merge-conflict and audit surface of the fork.

| File | Lines | What / why |
| --- | --- | --- |
| `examples/medplum-provider/src/App.tsx` | +2 | Route for the Eye Exam tab (`/Patient/:id/eye-exam`) |
| `examples/medplum-provider/src/pages/patient/PatientPage.utils.ts` | +5 | "Eye Exam" entry in the patient page tab list |
| `examples/medplum-provider/src/components/encounter/EncounterChart.tsx` | +4 | Mounts `EyeExamCard` and `AssessmentCard` on the visit's Note & Tasks tab |
| `packages/react/src/PatientSummary/ConditionDialog.tsx` | ±1 | Dx Date no longer required when adding a problem. ⚠️ Only edit inside a shared `@medplum/*` package — review on every upstream merge; consider upstreaming as an optional prop. |
| `package.json` (+ lockfile) | +1 | Adds `clinic/bots` to the npm workspaces |
| `.dockerignore` | +1 | Excludes nested `node_modules` from Docker build context |

Guidelines:

- Prefer a new file in `clinic/` or the provider app over editing an upstream file.
- When an upstream edit is unavoidable, keep it to a minimal insertion point
  (a route, a list entry, a component mount) — never restructure upstream code.
- Avoid `packages/*` edits unless there is no app-level alternative.
- After `git merge upstream/main`, re-verify each row above survived the merge.
