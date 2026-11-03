"""Build the UAT execution report page (HTML) from uat_cases.py + results.json."""
import html
import json
import sys
from collections import OrderedDict

from uat_cases import CASES

R = json.load(open(sys.argv[1]))
OUT = sys.argv[2]
e = html.escape

modules = list(OrderedDict.fromkeys(c[1] for c in CASES))
ran = [c for c in CASES if c[0] in R]
manual = [c for c in CASES if c[0] not in R]
passed = sum(R[c[0]]["status"] == "Pass" for c in ran)
failed = sum(R[c[0]]["status"] == "Fail" for c in ran)
p1_total = sum(c[3] == "P1" for c in CASES)
p1_ran = sum(c[3] == "P1" for c in ran)

mod_rows = []
for m in modules:
    cs = [c for c in CASES if c[1] == m]
    r = [c for c in cs if c[0] in R]
    p = sum(R[c[0]]["status"] == "Pass" for c in r)
    width = 0 if not cs else round(100 * len(r) / len(cs))
    mod_rows.append(f"""<tr><td>{e(m)}</td><td class="r num">{len(cs)}</td><td class="r num">{len(r)}</td>
<td class="r num ok-t">{p}</td><td class="r num">{len(cs) - len(r)}</td>
<td><div class="bar" role="img" aria-label="{len(r)} of {len(cs)} run automatically"><span style="width:{width}%"></span></div></td></tr>""")

def case_rows(cases):
    out = []
    for cid, module, title, prio, role, pre, steps, expected, auto in cases:
        res = R[cid]
        pill = {"Pass": "ok", "Fail": "bad", "Blocked": "warn"}[res["status"]]
        out.append(f"""<tr data-mod="{e(module)}"><td class="mono">{cid}</td><td><b>{e(title)}</b><span class="sub">{e(expected)}</span></td>
<td><span class="prio {prio.lower()}">{prio}</span></td><td><span class="pill {pill}">{res['status']}</span></td><td class="obs">{e(res['actual'])}</td></tr>""")
    return "\n".join(out)

def manual_rows(cases):
    return "\n".join(f"""<tr><td class="mono">{c[0]}</td><td><b>{e(c[2])}</b><span class="sub">Needs: {e(c[5])}</span></td>
<td><span class="prio {c[3].lower()}">{c[3]}</span></td><td>{e(c[4])}</td></tr>""" for c in cases)

mod_options = "".join(f'<option value="{e(m)}">{e(m)}</option>' for m in modules if any(c[1] == m for c in ran))

