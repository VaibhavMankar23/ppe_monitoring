# UAT test plan: PPE Compliance Monitor

User acceptance testing before go-live at plant scale (30-45 cameras).

## 1. Scope

**In scope:** sign-in and accounts, roles and permissions, Command, Live, Review, Insights,
Cameras & zones, Settings, System health, Users & audit, security, usability, detection quality
on plant footage, plant-scale capacity (30 and 45 cameras), alarms, data retention and restarts.

**Out of scope:** model retraining, NVR and network configuration, plant IT systems the app does
not touch.

## 2. Who tests what

| Role | Modules | Typical cases |
|---|---|---|
| EHS / safety reviewer | Review, Insights, Detection quality | REV-*, INS-*, DET-* |
| Shift supervisor | Command, Live | CMD-*, LIVE-* |
| Plant IT | Cameras, System health, Security, Plant scale, Operations | CAM-*, SYS-*, SEC-*, PERF-*, OPS-* |
| Super Admin (owner) | Sign-in, Roles, Settings, Users & audit | AUTH-*, ROLE-*, SET-*, USR-* |

## 3. Test environment

- **Production-like server:** the NVIDIA GPU server planned for go-live (see
  [`DEPLOYMENT.md`](DEPLOYMENT.md)), served over HTTPS with `deploy/docker-compose.https.yml`.
- **Cameras:** at least 5 real plant cameras on their sub-stream for functional tests; all 30-45
  for PERF-01/02.
- **People:** two volunteers for DET-01/02 (one with full PPE, one without helmet), with their
  agreement to be recorded for the test.
- **Accounts:** one Super Admin, one Admin, one reviewer account (Admin role).
- **Never test on the live plant database:** the suite creates and deletes data.

## 4. Entry criteria

1. Build deployed from the release branch; all backend tests pass (`cd backend && pytest -q`).
2. HTTPS working with the plant certificate (SEC-06).
3. Test cameras added and live on System health.
4. Testers have accounts and a copy of the UAT test-case workbook (shared separately with the test team).

## 5. How to execute

1. Work through **Test Cases** in module order. P1 cases first.
2. For each case follow *Test steps*, compare with *Expected result*, fill the **yellow columns**:
   Tester status, Actual result, Tester, Test date, Defect ID, Comments.
3. Every **Fail** gets a row in **Defects** (severity, steps, expected, actual), and its Defect ID
   goes on the test case.
4. When a defect is fixed, re-run the case and record the retest result in **Defects**.

## 6. Severity of defects

| Severity | Meaning | Example |
|---|---|---|
| Critical | Safety or security failure, data loss, no workaround | Unsafe worker never flagged; another user's data visible |
| High | Main function broken or wrong, workaround is painful | Camera does not reconnect after a network drop |
| Medium | Function works with a reasonable workaround | Filter ignores the date range |
| Low | Cosmetic or wording | Label truncated |

## 7. Exit criteria (go-live sign-off)

- Every **P1** case is **Pass** in the Tester status column (the Summary sheet's *Ready for
  go-live?* turns YES).
- No **Critical** or **High** defect open.
- DET-03 alert precision at or above the agreed target (proposed: 85%).
- PERF-01 and PERF-02 pass on the production server: every camera at 2 fps or more, detection
  engine below 70% busy, no stalls over an 8-hour shift.
- Sign-off by the EHS head, plant IT and the product owner, recorded below.

| Role | Name | Date | Decision |
|---|---|---|---|
| EHS head | | | |
| Plant IT | | | |
| Product owner | | | |

## 8. Known items before UAT starts

| Item | Status |
|---|---|
| DEF-001: "Compliance today" shows "-" for the first 60 s | Low, by design; may get a "Collecting data" label |
| DEF-002: development laptop cannot run plant scale | Needs the GPU server; re-run PERF-01/02 there |
| Ultralytics licence (AGPL-3.0) | Must be resolved before go-live (owner / legal) |
