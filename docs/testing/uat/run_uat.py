"""Run the automatable UAT cases against a running QA instance; writes results.json.

    python run_uat.py http://localhost:8001 <initial-admin-password> <jwt-secret> <out-dir>
"""
import http.client
import json
import os
import sys
import time
import traceback
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

from uat_cases import CASE

B, INITIAL_PW, JWT_SECRET, OUT = sys.argv[1], sys.argv[2], sys.argv[3], Path(sys.argv[4])
OUT.mkdir(parents=True, exist_ok=True)
SUPER_PW, ADMIN_PW, ADMIN2_PW = "UatSuper2026x", "UatAdmin2026x", "UatTemp2026x"
results: dict[str, dict] = {}


def record(cid, ok, actual, blocked=False):
    status = "Blocked" if blocked else ("Pass" if ok else "Fail")
    results[cid] = {"status": status, "actual": actual, "at": time.strftime("%Y-%m-%d %H:%M")}
    print(f"{cid:8s} {status:7s} {actual}")


def check(cid):
    """Decorator-ish runner: a crash is a Fail with the error as the actual result."""
    def wrap(fn):
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            record(cid, False, f"Error: {type(e).__name__}: {str(e)[:200]}")
            traceback.print_exc()
        return fn
    return wrap


with sync_playwright() as p:
    api = p.request.new_context(base_url=B)

    def call(method, path, token=None, **kw):
        h = kw.pop("headers", {})
        if token:
            h["Authorization"] = f"Bearer {token}"
        r = api.fetch(path, method=method, headers=h, **kw)
        try:
            body = r.json()
        except Exception:  # noqa: BLE001
            body = r.text()
        return r.status, body, r

    def token_for(user, pw):
        s, b, _ = call("POST", "/api/auth/login", data={"username": user, "password": pw, "token_transport": "body"})
        assert s == 200, f"login {user}: {s} {b}"
        return b["access_token"]

    chrome = os.environ.get("UAT_CHROME")  # an installed Chrome; default: Playwright's own Chromium
    browser = p.chromium.launch(executable_path=chrome or None, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1600, "height": 950})
    page = ctx.new_page()
    console_errors = []
    page.on("console", lambda m: m.type == "error" and "401" not in m.text and console_errors.append(m.text))

    def ui_login(pg, user, pw):
        pg.goto(B + "/#/login")
        pg.wait_for_selector("input[name=username]")
        pg.fill("input[name=username]", user)
        pg.fill("input[type=password]", pw)
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(2000)

    def blob_frames(pg):
        return pg.evaluate("Array.from(document.images).filter(i => i.src.startsWith('blob:') && i.naturalWidth > 0).length")

    # ------------------------------------------------------------ sign-in
    @check("AUTH-09")
    def _():
        s, b, _ = call("POST", "/api/auth/login", data={"username": "admin", "password": "mahindra123"})
        record("AUTH-09", s == 401, f"admin / mahindra123 -> HTTP {s}")

    @check("AUTH-01")
    def _():
        ui_login(page, "admin", INITIAL_PW)
        fields = page.locator("input[type=password]").all()
        forced = len(fields) >= 2
        page.screenshot(path=str(OUT / "AUTH-01-forced-change.png"))
        if len(fields) == 3:
            fields[0].fill(INITIAL_PW); fields[1].fill(SUPER_PW); fields[2].fill(SUPER_PW)
        elif len(fields) == 2:
            fields[0].fill(SUPER_PW); fields[1].fill(SUPER_PW)
        page.keyboard.press("Enter")
        page.wait_for_timeout(3000)
        landed = "overview" in page.url or page.get_by_text("Good ").count() > 0
        record("AUTH-01", forced and landed, f"forced change screen: {forced}; after saving landed on Command: {landed}")

    SUP = token_for("admin", SUPER_PW)

    @check("AUTH-02")
    def _():
        s, b, _ = call("POST", "/api/auth/login", data={"username": "admin", "password": "wrong-Pass1"})
        results["_wrongmsg"] = b.get("detail") if isinstance(b, dict) else str(b)
        record("AUTH-02", s == 401 and "Incorrect username or password" in json.dumps(b), f"HTTP {s}: {results['_wrongmsg']}")

    @check("AUTH-03")
    def _():
        s, b, _ = call("POST", "/api/auth/login", data={"username": "no_such_user", "password": "wrong-Pass1"})
        same = (b.get("detail") if isinstance(b, dict) else str(b)) == results.get("_wrongmsg")
        record("AUTH-03", s == 401 and same, f"HTTP {s}; same message as wrong password: {same}")

    @check("AUTH-04")
    def _():
        codes = [call("POST", "/api/auth/login", data={"username": "lock_probe", "password": f"bad-{i}x"})[0] for i in range(6)]
        record("AUTH-04", codes[:5] == [401] * 5 and codes[5] == 429, f"attempt status codes: {codes}")

    # ------------------------------------------------------------ users
    @check("USR-01")
    def _():
        s, b, _ = call("POST", "/api/users", SUP, data={"username": "uat_admin", "password": ADMIN_PW, "role": "admin", "must_change_password": False})
        s2, b2, _ = call("POST", "/api/users", SUP, data={"username": "uat_temp", "password": ADMIN2_PW, "role": "admin", "must_change_password": True})
        t = call("POST", "/api/auth/login", data={"username": "uat_temp", "password": ADMIN2_PW, "token_transport": "body"})[1]
        must = (t.get("user") or {}).get("must_change_password")
        record("USR-01", s == 201 and s2 == 201 and must is True, f"create admin HTTP {s}; second user HTTP {s2}; its first sign-in must change password: {must}")

    @check("AUTH-05")
    def _():
        bad = [call("POST", "/api/users", SUP, data={"username": "weakling", "password": pw, "role": "admin"})[0] for pw in ("short1", "allletters")]
        bad.append(call("POST", "/api/users", SUP, data={"username": "weakling2", "password": "weakling2", "role": "admin"})[0])
        created = any(c == 201 for c in bad)
        record("AUTH-05", not created and all(400 <= c < 500 for c in bad), f"weak passwords refused with HTTP {bad}")

    ADM = token_for("uat_admin", ADMIN_PW)

    @check("USR-02")
    def _():
        users = call("GET", "/api/users", SUP)[1]
        uid = next(u["id"] for u in users if u["username"] == "uat_temp")
        s, _, _ = call("PATCH", f"/api/users/{uid}", SUP, data={"is_active": False})
        s2, b2, _ = call("POST", "/api/auth/login", data={"username": "uat_temp", "password": ADMIN2_PW})
        record("USR-02", s == 200 and s2 == 403, f"deactivate HTTP {s}; sign-in afterwards HTTP {s2}: {b2.get('detail') if isinstance(b2, dict) else b2}")

    # ------------------------------------------------------------ roles
    @check("ROLE-03")
    def _():
        s, _, _ = call("GET", "/api/violations/dataset", ADM)
        s2, _, _ = call("GET", "/api/violations/export", ADM)
        record("ROLE-03", s == 403 and s2 == 200, f"Admin dataset export HTTP {s}; Admin CSV export HTTP {s2}")

    @check("ROLE-04")
    def _():
        doc = call("GET", "/api/config", ADM)[1]
        cfg = doc["config"]; cfg["inference"]["max_fps_per_stream"] = 9
        s, b, _ = call("PUT", "/api/config", ADM, data={"config": cfg, "etag": doc["etag"]})
        record("ROLE-04", s == 403, f"Admin changing the detection rate -> HTTP {s}")

    @check("ROLE-05")
    def _():
        doc = call("GET", "/api/config", ADM)[1]
        cfg = doc["config"]; old = cfg["streams"][0]["name"]; cfg["streams"][0]["name"] = old + " (UAT)"
        s, b, _ = call("PUT", "/api/config", ADM, data={"config": cfg, "etag": doc["etag"]})
        name = call("GET", "/api/streams/" + cfg["streams"][0]["id"], ADM)[1].get("name")
        doc = call("GET", "/api/config", ADM)[1]; cfg = doc["config"]; cfg["streams"][0]["name"] = old
        s2 = call("PUT", "/api/config", ADM, data={"config": cfg, "etag": doc["etag"]})[0]
        record("ROLE-05", s == 200 and name == old + " (UAT)" and s2 == 200, f"rename HTTP {s}, live name '{name}', rename back HTTP {s2}")

    @check("ROLE-06")
    def _():
        doc = call("GET", "/api/config", SUP)[1]; cfg = doc["config"]
        cfg.setdefault("alarm", {}).setdefault("email", {})["password"] = "Smtp-Secret-77"
        cfg["alarm"].setdefault("webhook", {})["url"] = "https://hooks.example/UAT-T0KEN"
        s = call("PUT", "/api/config", SUP, data={"config": cfg, "etag": doc["etag"]})[0]
        seen = json.dumps(call("GET", "/api/config", ADM)[1])
        leaked = "Smtp-Secret-77" in seen or "UAT-T0KEN" in seen
        record("ROLE-06", s == 200 and not leaked, f"Super Admin saved alarm secrets HTTP {s}; visible to Admin: {leaked}")

    # ------------------------------------------------------------ settings / cameras
    @check("SET-01")
    def _():
        up0 = call("GET", "/api/system/health", SUP)[1]["uptime_s"]
        doc = call("GET", "/api/config", SUP)[1]; cfg = doc["config"]; cfg["inference"]["max_fps_per_stream"] = 2
        s, b, _ = call("PUT", "/api/config", SUP, data={"config": cfg, "etag": doc["etag"]})
        h = call("GET", "/api/system/health", SUP)[1]
        record("SET-01", s == 200 and h["capacity"].get("max_fps_per_stream") == 2 and h["uptime_s"] >= up0,
               f"save HTTP {s}; running limit now {h['capacity'].get('max_fps_per_stream')} fps; server uptime kept ({h['uptime_s']} s)")

    @check("SET-02")
    def _():
        s, b, _ = call("POST", "/api/config/validate", SUP, data={"yaml": "streams: [\n  - id: x\n"})
        err = (b.get("errors") or [{}])[0]
        record("SET-02", b.get("valid") is False and err.get("line") is not None, f"valid={b.get('valid')}; error: {err.get('msg', '')[:80]} (line {err.get('line')})")

    @check("SET-03")
    def _():
        s, b, _ = call("GET", "/api/config/backups", SUP)
        record("SET-03", s == 200 and len(b) >= 1, f"{len(b)} backups listed after the saves above (restore itself: manual)")

    @check("CAM-01")
    def _():
        files = call("GET", "/api/sources/files", SUP)[1]["files"]
        s, b, _ = call("POST", "/api/sources/test", SUP, data={"source": {"type": "file", "uri": files[0]["uri"]}}, timeout=60000)
        record("CAM-01", b.get("ok") is True and bool(b.get("thumbnail")), f"{files[0]['name']}: ok={b.get('ok')} {b.get('message')}")

    @check("CAM-02")
    def _():
        t0 = time.time()
        s, b, _ = call("POST", "/api/sources/test", SUP, data={"source": {"type": "rtsp", "uri": "rtsp://10.255.255.1/stream", "timeout": 3}}, timeout=60000)
        record("CAM-02", b.get("ok") is False and bool(b.get("message")), f"ok={b.get('ok')} after {time.time()-t0:.0f} s: {str(b.get('message'))[:90]}")

    @check("CAM-04")
    def _():
        streams = call("GET", "/api/streams", SUP)[1]
        streams = streams.get("streams", streams) if isinstance(streams, dict) else streams
        dock = next(s for s in streams if "gloves" in s.get("required_ppe", []))
        record("CAM-04", "gloves" in (dock.get("unenforced") or []), f"{dock['name']} requires {dock['required_ppe']}; flagged as not checked: {dock.get('unenforced')}")

    @check("LIVE-07")
    def _():
        sid = call("GET", "/api/config", SUP)[1]["config"]["streams"][-1]["id"]
        s1 = call("POST", f"/api/streams/{sid}/stop", SUP)[0]
        time.sleep(2); st = call("GET", f"/api/streams/{sid}", SUP)[1]["status"]
        s2 = call("POST", f"/api/streams/{sid}/start", SUP)[0]
        st2 = st
        for _ in range(20):
            time.sleep(1); st2 = call("GET", f"/api/streams/{sid}", SUP)[1]["status"]
            if st2 == "live":
                break
        record("LIVE-07", s1 == 200 and st == "stopped" and s2 == 200 and st2 == "live", f"stop HTTP {s1} -> {st}; start HTTP {s2} -> {st2}")

    # ------------------------------------------------------------ security
    @check("SEC-01")
    def _():
        u = urlsplit(B); c = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
        c.request("GET", "/..%2f..%2f..%2f..%2f..%2fetc%2fpasswd"); r = c.getresponse(); body = r.read()
        record("SEC-01", b"root:" not in body, f"HTTP {r.status}; returned {'the dashboard page' if b'<!doctype html' in body.lower() else body[:40]!r}")

    @check("SEC-02")
    def _():
        h = call("GET", "/")[2].headers
        ok = "frame-ancestors 'none'" in h.get("content-security-policy", "") and h.get("x-frame-options") == "DENY" and h.get("x-content-type-options") == "nosniff"
        record("SEC-02", ok, f"CSP present: {'content-security-policy' in h}; X-Frame-Options {h.get('x-frame-options')}; nosniff {h.get('x-content-type-options')}")

    @check("SEC-03")
    def _():
        s, b, _ = call("POST", "/api/sources/test", ADM, data={"source": {"type": "http", "uri": "http://127.0.0.1:9/${PPE_JWT_SECRET}", "timeout": 2}}, timeout=60000)
        record("SEC-03", JWT_SECRET not in json.dumps(b), f"HTTP {s}; secret in reply: {JWT_SECRET in json.dumps(b)}")

    @check("SEC-04")
    def _():
        codes = {path: call("GET", path)[0] for path in ("/api/violations", "/api/config", "/api/users", "/api/system/health")}
        record("SEC-04", all(c == 401 for c in codes.values()), f"without sign-in: {codes}")

    @check("SEC-05")
    def _():
        r = call("OPTIONS", "/api/violations", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"})[2]
        acao = r.headers.get("access-control-allow-origin")
        record("SEC-05", acao is None, f"pre-flight from evil.example: HTTP {r.status}, Allow-Origin={acao}")

    # ------------------------------------------------------------ UI: Command
    page.goto(B + "/#/overview"); page.wait_for_timeout(4000)

    @check("CMD-01")
    def _():
        t0 = time.time(); page.goto(B + "/#/overview")
        h = page.locator("h2").first; h.wait_for(timeout=5000); took = time.time() - t0
        text = h.inner_text()
        record("CMD-01", took < 3 and any(k in text for k in ("unsafe", "All clear", "compliant", "No cameras", "connection")), f"status '{text}' shown after {took:.1f} s")

    @check("CMD-04")
    def _():
        missing = [c for c in ("Compliance today", "Review queue", "Incidents today", "Cameras") if page.get_by_text(c, exact=True).count() == 0]
        record("CMD-04", not missing, "all four cards shown" if not missing else f"missing: {missing}")

    @check("CMD-05")
    def _():
        names = [s["name"] for s in call("GET", "/api/config", SUP)[1]["config"]["streams"]]
        fleet = page.get_by_text("Camera fleet").count() > 0
        missing = [n for n in names if page.get_by_text(n).count() == 0]
        record("CMD-05", fleet and not missing, f"Camera fleet shown: {fleet}; cameras missing: {missing or 'none'}")

    @check("CMD-02")
    def _():
        page.wait_for_timeout(6000)
        n = blob_frames(page)
        record("CMD-02", n == 0, f"live video frames on Command after 10 s: {n}")

    @check("CMD-03")
    def _():
        found = False
        for _ in range(45):  # up to ~90 s for someone unsafe to walk past
            if page.get_by_text("Act now", exact=True).count() > 0:
                found = True; break
            page.wait_for_timeout(2000)
        if not found:
            record("CMD-03", False, "nobody unsafe in view during 90 s - rerun manually", blocked=True); return
        page.screenshot(path=str(OUT / "CMD-03-act-now.png"))
        row = page.locator("button", has_text="in view unsafe").first
        label = row.inner_text().replace("\n", " | ")
        row.click(); page.wait_for_timeout(1500)
        record("CMD-03", "monitoring" in page.url and "camera=" in page.url, f"row '{label[:80]}' opened {page.url.split('#')[-1]}")

    @check("CMD-06")
    def _():
        page.goto(B + "/#/overview"); page.wait_for_timeout(2500)
        page.get_by_role("button", name="Start review").first.click(); page.wait_for_timeout(1500)
        record("CMD-06", "incidents" in page.url, f"landed on {page.url.split('#')[-1]}")

    # ------------------------------------------------------------ UI: Live
    @check("LIVE-01")
    def _():
        page.goto(B + "/#/monitoring"); page.wait_for_timeout(7000)
        n = blob_frames(page); cams = len(call("GET", "/api/config", SUP)[1]["config"]["streams"])
        page.screenshot(path=str(OUT / "LIVE-01-wall.png"))
        record("LIVE-01", n >= cams, f"{n} live video tiles rendering for {cams} cameras")

    @check("LIVE-02")
    def _():
        page.fill("input[aria-label='Find a camera']", "Gate"); page.wait_for_timeout(3000)
        n = blob_frames(page)
        page.fill("input[aria-label='Find a camera']", ""); page.wait_for_timeout(500)
        record("LIVE-02", n == 1, f"tiles after searching 'Gate': {n}")

    @check("LIVE-03")
    def _():
        page.get_by_role("radio", name="Board").click(); page.wait_for_timeout(1500)
        names = [s["name"] for s in call("GET", "/api/config", SUP)[1]["config"]["streams"]]
        missing = [n for n in names if page.get_by_text(n).count() == 0]
        page.get_by_role("radio", name="Video wall").click()
        record("LIVE-03", not missing, f"board shows all cameras: {not missing}")

    # ------------------------------------------------------------ Review
    @check("REV-01")
    def _():
        total = 0
        for _ in range(60):
            total = call("GET", "/api/violations", SUP, params={"limit": 1})[1].get("total", 0)
            if total >= 3:
                break
            time.sleep(2)
        record("REV-01", total > 0, f"{total} incidents arrived in the queue from live detection")

    @check("REV-02")
    def _():
        page.goto(B + "/#/incidents"); page.wait_for_timeout(3500)
        ev = page.locator("img[alt^='Evidence for']").count()
        page.get_by_role("radio", name="Person crop").click(); page.wait_for_timeout(2000)
        crop = page.locator("img[alt^='Person crop for']").count()
        page.get_by_role("radio", name="Evidence").click(); page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / "REV-02-evidence.png"))
        record("REV-02", ev > 0 and crop > 0, f"evidence image shown: {ev > 0}; person crop shown: {crop > 0}")

    @check("REV-03")
    def _():
        b = page.get_by_role("button", name="Valid violation").bounding_box()
        vh = page.viewport_size["height"]
        record("REV-03", b is not None and b["y"] + b["height"] <= vh, f"Valid button bottom at {b and round(b['y'] + b['height'])} px of a {vh} px window")

    @check("REV-04")
    def _():
        first = call("GET", "/api/violations", SUP, params={"limit": 1})[1]["items"][0]["id"]
        page.goto(B + f"/#/incidents"); page.wait_for_timeout(3000)
        sel = page.locator("[aria-selected=true], [aria-current=true]").first
        page.keyboard.press("v"); page.wait_for_timeout(2500)
        reviewed = [v for v in call("GET", "/api/violations", SUP, params={"limit": 50})[1]["items"] if v.get("review")]
        ok = any(v["review"]["verdict"] == "valid" for v in reviewed)
        record("REV-04", ok, f"after pressing V: {len(reviewed)} incident(s) confirmed valid (by {reviewed[0]['review']['by'] if reviewed else '-'})")

    @check("REV-05")
    def _():
        items = [v for v in call("GET", "/api/violations", SUP, params={"limit": 50})[1]["items"] if not v.get("review")]
        vid = items[0]["id"]
        s1, b1, _ = call("POST", f"/api/violations/{vid}/review", SUP, data={"verdict": "false_alarm"})
        s2, b2, _ = call("POST", f"/api/violations/{vid}/review", SUP, data={"verdict": "false_alarm", "reason": "ppe_worn"})
        record("REV-05", 400 <= s1 < 500 and s2 == 200, f"false alarm without reason HTTP {s1}; with reason HTTP {s2} (keyboard flow F,1,Enter: manual)")

    @check("REV-07")
    def _():
        items = call("GET", "/api/violations", SUP, params={"limit": 100})[1]["items"]
        sid = items[0]["stream_id"]
        f = call("GET", "/api/violations", SUP, params={"camera": sid, "limit": 100})[1]["items"]
        record("REV-07", f and all(v["stream_id"] == sid for v in f), f"filter camera={sid}: {len(f)} results, all from that camera")

    @check("REV-08")
    def _():
        s, body, r = call("GET", "/api/violations/export", SUP)
        text = body if isinstance(body, str) else ""
        rows = text.strip().splitlines()
        record("REV-08", s == 200 and rows and "camera_name" in rows[0], f"HTTP {s}, {r.headers.get('content-type')}, {max(0, len(rows) - 1)} data rows")

    @check("INS-02")
    def _():
        now = time.time()
        s, b, _ = call("GET", "/api/analytics/summary", SUP, params={"start": now - 86400, "end": now + 60, "tz": 330})
        rv = b.get("review") or {}
        record("INS-02", s == 200 and rv.get("reviewed", 0) >= 2 and rv.get("precision") is not None,
               f"reviewed {rv.get('reviewed')} of {rv.get('total')}; alert precision {rv.get('precision')}")

    @check("INS-03")
    def _():
        now = time.time()
        s, b, _ = call("GET", "/api/analytics/summary", SUP, params={"start": now, "end": now - 3600, "tz": 330})
        record("INS-03", s == 422, f"end before start -> HTTP {s}")

    @check("INS-01")
    def _():
        console_errors.clear()
        page.goto(B + "/#/reports"); page.wait_for_timeout(5000)
        h = page.locator("h1").first.inner_text()
        page.screenshot(path=str(OUT / "INS-01-insights.png"), full_page=True)
        record("INS-01", not console_errors, f"page '{h}'; console errors: {console_errors[:2] or 'none'}")

    @check("REV-09")
    def _():
        vid = call("GET", "/api/violations", SUP, params={"limit": 1})[1]["items"][0]["id"]
        s = call("DELETE", f"/api/violations/{vid}", SUP)[0]
        s2 = call("GET", f"/api/violations/{vid}", SUP)[0]
        aud = call("GET", "/api/audit", SUP, params={"limit": 50})[1]["items"]
        logged = any(a["action"] == "violation.delete" and str(vid) in str(a.get("target")) for a in aud)
        record("REV-09", s == 200 and s2 == 404 and logged, f"delete HTTP {s}; fetch afterwards HTTP {s2}; in audit trail: {logged}")

    # ------------------------------------------------------------ system / audit
    @check("SYS-01")
    def _():
        h = call("GET", "/api/system/health", SUP)[1]
        cams = [(c["name"], c["fps"], round(c["latency_ms"])) for c in h["cameras"]]
        record("SYS-01", bool(h["device"]) and all(c[1] > 0 for c in cams), f"device {h['device']}; per camera (name, fps, latency ms): {cams}")

    @check("SYS-02")
    def _():
        page.goto(B + "/#/system"); page.wait_for_timeout(6000)
        ok = page.get_by_text("Capacity planner").count() > 0 and page.get_by_text("45 cameras").count() > 0
        line = page.locator("li", has_text="45 cameras").first.inner_text() if ok else ""
        page.screenshot(path=str(OUT / "SYS-02-capacity.png"))
        record("SYS-02", ok, f"planner shown: {ok}; '{line}'")

    @check("USR-03")
    def _():
        acts = {a["action"] for a in call("GET", "/api/audit", SUP, params={"limit": 200})[1]["items"]}
        need = {"auth.login", "auth.login_failed", "user.create", "config.update", "violation.review", "violation.delete"}
        missing = need - acts
        record("USR-03", not missing, f"recorded: {sorted(need & acts)}; missing: {sorted(missing) or 'none'}")

    # ------------------------------------------------------------ roles in the UI (Admin session)
    adm_ctx = browser.new_context(viewport={"width": 1600, "height": 950}); ap = adm_ctx.new_page()

    @check("ROLE-01")
    def _():
        ui_login(ap, "uat_admin", ADMIN_PW); ap.goto(B + "/#/system"); ap.wait_for_timeout(2500)
        has_people = ap.get_by_text("People", exact=True).count() > 0
        has_audit = ap.get_by_text("Audit trail", exact=True).count() > 0
        record("ROLE-01", not has_people and not has_audit, f"Admin sees People: {has_people}; Audit trail: {has_audit}")

    @check("ROLE-02")
    def _():
        ap.goto(B + "/#/users"); ap.wait_for_timeout(2000)
        blocked = ap.get_by_text("No access").count() > 0 or ap.get_by_text("don't have access").count() > 0
        record("ROLE-02", blocked, f"#/users as Admin shows the no-access page: {blocked}")

    # ------------------------------------------------------------ session
    @check("AUTH-07")
    def _():
        ap.goto(B + "/#/incidents"); ap.wait_for_timeout(1500); ap.reload(); ap.wait_for_timeout(3000)
        still = ap.locator("input[name=username]").count() == 0 and "incidents" in ap.url
        record("AUTH-07", still, f"after reload still signed in on Review: {still}")

    @check("AUTH-06")
    def _():
        ap.locator("button[aria-haspopup=menu]").first.click(); ap.get_by_role("menuitem", name="Sign out").click()
        ap.wait_for_timeout(2000); ap.goto(B + "/#/overview"); ap.wait_for_timeout(2000)
        out = ap.locator("input[name=username]").count() > 0
        record("AUTH-06", out, f"after sign-out, opening Command shows the sign-in page: {out}")

    # ------------------------------------------------------------ phone width
    @check("UX-01")
    def _():
        mp = browser.new_context(viewport={"width": 390, "height": 844})
        m = mp.new_page(); ui_login(m, "admin", SUPER_PW)
        widths = {}
        for r in ("overview", "incidents"):
            m.goto(B + f"/#/{r}"); m.wait_for_timeout(2500)
            widths[r] = m.evaluate("document.documentElement.scrollWidth")
        m.screenshot(path=str(OUT / "UX-01-phone-review.png"), full_page=False)
        record("UX-01", all(w <= 391 for w in widths.values()), f"page width at 390 px screen: {widths}")

    browser.close()

results.pop("_wrongmsg", None)
(OUT / "results.json").write_text(json.dumps(results, indent=2))
auto = [c for c in CASE.values() if c["auto"]]
missing = [c["id"] for c in auto if c["id"] not in results]
print("\nSUMMARY", {s: sum(r["status"] == s for r in results.values()) for s in ("Pass", "Fail", "Blocked")}, "not run:", missing)