page = f"""<title>PPE Monitor UAT Run</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
/* Layout: one reading column; verdict figures, then coverage by module, then the evidence log of every executed case, then what is left for manual testers. Visual language follows the app (obsidian + iris, status colours mean one thing). */
:root {{
  --bg: #f6f6f9; --surface: #ffffff; --sunken: #eeeef3; --line: #dedde6;
  --ink: #17161d; --ink-2: #4a4857; --ink-3: #75738a;
  --accent: #6d5bf6; --accent-soft: #ecebff;
  --ok: #0f8a5f; --ok-soft: #e3f5ed; --warn: #a86400; --warn-soft: #fbf0dc; --bad: #c8283d; --bad-soft: #fbe6e9;
  --f-ui: "Manrope", "Segoe UI", system-ui, sans-serif;
  --f-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --bg: #0b0b0f; --surface: #14141b; --sunken: #1b1b24; --line: #2a2935;
  --ink: #f1f0f6; --ink-2: #b9b7c9; --ink-3: #85839a; --accent: #8b7cff; --accent-soft: #221f3d;
  --ok: #3ccf91; --ok-soft: #10261d; --warn: #f2b14c; --warn-soft: #2a2010; --bad: #ff6b7d; --bad-soft: #2d1418; color-scheme: dark }} }}
:root[data-theme="dark"] {{
  --bg: #0b0b0f; --surface: #14141b; --sunken: #1b1b24; --line: #2a2935;
  --ink: #f1f0f6; --ink-2: #b9b7c9; --ink-3: #85839a; --accent: #8b7cff; --accent-soft: #221f3d;
  --ok: #3ccf91; --ok-soft: #10261d; --warn: #f2b14c; --warn-soft: #2a2010; --bad: #ff6b7d; --bad-soft: #2d1418; color-scheme: dark }}
* {{ box-sizing: border-box }}
body {{ background: var(--bg); color: var(--ink); font: 15px/1.6 var(--f-ui); }}
.wrap {{ max-width: 1040px; margin: 0 auto; padding-block: 40px 72px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 44px; }}
h1, h2 {{ margin: 0; text-wrap: balance; letter-spacing: -0.02em; }}
h1 {{ font-size: clamp(28px, 5vw, 38px); line-height: 1.15; font-weight: 800; }}
h2 {{ font-size: 21px; font-weight: 700; }}
p {{ margin: 0; color: var(--ink-2); max-width: 70ch; }}
.eyebrow {{ font: 600 11.5px/1 var(--f-ui); letter-spacing: .12em; text-transform: uppercase; color: var(--accent); }}
.mono, .num {{ font-family: var(--f-mono); font-variant-numeric: tabular-nums; }}
header, section {{ display: grid; gap: 14px; min-width: 0; }}
.meta {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 24px; font-size: 13px; color: var(--ink-3); }}
.meta b {{ display: block; color: var(--ink); font-weight: 600; }}
.figs {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }}
.fig {{ background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 16px; display: grid; gap: 4px; }}
.fig .v {{ font: 700 30px/1.1 var(--f-mono); font-variant-numeric: tabular-nums; }}
.fig .k {{ font-size: 13px; color: var(--ink-3); font-weight: 600; }}
.fig.ok .v {{ color: var(--ok); }} .fig.bad .v {{ color: var(--bad); }} .fig.warn .v {{ color: var(--warn); }}
.verdict {{ border-left: 3px solid var(--ok); background: var(--ok-soft); border-radius: 0 12px 12px 0; padding: 14px 18px; color: var(--ink-2); max-width: 80ch; }}
.verdict.warn {{ border-color: var(--warn); background: var(--warn-soft); }}
.tbl {{ overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }}
table {{ border-collapse: collapse; width: 100%; font-size: 13.5px; }}
th, td {{ text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }}
th {{ font-size: 12px; font-weight: 600; color: var(--ink-3); background: var(--sunken); white-space: nowrap; position: sticky; top: 0; }}
tr:last-child td {{ border-bottom: 0; }}
td.r, th.r {{ text-align: right; }}
td .sub {{ display: block; color: var(--ink-3); font-size: 12.5px; margin-top: 2px; }}
td.obs {{ font-family: var(--f-mono); font-size: 12px; color: var(--ink-2); min-width: 260px; }}
td.mono {{ font-weight: 600; white-space: nowrap; }}
.ok-t {{ color: var(--ok); font-weight: 700; }}
.pill {{ display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 9px; font-size: 12px; font-weight: 700; white-space: nowrap; }}
.pill::before {{ content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }}
.pill.ok {{ color: var(--ok); background: var(--ok-soft); }} .pill.bad {{ color: var(--bad); background: var(--bad-soft); }} .pill.warn {{ color: var(--warn); background: var(--warn-soft); }}
.prio {{ font: 600 12px var(--f-mono); padding: 1px 6px; border-radius: 6px; background: var(--sunken); color: var(--ink-2); }}
.prio.p1 {{ background: var(--bad-soft); color: var(--bad); }}
.bar {{ height: 8px; min-width: 90px; border-radius: 999px; background: var(--sunken); overflow: hidden; }}
.bar span {{ display: block; height: 100%; background: var(--accent); border-radius: 999px; }}
.tools {{ display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 13px; color: var(--ink-3); }}
select {{ font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 5px 8px; }}
ul.notes {{ margin: 0; padding-left: 20px; display: grid; gap: 8px; color: var(--ink-2); max-width: 80ch; }}
strong, b {{ color: var(--ink); }}
footer {{ border-top: 1px solid var(--line); padding-top: 16px; font-size: 13px; color: var(--ink-3); }}
:focus-visible {{ outline: 2px solid var(--accent); outline-offset: 2px; }}
</style>

<div class="wrap">
  <header>
    <span class="eyebrow">PPE Compliance Monitor · UAT execution report</span>
    <h1>Automated acceptance run, 29 Oct 2026</h1>
    <p>Which of the {len(CASES)} UAT test cases Claude ran, what each one showed, and what is left for manual testers. Case definitions and the tester columns are in <span class="mono">docs/testing/PPE_Monitor_UAT_Test_Cases.xlsx</span>.</p>
    <div class="meta">
      <span><b>Build under test</b>Commit de5fc87 plus the 28–29 Oct security, capacity and UI changes (not yet committed)</span>
      <span><b>Environment</b>Separate QA copy on the development laptop (Intel i5-1335U, CPU / OpenVINO), fresh database</span>
      <span><b>Cameras</b>3 recorded NVR cameras: Gate No. 2, Assembly Line 3, Store Dock</span>
      <span><b>Method</b>API calls plus a real Chrome browser (Playwright), signed in as Super Admin and as Admin</span>
    </div>
  </header>

  <section aria-labelledby="h-result">
    <h2 id="h-result">Result</h2>
    <div class="figs">
      <div class="fig"><span class="v">{len(CASES)}</span><span class="k">Test cases in the pack</span></div>
      <div class="fig"><span class="v">{len(ran)}</span><span class="k">Run by Claude</span></div>
      <div class="fig ok"><span class="v">{passed}</span><span class="k">Passed</span></div>
      <div class="fig {'bad' if failed else ''}"><span class="v">{failed}</span><span class="k">Failed</span></div>
      <div class="fig warn"><span class="v">{len(manual)}</span><span class="k">Need a manual tester</span></div>
    </div>
    <p class="verdict">Every case Claude could run passed, including {p1_ran} of the {p1_total} go-live blockers (P1). The remaining {p1_total - p1_ran} P1 cases need real cameras, people or the production server, so the pack is <strong>not yet signed off</strong>: go-live needs every P1 case passed by a tester on the plant setup.</p>
  </section>

  <section aria-labelledby="h-mod">
    <h2 id="h-mod">Coverage by module</h2>
    <div class="tbl"><table>
      <thead><tr><th>Module</th><th class="r">Cases</th><th class="r">Run by Claude</th><th class="r">Passed</th><th class="r">Manual</th><th>Automated share</th></tr></thead>
      <tbody>{''.join(mod_rows)}</tbody>
    </table></div>
  </section>

  <section aria-labelledby="h-run">
    <h2 id="h-run">Every executed case and what it showed</h2>
    <div class="tools"><label for="modf">Module</label>
      <select id="modf"><option value="">All modules ({len(ran)})</option>{mod_options}</select></div>
    <div class="tbl"><table id="runs">
      <thead><tr><th>ID</th><th>Test case and expected result</th><th>Priority</th><th>Result</th><th>Observed</th></tr></thead>
      <tbody>{case_rows(ran)}</tbody>
    </table></div>
  </section>

  <section aria-labelledby="h-notes">
    <h2 id="h-notes">Notes from the run</h2>
    <ul class="notes">
      <li><strong>Two corrections to the test script, not the app.</strong> USR-03 first errored because the script asked the audit trail for 500 entries; the API allows at most 200. With 200, all six required actions were found. SET-02 first showed an empty error text because the script read the wrong field name; the server's message was correct.</li>
      <li><strong>DEF-001 (Low):</strong> "Compliance today" shows "–" for up to 60 s after start, even with incidents, because worker counts are saved once a minute.</li>
      <li><strong>DEF-002 (High, hardware):</strong> on this laptop each camera got 1.1–1.2 fps of detection with 3 cameras, while the main app was also running. The capacity planner reports 45 cameras need about 42 times this machine. Re-run PERF-01 and PERF-02 on the GPU server.</li>
      <li><strong>Privacy:</strong> screenshots taken during the run showed workers. They were checked and then deleted, along with the QA database. The Observed column records what each check saw.</li>
    </ul>
  </section>

  <section aria-labelledby="h-manual">
    <h2 id="h-manual">Left for manual testing ({len(manual)})</h2>
    <p>These need real cameras, people, hardware, time or judgement. Testers record results in the yellow columns of the workbook.</p>
    <div class="tbl"><table>
      <thead><tr><th>ID</th><th>Test case and what it needs</th><th>Priority</th><th>Tester</th></tr></thead>
      <tbody>{manual_rows(manual)}</tbody>
    </table></div>
  </section>

  <footer>Generated from the same case list and results file as the Excel workbook, so the two always agree. The automated checks can be re-run on the plant server before sign-off.</footer>
</div>
<script>
(function () {{
  var sel = document.getElementById("modf");
  var rows = document.querySelectorAll("#runs tbody tr");
  sel.addEventListener("change", function () {{
    rows.forEach(function (r) {{ r.hidden = !!sel.value && r.getAttribute("data-mod") !== sel.value; }});
  }});
}})();
</script>
"""
open(OUT, "w").write(page)
print("written", OUT, "ran", len(ran), "pass", passed, "manual", len(manual), "p1", p1_ran, "/", p1_total)
