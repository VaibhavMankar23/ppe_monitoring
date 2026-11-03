"""Build the UAT workbook from uat_cases.py + the automated run's results.json."""
import json
import sys
from collections import OrderedDict

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from uat_cases import CASES, CASE

RESULTS, OUT = json.load(open(sys.argv[1])), sys.argv[2]
RUN_DATE = "29 Oct 2026"

FONT = "Arial"
NAVY = "1F2A44"
HEAD = PatternFill("solid", fgColor=NAVY)
INPUT = PatternFill("solid", fgColor="FFF4C2")  # cells the tester fills in
BAND = PatternFill("solid", fgColor="F3F4F8")
THIN = Side(style="thin", color="C9CCD6")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="top")
CENTER = Alignment(horizontal="center", vertical="top", wrap_text=True)


def f(size=10, bold=False, color="000000", italic=False):
    return Font(name=FONT, size=size, bold=bold, color=color, italic=italic)


def header(ws, row, labels, widths=None):
    for i, label in enumerate(labels, 1):
        c = ws.cell(row=row, column=i, value=label)
        c.font, c.fill, c.alignment, c.border = f(10, True, "FFFFFF"), HEAD, Alignment(wrap_text=True, vertical="center"), BOX
    if widths:
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w
    ws.row_dimensions[row].height = 32


def status_colors(ws, rng):
    for val, color in (("Pass", "D8F3E3"), ("Fail", "FBDADF"), ("Blocked", "FCEBCB"), ("N/A", "E6E7EC")):
        ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=[f'"{val}"'], fill=PatternFill("solid", fgColor=color)))


wb = Workbook()

