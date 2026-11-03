# Automated UAT suite

Runs the automatable cases of the UAT pack against a running copy of the app, then rebuilds the
Excel workbook and the HTML report from the results. The case list lives in one place
(`uat_cases.py`), so the workbook, the report and the runner never disagree.

| File | What it does |
|---|---|
| `uat_cases.py` | All 76 UAT cases: id, module, title, priority, role, preconditions, steps, expected result, and whether it is automated |
| `run_uat.py` | Signs in through the API and a real browser and runs the 52 automated checks; writes `results.json` (and screenshots, which show workers: delete them after checking) |
| `build_xlsx.py` | Builds `../PPE_Monitor_UAT_Test_Cases.xlsx` (Read Me, Summary, Test Cases, Defects) from the cases and a results file |
| `build_report.py` | Builds the one-page HTML execution report from the same inputs |
| `results-2026-10-29.json` | Results of the first run (52 of 52 passed) |

## Run it

Use a **separate test instance**, never the live plant server: the suite creates users, changes
settings, reviews and deletes incidents.

1. Start a test instance with a fresh database and a known first password:

   ```bash
   cd backend
   PPE_INITIAL_ADMIN_PASSWORD=UatInit2026x PPE_JWT_SECRET=<a-test-secret> \
   PPE_VIDEOS_DIR=$PWD/../videos python run.py --config /path/to/uat-config.yaml   # port 8001, empty db_path
   ```

   The config needs at least 3 cameras (one named "Gate ...", one requiring `gloves`) and a busy
   recording so incidents appear within two minutes.

2. Install the runner's only dependency and run it (Python 3.10+):

   ```bash
   pip install playwright openpyxl && playwright install chromium   # or set UAT_CHROME=/path/to/chrome
   cd docs/testing/uat
   python run_uat.py http://localhost:8001 UatInit2026x <a-test-secret> ./out
   ```

3. Rebuild the workbook and report from the new results:

   ```bash
   python build_xlsx.py out/results.json ../PPE_Monitor_UAT_Test_Cases.xlsx
   python build_report.py out/results.json out/uat-report.html
   ```

   Rebuilding the workbook resets the tester columns, so copy the testers' entries across first, or
   keep the testers' copy and only use the new report.

4. Stop the test instance and delete its database and `out/*.png`: they contain worker images.
