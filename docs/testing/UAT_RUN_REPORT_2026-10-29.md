# UAT run report: 29 Oct 2026

Automated execution of the UAT pack by Claude. Case definitions and the tester columns are in [`PPE_Monitor_UAT_Test_Cases.xlsx`](PPE_Monitor_UAT_Test_Cases.xlsx); the plan is in [`../UAT_TEST_PLAN.md`](../UAT_TEST_PLAN.md). Generated from [`uat/results-2026-10-29.json`](uat/results-2026-10-29.json).

## Result

| Test cases | Run by Claude | Passed | Failed | Left for manual testers | P1 run / total |
|---|---|---|---|---|---|
| 76 | 52 | 52 | 0 | 24 | 31 / 43 |

Every case that could be automated passed. The other 12 P1 cases need real cameras, people or the production server, so the pack is **not signed off yet**.

## Environment

- **Build:** commit `de5fc87` plus the uncommitted 28-29 Oct security, capacity and UI changes (see [`../../CHANGELOG.md`](../../CHANGELOG.md)).
- **Machine:** development laptop, Intel i5-1335U, CPU only (OpenVINO). The main app was running at the same time.
- **Instance:** separate QA copy on port 8001, fresh empty database, its own secrets.
- **Cameras:** 3 recorded NVR files: Gate No. 2, Assembly Line 3, Store Dock (Store Dock requires gloves, to test 'not checked').
- **Method:** API calls and a real Chrome browser (Playwright), signed in as Super Admin and as Admin.

## Coverage by module

| Module | Cases | Run | Passed | Manual |
|---|---|---|---|---|
| Sign-in & accounts | 9 | 8 | 8 | 1 |
| Roles & permissions | 6 | 6 | 6 | 0 |
| Command (home) | 6 | 6 | 6 | 0 |
| Live monitoring | 8 | 4 | 4 | 4 |
| Review queue | 9 | 8 | 8 | 1 |
| Insights | 4 | 3 | 3 | 1 |
| Cameras & zones | 7 | 3 | 3 | 4 |
| Settings | 4 | 3 | 3 | 1 |
| System health | 2 | 2 | 2 | 0 |
| Users & audit | 3 | 3 | 3 | 0 |
| Security | 6 | 5 | 5 | 1 |
| Usability | 3 | 1 | 1 | 2 |
| Detection quality | 3 | 0 | 0 | 3 |
| Plant scale | 3 | 0 | 0 | 3 |
| Operations | 3 | 0 | 0 | 3 |

## Executed cases