# ====================================================================== Read Me
rm = wb.active
rm.title = "Read Me"
rm.sheet_view.showGridLines = False
rm.column_dimensions["A"].width = 3
rm.column_dimensions["B"].width = 26
rm.column_dimensions["C"].width = 100
rows = [
    ("title", "PPE Compliance Monitor - User Acceptance Test (UAT) pack"),
    ("sub", f"Version 1.0 · prepared {RUN_DATE} · {len(CASES)} test cases"),
    ("gap", None),
    ("h", "Purpose"),
    ("kv", ("What this is", "Acceptance tests for go-live of the PPE Compliance Monitor at plant scale (30-45 cameras). Each case is written for a manual tester; most were also run automatically by Claude.")),
    ("kv", ("Who tests", "Safety / EHS reviewers (Review, Insights), shift supervisors (Command, Live), plant IT (cameras, server, security), Super Admin (users, settings).")),
    ("kv", ("Sign-off rule", "Go-live needs every P1 case = Pass in the 'Tester status' column, and no open Critical/High defect. See the Summary sheet.")),
    ("gap", None),
    ("h", "How to use this workbook"),
    ("kv", ("1. Test Cases sheet", "Follow 'Test steps', compare with 'Expected result', then fill the YELLOW columns only: Tester status, Actual result, Tester, Test date, Defect ID, Comments.")),
    ("kv", ("2. Defects sheet", "Log every Fail there (one row each) and put its Defect ID on the test case. Two observations from Claude's run are already logged.")),
    ("kv", ("3. Summary sheet", "Counts update by themselves from the Test Cases sheet. Nothing to type there.")),
    ("kv", ("Do not edit", "Columns A-L of Test Cases (case definition and Claude's run). Change a case only by agreement, and note it in Comments.")),
    ("gap", None),
    ("h", "Values used"),
    ("kv", ("Tester status", "Not run (default) · Pass · Fail · Blocked (cannot test: missing camera, hardware, access) · N/A (does not apply to this site)")),
    ("kv", ("Priority", "P1 = go-live blocker · P2 = must fix before full roll-out · P3 = improvement")),
    ("kv", ("Execution type", "Automated + manual = Claude already ran an automated check (columns J-L); still re-test by hand on the plant server. Manual only = needs real cameras, people, hardware or judgement.")),
    ("kv", ("Claude result", "Pass / Fail / Blocked from the automated run. 'Not automated' = manual-only case.")),
    ("gap", None),
    ("h", "Claude's automated run"),
    ("kv", ("When / build", f"{RUN_DATE}, code at commit de5fc87 plus the uncommitted security and UI changes of 28-29 Oct 2026.")),
    ("kv", ("Environment", "Separate QA copy of the app on the development laptop (Intel i5-1335U, CPU only, OpenVINO), fresh empty database, 3 recorded NVR cameras (Gate No. 2, Assembly Line 3, Store Dock). Driven by API calls and a real Chrome browser.")),
    ("kv", ("Not covered by Claude", "Real RTSP cameras, zones drawn by hand, alarms (email / webhook), HTTPS, detection accuracy with real people, 30-45 camera load, restart and retention over time. These are the 'Manual only' cases.")),
    ("kv", ("Privacy", "Screenshots from the run were deleted after checking because they show workers; the evidence column records what was observed instead.")),
    ("gap", None),
    ("h", "Example of a filled-in row (yellow columns)"),
    ("kv", ("Tester status", "Fail")),
    ("kv", ("Actual result", "Incident appeared after 9 s, not ~3 s. Evidence image clear.")),
    ("kv", ("Tester / date", "R. Patil (EHS) · 04-Nov-2026")),
    ("kv", ("Defect ID / Comments", "DEF-003 · Camera 12 at night shift, low light")),
]
r = 2
example = False  # rows under the "Example" heading show the yellow input style
for kind, val in rows:
    if kind == "title":
        rm.cell(row=r, column=2, value=val).font = f(16, True, NAVY)
    elif kind == "sub":
        rm.cell(row=r, column=2, value=val).font = f(10, color="5B6070")
    elif kind == "h":
        c = rm.cell(row=r, column=2, value=val)
        c.font = f(11, True, NAVY)
        example = val.startswith("Example")
        rm.row_dimensions[r].height = 22
    elif kind == "kv":
        k, v = val
        a = rm.cell(row=r, column=2, value=k); a.font = f(10, True); a.alignment = WRAP
        b = rm.cell(row=r, column=3, value=v); b.font = f(10); b.alignment = WRAP
        if example:
            b.fill = INPUT
        rm.row_dimensions[r].height = max(16, 14 * (len(v) // 95 + 1))
    r += 1

# ====================================================================== Test Cases
tc = wb.create_sheet("Test Cases")
cols = ["Test ID", "Module", "Test case", "Priority", "Role", "Preconditions", "Test steps", "Expected result",
        "Execution type", "Claude result", "Claude evidence (observed)", "Claude run date",
        "Tester status", "Actual result", "Tester", "Test date", "Defect ID", "Comments"]
widths = [10, 17, 34, 8, 13, 30, 46, 42, 13, 11, 46, 11, 11, 34, 14, 12, 10, 26]
header(tc, 1, cols, widths)
for i, (cid, module, title, prio, role, pre, steps, expected, auto) in enumerate(CASES, start=2):
    res = RESULTS.get(cid)
    vals = [cid, module, title, prio, role, pre, steps, expected,
            "Automated + manual" if auto else "Manual only",
            res["status"] if res else "Not automated", res["actual"] if res else "", RUN_DATE if res else "",
            "Not run", None, None, None, None, None]
    for j, v in enumerate(vals, 1):
        c = tc.cell(row=i, column=j, value=v)
        c.font, c.alignment, c.border = f(9.5), (CENTER if j in (1, 4, 9, 10, 12, 13, 16, 17) else WRAP), BOX
        if j >= 13:
            c.fill = INPUT
        elif i % 2 == 0:
            c.fill = BAND
    tc.cell(row=i, column=1).font = f(9.5, True)
    tc.row_dimensions[i].height = max(45, 13 * (steps.count("\n") + 1 + len(steps) // 60))
last = len(CASES) + 1
tc.freeze_panes = "D2"
tc.auto_filter.ref = f"A1:R{last}"
dv = DataValidation(type="list", formula1='"Not run,Pass,Fail,Blocked,N/A"', allow_blank=False,
                    error="Choose Not run, Pass, Fail, Blocked or N/A", errorTitle="Tester status")
tc.add_data_validation(dv); dv.add(f"M2:M{last}")
dvd = DataValidation(type="date", operator="greaterThan", formula1="DATE(2026,1,1)", allow_blank=True,
                     error="Enter a date (dd-mmm-yyyy)")
tc.add_data_validation(dvd); dvd.add(f"P2:P{last}")
for c in tc[f"P2:P{last}"]:
    c[0].number_format = "dd-mmm-yyyy"
status_colors(tc, f"J2:J{last}")
status_colors(tc, f"M2:M{last}")
tc.conditional_formatting.add(f"D2:D{last}", CellIsRule(operator="equal", formula=['"P1"'], font=Font(name=FONT, bold=True, color="B4232F")))
tc["J1"].comment = Comment("Result of Claude's automated check on the QA copy (29 Oct 2026). Re-test by hand on the plant server.", "Claude")
tc["M1"].comment = Comment("Fill in: Not run / Pass / Fail / Blocked / N/A", "Claude")
tc.sheet_properties.tabColor = "6D5BF6"

# ====================================================================== Defects
df = wb.create_sheet("Defects")
dcols = ["Defect ID", "Test ID", "Title", "Severity", "Steps to reproduce", "Expected", "Actual", "Status",
         "Raised by", "Raised on", "Owner", "Fixed in (build)", "Retest result", "Comments"]
header(df, 1, dcols, [10, 9, 36, 10, 40, 30, 36, 11, 12, 12, 12, 12, 11, 30])
known = [
    ("DEF-001", "CMD-04", "'Compliance today' shows '-' for up to 60 s after start even when incidents exist", "Low",
     "1. Start the server with cameras running.\n2. Open Command within the first minute.",
     "A compliance figure (or 'Collecting...') once workers have been checked.",
     "Shows '-' until the first 60-second batch of worker counts is saved (pipeline OBS_FLUSH_SECONDS = 60).",
     "Open", "Claude", RUN_DATE, "", "", "", "By design today; consider a 'Collecting data' label."),
    ("DEF-002", "PERF-01", "Development laptop cannot run plant scale (capacity observation, not a code defect)", "High",
     "1. Run 3 cameras on the i5 laptop.\n2. Open System health > Capacity planner.",
     "30-45 cameras at >= 2 fps each on the production server.",
     "3 cameras run at ~1.1-1.2 fps each; planner says 45 cameras need ~42x this machine (two servers were sharing the CPU during the run).",
     "Open", "Claude", RUN_DATE, "IT / Owner", "", "", "Needs the NVIDIA GPU server; re-run PERF-01/02 there."),
]
for i, row in enumerate(known, start=2):
    for j, v in enumerate(row, 1):
        c = df.cell(row=i, column=j, value=v)
        c.font, c.alignment, c.border = f(9.5), WRAP, BOX
    df.row_dimensions[i].height = 70
for i in range(len(known) + 2, 61):  # empty, formatted rows for testers
    for j in range(1, len(dcols) + 1):
        c = df.cell(row=i, column=j)
        c.font, c.alignment, c.border, c.fill = f(9.5), WRAP, BOX, INPUT
    df.cell(row=i, column=1, value=f"DEF-{i - 1:03d}").font = f(9.5, True)
for c in df["J2:J60"]:
    c[0].number_format = "dd-mmm-yyyy"
sev = DataValidation(type="list", formula1='"Critical,High,Medium,Low"', allow_blank=True)
stv = DataValidation(type="list", formula1='"Open,In progress,Fixed,Retest,Closed,Rejected"', allow_blank=True)
rtv = DataValidation(type="list", formula1='"Pass,Fail"', allow_blank=True)
for d, rng in ((sev, "D2:D60"), (stv, "H2:H60"), (rtv, "M2:M60")):
    df.add_data_validation(d); d.add(rng)
for val, color in (("Critical", "F4B4BC"), ("High", "FBDADF"), ("Medium", "FCEBCB"), ("Low", "E6E7EC")):
    df.conditional_formatting.add("D2:D60", CellIsRule(operator="equal", formula=[f'"{val}"'], fill=PatternFill("solid", fgColor=color)))
df.freeze_panes = "C2"
df.auto_filter.ref = "A1:N60"

# ====================================================================== Summary (formulas only)
sm = wb.create_sheet("Summary", 1)
sm.sheet_view.showGridLines = False
T = "'Test Cases'!"
rngs = {k: f"{T}${c}$2:${c}${last}" for k, c in (("mod", "B"), ("pri", "D"), ("exe", "I"), ("cl", "J"), ("st", "M"))}
sm["B2"] = "UAT summary"; sm["B2"].font = f(16, True, NAVY)
sm["B3"] = "All figures are formulas over the Test Cases sheet: they update as testers fill in 'Tester status'."; sm["B3"].font = f(10, color="5B6070")

# go-live gate
sm["B5"] = "Go-live gate"; sm["B5"].font = f(12, True, NAVY)
gate = [
    ("P1 cases", f"=COUNTIF({rngs['pri']},\"P1\")"),
    ("P1 cases passed by testers", f"=COUNTIFS({rngs['pri']},\"P1\",{rngs['st']},\"Pass\")"),
    ("P1 cases failed", f"=COUNTIFS({rngs['pri']},\"P1\",{rngs['st']},\"Fail\")"),
    ("Open Critical / High defects", "=SUMPRODUCT(((Defects!$D$2:$D$60=\"Critical\")+(Defects!$D$2:$D$60=\"High\"))*(Defects!$H$2:$H$60<>\"Closed\")*(Defects!$H$2:$H$60<>\"Rejected\"))"),
    ("Ready for go-live?", "=IF(AND(C7=C6,C9=0),\"YES\",\"NOT YET\")"),
]
for i, (k, v) in enumerate(gate, start=6):
    a, b = sm.cell(row=i, column=2, value=k), sm.cell(row=i, column=3, value=v)
    a.font, b.font = f(10, True), f(11, True)
    a.border = b.border = BOX
    b.alignment = Alignment(horizontal="center")
sm.conditional_formatting.add("C10", CellIsRule(operator="equal", formula=['"YES"'], fill=PatternFill("solid", fgColor="D8F3E3")))
sm.conditional_formatting.add("C10", CellIsRule(operator="equal", formula=['"NOT YET"'], fill=PatternFill("solid", fgColor="FBDADF")))

# by module
start = 13
sm.cell(row=start - 1, column=2, value="By module").font = f(12, True, NAVY)
mcols = ["Module", "Cases", "P1", "Automated", "Claude: Pass", "Claude: Fail", "Claude: Blocked",
         "Tester: Pass", "Tester: Fail", "Tester: Blocked", "Tester: Not run", "Tester pass rate"]
for j, label in enumerate(mcols, 2):
    c = sm.cell(row=start, column=j, value=label)
    c.font, c.fill, c.alignment, c.border = f(9.5, True, "FFFFFF"), HEAD, Alignment(wrap_text=True, horizontal="center", vertical="center"), BOX
sm.row_dimensions[start].height = 30
modules = list(OrderedDict.fromkeys(c[1] for c in CASES))
for i, m in enumerate(modules, start=start + 1):
    M = f"$B{i}"
    fs = [m,
          f"=COUNTIF({rngs['mod']},{M})",
          f"=COUNTIFS({rngs['mod']},{M},{rngs['pri']},\"P1\")",
          f"=COUNTIFS({rngs['mod']},{M},{rngs['exe']},\"Automated + manual\")",
          f"=COUNTIFS({rngs['mod']},{M},{rngs['cl']},\"Pass\")",
          f"=COUNTIFS({rngs['mod']},{M},{rngs['cl']},\"Fail\")",
          f"=COUNTIFS({rngs['mod']},{M},{rngs['cl']},\"Blocked\")",
          f"=COUNTIFS({rngs['mod']},{M},{rngs['st']},\"Pass\")",
          f"=COUNTIFS({rngs['mod']},{M},{rngs['st']},\"Fail\")",
          f"=COUNTIFS({rngs['mod']},{M},{rngs['st']},\"Blocked\")",
          f"=COUNTIFS({rngs['mod']},{M},{rngs['st']},\"Not run\")",
          f"=IF(C{i}-COUNTIFS({rngs['mod']},{M},{rngs['st']},\"N/A\")=0,\"-\",I{i}/(C{i}-COUNTIFS({rngs['mod']},{M},{rngs['st']},\"N/A\")))"]
    for j, v in enumerate(fs, 2):
        c = sm.cell(row=i, column=j, value=v)
        c.font, c.border = f(10), BOX
        c.alignment = Alignment(horizontal="left" if j == 2 else "center")
    sm.cell(row=i, column=13).number_format = "0%"
tot = start + 1 + len(modules)
sm.cell(row=tot, column=2, value="Total").font = f(10, True)
for j in range(3, 13):
    col = get_column_letter(j)
    c = sm.cell(row=tot, column=j, value=f"=SUM({col}{start + 1}:{col}{tot - 1})")
    c.font, c.border, c.alignment = f(10, True), BOX, Alignment(horizontal="center")
sm.cell(row=tot, column=2).border = BOX
c = sm.cell(row=tot, column=13, value=f"=IF(C{tot}-COUNTIF({rngs['st']},\"N/A\")=0,\"-\",I{tot}/(C{tot}-COUNTIF({rngs['st']},\"N/A\")))")
c.font, c.border, c.alignment, c.number_format = f(10, True), BOX, Alignment(horizontal="center"), "0%"

# by priority
p0 = tot + 3
sm.cell(row=p0 - 1, column=2, value="By priority").font = f(12, True, NAVY)
for j, label in enumerate(["Priority", "Cases", "Claude: Pass", "Tester: Pass", "Tester: Fail", "Tester: Not run"], 2):
    c = sm.cell(row=p0, column=j, value=label)
    c.font, c.fill, c.alignment, c.border = f(9.5, True, "FFFFFF"), HEAD, Alignment(horizontal="center"), BOX
for i, pr in enumerate(("P1", "P2", "P3"), start=p0 + 1):
    P = f"$B{i}"
    for j, v in enumerate([pr, f"=COUNTIF({rngs['pri']},{P})", f"=COUNTIFS({rngs['pri']},{P},{rngs['cl']},\"Pass\")",
                           f"=COUNTIFS({rngs['pri']},{P},{rngs['st']},\"Pass\")", f"=COUNTIFS({rngs['pri']},{P},{rngs['st']},\"Fail\")",
                           f"=COUNTIFS({rngs['pri']},{P},{rngs['st']},\"Not run\")"], 2):
        c = sm.cell(row=i, column=j, value=v)
        c.font, c.border, c.alignment = f(10), BOX, Alignment(horizontal="center")
sm.column_dimensions["A"].width = 3
sm.column_dimensions["B"].width = 30
for j in range(3, 14):
    sm.column_dimensions[get_column_letter(j)].width = 12
sm.sheet_properties.tabColor = "0F8A5F"

wb.save(OUT)
print("saved", OUT, "cases", len(CASES), "automated results", sum(1 for c in CASES if c[0] in RESULTS))
