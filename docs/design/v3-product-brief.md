# PPE Compliance v3: product brief

Business analysis behind the v3 redesign. Every screen decision traces back to a user need below.
Written 16 Oct 2026.

## 1. Who uses it

| Persona | Typical role | What they need from the product | How often |
|---|---|---|---|
| **Shift supervisor** | Line / area supervisor on the floor | Know *right now* whether anyone is unsafe, and on which camera, so they can walk over and fix it | Constantly, glancing |
| **Safety reviewer** | EHS executive, safety officer | Clear the incident queue quickly and accurately: real violation or false alarm | Several sessions a day, 50-200 incidents |
| **EHS / plant manager** | Safety head, plant head | Is compliance improving? Where and when does it fail? Numbers for the management review | Daily glance, weekly / monthly deep dive |
| **System admin** | IT / automation engineer | Cameras online, zones right, model and server healthy, user access controlled | Weekly, and when something breaks |

## 2. Jobs to be done

1. **"Tell me if anyone is unsafe right now."** Live, zero-click, impossible to miss. → **Command** home and **Live**.
2. **"Help me get through the review queue fast."** One incident at a time, big evidence, keyboard verdicts, the next one loads automatically. → **Review** workspace.
3. **"Show me whether we are getting better, and where to act."** Plain-language trend, worst cameras, worst hours, most-missed PPE. → **Insights**.
4. **"Keep the system trustworthy."** Camera health, zones, model settings, users, audit. → **Setup**.

## 3. Pain points in earlier versions

- Navigation was organised by system objects (devices, settings, audit) rather than by the job in hand.
- The home page mixed live status, the queue and analytics with equal weight, so nothing stood out.
- Reviewing meant a table plus a pop-over panel: more clicks per incident than necessary.
- Colours carried little meaning: brand red competed with alarm red.

## 4. Information architecture (v3)

Five workspaces in a floating top navigation, ordered by frequency of use:

| Workspace | Route | Contains |
|---|---|---|
| **Command** | `#/overview` | Plant status in one sentence, workers needing attention now, review progress, today's compliance, camera health, latest events |
| **Live** | `#/monitoring` | Video wall (1×1 / 2×2 / 3×3), filters, live event rail |
| **Review** | `#/incidents` | Three-pane triage: queue, evidence, verdict. J/K/V/F keyboard flow |
| **Insights** | `#/reports` | Trends, breakdowns, export |
| **Setup** | `#/devices`, `#/settings`, `#/system`, `#/users`, `#/audit` | Cameras & zones, Detection, System health, People, Audit trail (secondary tabs) |

Old links (`#/live`, `#/review`, `#/analytics`, `#/cameras`, `#/dashboard`) keep working.

## 5. Visual language: "Obsidian & Iris"

- **Default dark** (control-room use, long shifts, video looks best on dark); full light theme available.
- **Neutrals:** obsidian / porcelain greys with a faint cool tint.
- **One accent: iris violet** (`#8B7CFF` dark, `#6D5BF6` light) for interaction, selection and data. It is deliberately unlike every status colour, so it never reads as "safe" or "danger".
- **Status colours mean one thing each:** green = compliant / healthy, amber = degraded / needs a look, red = violation / failure.
- **Brand:** the Mahindra logo is the only brand-red element; alarms use their own red.
- **Type:** Manrope (UI and numbers, tabular figures) with JetBrains Mono for IDs, times and technical values.
- **Shape:** 16 px card radius, hairline borders, very soft depth; generous spacing; one primary action per screen.

## 6. Success measures

- A supervisor can tell whether anyone is unsafe within **2 seconds** of opening the app.
- A reviewer handles an incident in **≤ 3 seconds** with the keyboard (no mouse travel).
- A manager can answer "are we improving, and where do we fail?" from **one screen** (Command or Insights).
- No feature of the backend is lost: all API calls, permissions, live video and exports remain.

## 7. Designing for plant scale: 40-45 cameras

Testing runs on one camera; the plant will run 40-45. What changes at that scale, and the decision:

| Problem at 45 cameras | Decision |
|---|---|
| Backend config and the Cameras page both rejected more than **32** cameras | Limit raised to **64** in both (`backend/app/config.py`, `CamerasPage.tsx`) |
| 45 live video tiles at once overload the browser, the network and the server | **Paged video wall**: 4 / 9 / 16 tiles per page, frame rate drops as tiles shrink (8 → 5 → 3 fps), only on-screen tiles stream |
| Nobody can watch 45 videos | **Fleet board**: every camera as a small status cell (unsafe / not delivering / clear / stopped), all 45 on one screen, no video cost. On Command and as Live's "Board" view |
| A control-room screen must cover all cameras unattended | **Auto-cycle**: the wall turns the page every 20 s, and **holds while anyone is unsafe** so an alert is never cycled away |
| The important cameras get lost in a long list | Everywhere cameras are listed, **unsafe first, then not delivering, then the rest by name** |
| Long camera names make sentences unreadable | Status sentences name at most 3 cameras ("A, B, C and 4 more"); the hero shows up to 4 unsafe cameras live, with a link to the rest |
| Finding one camera among 45 | Search on Live and on Cameras & zones; "Needs attention" / "Turned off" filters; Ctrl K finds any camera |
| "Down" mixed up with "switched off on purpose" | "Down" counts only cameras that should be running but aren't |

### Capacity note (for the hardware decision)

The test server runs detection on an **Intel CPU (OpenVINO)** (from the server log: `model … on intel:cpu`). One camera is comfortable; 45 cameras at the same per-camera rate will very likely exceed a single CPU. Measure first: add cameras in steps and watch the capacity meter. Before go-live, plan for one of:

1. **An NVIDIA GPU** (the batched pipeline is built for it), or several detection servers splitting the cameras.
2. **Lower per-camera rates**: set low-traffic cameras to `priority: low` and reduce `inference.max_fps_per_stream`. PPE compliance does not need 15 fps; 2-4 fps per camera is usually enough.
3. Watch **Setup → System health**: the capacity meter shows when detection can't keep up.