| ID | Test case | Priority | Result | Observed |
|---|---|---|---|---|
| AUTH-01 | First sign-in forces a new password | P1 | Pass | forced change screen: True; after saving landed on Command: True |
| AUTH-02 | Wrong password is rejected with a neutral message | P1 | Pass | HTTP 401: Incorrect username or password. |
| AUTH-03 | Unknown user gets the same message as a wrong password | P2 | Pass | HTTP 401; same message as wrong password: True |
| AUTH-04 | Repeated wrong passwords lock the sign-in | P1 | Pass | attempt status codes: [401, 401, 401, 401, 401, 429] |
| AUTH-05 | Weak passwords are refused | P1 | Pass | weak passwords refused with HTTP [400, 400, 400] |
| AUTH-06 | Sign out ends the session | P1 | Pass | after sign-out, opening Command shows the sign-in page: True |
| AUTH-07 | Session survives a page reload | P2 | Pass | after reload still signed in on Review: True |
| AUTH-09 | The old public password does not work on a new install | P1 | Pass | admin / mahindra123 -> HTTP 401 |
| ROLE-01 | Admin does not see People and Audit trail | P1 | Pass | Admin sees People: False; Audit trail: False |
| ROLE-02 | Admin opening a Super Admin page by URL is blocked | P1 | Pass | #/users as Admin shows the no-access page: True |
| ROLE-03 | Admin cannot bulk-export worker photos | P1 | Pass | Admin dataset export HTTP 403; Admin CSV export HTTP 200 |
| ROLE-04 | Admin cannot change system settings | P1 | Pass | Admin changing the detection rate -> HTTP 403 |
| ROLE-05 | Admin can rename a camera | P2 | Pass | rename HTTP 200, live name 'Gate No. 2 (UAT)', rename back HTTP 200 |
| ROLE-06 | Admin never sees the email password or webhook address | P1 | Pass | Super Admin saved alarm secrets HTTP 200; visible to Admin: False |
| CMD-01 | Plant status is readable within 2 seconds | P1 | Pass | status '1 worker is unsafe right now' shown after 0.0 s |
| CMD-02 | No live video on the home page | P2 | Pass | live video frames on Command after 10 s: 0 |
| CMD-03 | 'Act now' lists unsafe cameras and opens them | P1 | Pass | row 'Gate No. 2 / 2 of 2 in view unsafe / View / No helmet / No vest / No mask' opened /monitoring?camera=gate-2 |
| CMD-04 | Headline cards are shown | P2 | Pass | all four cards shown |
| CMD-05 | Camera fleet lists every camera | P2 | Pass | Camera fleet shown: True; cameras missing: none |
| CMD-06 | 'Start review' opens the review queue | P2 | Pass | landed on /incidents |
| LIVE-01 | Video wall shows every camera live | P1 | Pass | 3 live video tiles rendering for 3 cameras |
| LIVE-02 | Find a camera by name | P2 | Pass | tiles after searching 'Gate': 1 |
| LIVE-03 | Board view shows all cameras without video | P2 | Pass | board shows all cameras: True |
| LIVE-07 | Stop and start a camera | P2 | Pass | stop HTTP 200 -> stopped; start HTTP 200 -> live |
| REV-01 | New incidents arrive in the Open queue | P1 | Pass | 3 incidents arrived in the queue from live detection |
| REV-02 | Evidence image and person crop are shown | P1 | Pass | evidence image shown: True; person crop shown: True |
| REV-03 | Verdict buttons visible without scrolling | P2 | Pass | Valid button bottom at 879 px of a 950 px window |
| REV-04 | Confirm with the V key | P1 | Pass | after pressing V: 1 incident(s) confirmed valid (by admin) |
| REV-05 | False alarm needs a reason | P1 | Pass | false alarm without reason HTTP 422; with reason HTTP 200 (keyboard flow F,1,Enter: manual) |
| REV-07 | Filter by camera | P2 | Pass | filter camera=gate-2: 4 results, all from that camera |
| REV-08 | Export CSV | P2 | Pass | HTTP 200, text/csv; charset=utf-8, 4 data rows |
| REV-09 | Delete an incident (Super Admin) | P2 | Pass | delete HTTP 200; fetch afterwards HTTP 404; in audit trail: True |
| INS-01 | Insights page loads | P2 | Pass | page 'Reports'; console errors: none |
| INS-02 | Alert precision follows reviewer verdicts | P1 | Pass | reviewed 2 of 4; alert precision 0.5 |
| INS-03 | Invalid date range is refused | P3 | Pass | end before start -> HTTP 422 |
| CAM-01 | Connection test succeeds for a valid recording | P1 | Pass | NVR_ch12_main_20261013140005_20261013150005.cpv: ok=True 1920x1080 @ 25.0 fps |
| CAM-02 | Connection test explains an unreachable camera | P1 | Pass | ok=False after 3 s: cannot connect to rtsp://10.255.255.1/stream within 3s (check the address, port, path and  |
| CAM-04 | PPE the model cannot detect is flagged as not checked | P1 | Pass | Store Dock requires ['helmet', 'vest', 'gloves']; flagged as not checked: ['gloves'] |
| SET-01 | A setting change applies without restarting | P1 | Pass | save HTTP 200; running limit now 2.0 fps; server uptime kept (32 s) |
| SET-02 | Invalid YAML is refused with a line number | P2 | Pass | valid=False; error: YAML syntax error: expected the node content, but found '-' (line 2) |
| SET-03 | Every save keeps a backup that can be restored | P2 | Pass | 4 backups listed after the saves above (restore itself: manual) |
| SYS-01 | Per-camera health is shown | P1 | Pass | device intel:cpu; per camera (name, fps, latency ms): [('Gate No. 2', 1.1, 831), ('Assembly Line 3', 1.2, 668), ('Store Dock', 1.2, 530)] |
| SYS-02 | Capacity planner answers 30 / 45 cameras | P1 | Pass | planner shown: True; '45 cameras need 90 frames/s: about 42× what this server can do.' |
| USR-01 | Create a user | P1 | Pass | create admin HTTP 201; second user HTTP 201; its first sign-in must change password: True |
| USR-02 | Deactivated user cannot sign in | P1 | Pass | deactivate HTTP 200; sign-in afterwards HTTP 403: This account has been deactivated. Contact a Super Admin. |
| USR-03 | Audit trail records key actions | P1 | Pass | recorded: auth.login, auth.login_failed, config.update, user.create, violation.delete, violation.review; missing: none (re-run after fixing the test's own limit=500 > API max 200) |
| SEC-01 | Server files cannot be downloaded through the web address | P1 | Pass | HTTP 200; returned 'the dashboard page' |
| SEC-02 | Browser security headers are present | P2 | Pass | CSP present: True; X-Frame-Options DENY; nosniff nosniff |
| SEC-03 | Secrets cannot be read through a camera address | P1 | Pass | HTTP 200; secret in reply: False |
| SEC-04 | Every API needs sign-in | P1 | Pass | without sign-in: {'/api/violations': 401, '/api/config': 401, '/api/users': 401, '/api/system/health': 401} |
| SEC-05 | Other websites cannot call the API from a browser | P2 | Pass | pre-flight from evil.example: HTTP 400, Allow-Origin=None |
| UX-01 | Phone width: no sideways scrolling | P3 | Pass | page width at 390 px screen: {'overview': 390, 'incidents': 390} |

## Notes

- **Script corrections, not app defects.** USR-03 first errored because the script asked the audit trail for 500 entries (API maximum 200); re-checked with 200, all six required actions present. SET-02 first showed an empty message because the script read the wrong field; the server's message was correct.
- **DEF-001 (Low):** 'Compliance today' shows '-' for up to 60 s after start, because worker counts are written once a minute (`OBS_FLUSH_SECONDS`).
- **DEF-002 (High, hardware):** 3 cameras ran at 1.1-1.2 fps detection each on this laptop; the capacity planner reports 45 cameras need about 42x this machine. Re-run PERF-01/02 on the GPU server (see [`../CAPACITY_PLANNING.md`](../CAPACITY_PLANNING.md)).
- **Privacy:** screenshots from the run showed workers; they were checked, then deleted with the QA database. The Observed column records what each check saw.

## Left for manual testing (24)

| ID | Test case | Priority | Tester | Needs |
|---|---|---|---|---|
| AUTH-08 | 'Keep me signed in' lasts across browser restarts | P3 | Any | - |
| LIVE-04 | Wall layouts 2x2 / 3x3 / 4x4 and paging | P3 | Any | 5+ cameras |
| LIVE-05 | Camera detail explains each worker's status | P1 | Any | A worker in view |
| LIVE-06 | Live events rail updates by itself | P2 | Any | Violations occurring |
| LIVE-08 | Auto-cycle holds while someone is unsafe | P3 | Any | More cameras than fit on one page |
| REV-06 | Undo a verdict | P3 | EHS reviewer | A reviewed incident |
| INS-04 | Insights export for management | P3 | Manager | - |
| CAM-03 | Add a real RTSP camera | P1 | Super Admin | Plant camera / NVR sub-stream address and credentials |
| CAM-05 | Draw a monitor / ignore / restricted zone | P1 | Super Admin | Camera live |
| CAM-06 | Turning a camera off stops it but keeps its history | P2 | Super Admin | Camera with incidents |
| CAM-07 | Camera password changes need re-entry when the address changes | P1 | Super Admin | Camera with a saved password |
| SET-04 | Leaving with unsaved changes asks first | P3 | Super Admin | - |
| SEC-06 | Dashboard is served over HTTPS | P1 | IT | Reverse proxy with certificate installed |
| UX-02 | Light and dark themes | P3 | Any | - |
| UX-03 | Lost server connection is visible | P2 | Any | Signed in |
| DET-01 | Missing helmet is flagged within ~3 s | P1 | EHS reviewer | Live camera; a volunteer without helmet |
| DET-02 | Compliant worker is not flagged | P1 | EHS reviewer | Volunteer with helmet and vest |
| DET-03 | Alert precision on plant footage meets target | P1 | EHS reviewer | 1-2 weeks of live data |
| PERF-01 | 30 cameras on the production server | P1 | IT | Production server, 30 camera sub-streams |
| PERF-02 | 45 cameras for an 8-hour shift | P1 | IT | Production server, 45 cameras |
| PERF-03 | Camera reconnects after network loss | P1 | IT | Live RTSP camera |
| OPS-01 | Email / webhook alarm is delivered | P2 | Super Admin | SMTP or webhook configured |
| OPS-02 | Data survives a server restart | P1 | IT | Users, cameras and incidents exist |
| OPS-03 | Old incidents are removed by retention | P2 | IT | Retention set (e.g. 30 days) |
