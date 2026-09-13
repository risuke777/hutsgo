#!/usr/bin/env python3
"""HutsGo static site builder.  python3 build.py  →  dist/"""
import json, os, pathlib, shutil, sqlite3, datetime, sys
from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = pathlib.Path(__file__).parent
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # Windows console (cp932) safety
DIST = ROOT / "dist"
SITE_URL = os.environ.get("SITE_URL", "https://hutsgo.jp").rstrip("/")
ANALYTICS = os.environ.get("ANALYTICS_SNIPPET", "")
TODAY = datetime.date.today().isoformat()

# ---------------------------------------------------------------- data
db = ROOT / "hutsgo.db"
if db.exists():
    db.unlink()
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
for f in ("schema.sql", "seed.sql"):
    con.executescript((ROOT / f).read_text(encoding="utf-8"))

def rows(sql, *a):
    return [dict(r) for r in con.execute(sql, a)]

PLAN_LABEL = {"two_meals": "1泊2食", "one_meal": "1泊1食", "no_meal": "素泊まり",
              "tent": "テント", "private_room": "個室", "day_use": "休憩"}
TYPE_LABEL = {"mountain_hut": "山小屋", "emergency_hut": "避難小屋", "campsite": "キャンプ場",
              "lodge": "ロッジ", "hotel": "ホテル", "onsen": "温泉宿"}
MODE_LABEL = {"bus": "バス", "train": "電車", "taxi": "タクシー", "car": "自家用車",
              "shuttle": "シャトル", "ropeway": "ロープウェイ", "ferry": "船"}
CONF_LABEL = {"verified": "公式確認済み", "reported": "二次情報", "unknown": "未確認"}

areas = {a["id"]: a for a in rows("SELECT * FROM sub_areas")}
operators = {o["id"]: o for o in rows("SELECT * FROM operators")}
trailheads = {t["id"]: t for t in rows("SELECT * FROM trailheads")}

huts = {}
for h in rows("SELECT * FROM huts ORDER BY name_ja"):
    hid = h["id"]
    h["type_label"] = TYPE_LABEL[h["hut_type"]]
    h["area"] = areas.get(h["sub_area_id"])
    h["operator"] = operators.get(h["operator_id"])
    h["season"] = next(iter(rows(
        "SELECT * FROM hut_seasons WHERE hut_id=? AND year=2026", hid)), None)
    h["rates"] = rows("SELECT * FROM hut_rates WHERE hut_id=? AND year=2026 "
                      "ORDER BY CASE plan_type WHEN 'two_meals' THEN 0 WHEN 'one_meal' THEN 1 "
                      "WHEN 'no_meal' THEN 2 WHEN 'private_room' THEN 3 WHEN 'tent' THEN 4 ELSE 5 END", hid)
    for r in h["rates"]:
        r["label"] = PLAN_LABEL[r["plan_type"]]
    h["price_two"] = next((r for r in h["rates"] if r["plan_type"] == "two_meals"), None)
    h["price_none"] = next((r for r in h["rates"] if r["plan_type"] == "no_meal"), None)
    h["price_tent"] = next((r for r in h["rates"] if r["plan_type"] == "tent"), None)
    h["fac"] = next(iter(rows("SELECT * FROM hut_facilities WHERE hut_id=?", hid)), {})
    h["signal"] = rows("SELECT * FROM hut_mobile_signal WHERE hut_id=?", hid)
    h["reviews"] = rows("SELECT * FROM reviews WHERE hut_id=? ORDER BY stayed_on DESC", hid)
    h["access"] = []
    for ht in rows("SELECT * FROM hut_trailheads WHERE hut_id=?", hid):
        th = dict(trailheads[ht["trailhead_id"]])
        th["walk_up"] = ht["walk_time_up_min"]
        th["routes"] = rows("SELECT * FROM access_routes WHERE trailhead_id=?", th["id"])
        for r in th["routes"]:
            r["mode_label"] = MODE_LABEL[r["mode"]]
        h["access"].append(th)
    h["trails"] = []
    huts[hid] = h

trails = []
for t in rows("SELECT * FROM trails"):
    t["stops"] = rows("SELECT * FROM trail_stops WHERE trail_id=? ORDER BY seq", t["id"])
    for s in t["stops"]:
        s["hut"] = huts.get(s["hut_id"])
        s["trailhead"] = trailheads.get(s["trailhead_id"])
        if s["hut"]:
            s["hut"]["trails"].append(t)
    t["total_min"] = t["stops"][-1]["cumulative_time_min"]
    t["hut_count"] = sum(1 for s in t["stops"] if s["hut"])
    trails.append(t)

# compact JSON for the client-side filter
client = [{
    "id": h["id"], "name": h["name_ja"], "type": h["type_label"],
    "area": h["area"]["name_ja"] if h["area"] else "", "area_id": h["sub_area_id"],
    "status": h["season"]["status"] if h["season"] else None,
    "open": h["season"]["open_date"] if h["season"] else None,
    "close": h["season"]["close_date"] if h["season"] else None,
    "two": h["price_two"]["price_jpy"] if h["price_two"] else None,
    "none": h["price_none"]["price_jpy"] if h["price_none"] else None,
    "tent": h["price_tent"]["price_jpy"] if h["price_tent"] else None,
    "tents": h["season"]["capacity_tents"] if h["season"] else None,
    "conf": h["season"]["confidence"] if h["season"] else "unknown",
} for h in huts.values()]

# ---------------------------------------------------------------- render
def fmt_time(m):
    return f"{m // 60}時間{m % 60:02d}分" if m % 60 else f"{m // 60}時間"

def fmt_date(d):
    if not d:
        return ""
    y, m, dd = d.split("-")
    return f"{int(m)}月{int(dd)}日"

def yen(v):
    return f"¥{v:,}"

env = Environment(loader=FileSystemLoader(ROOT / "templates", encoding="utf-8"),
                  autoescape=select_autoescape(["html"]))
env.filters.update(fmt_time=fmt_time, fmt_date=fmt_date, yen=yen)
env.globals.update(SITE_URL=SITE_URL, ANALYTICS=ANALYTICS, TODAY=TODAY,
                   CONF_LABEL=CONF_LABEL, areas=list(areas.values()))

DIST.mkdir(exist_ok=True)
for p in DIST.iterdir():
    shutil.rmtree(p) if p.is_dir() else p.unlink()
shutil.copytree(ROOT / "static", DIST / "static")

def write(path, tpl, **ctx):
    out = DIST / path
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(env.get_template(tpl).render(**ctx), encoding="utf-8")

write("index.html", "index.html", trails=trails, huts=list(huts.values()))
write("huts/index.html", "huts.html", huts=list(huts.values()), client_json=json.dumps(client, ensure_ascii=False))
write("about/index.html", "about.html", huts=list(huts.values()))
for h in huts.values():
    write(f"huts/{h['id']}/index.html", "hut.html", h=h)
for t in trails:
    write(f"trails/{t['id']}/index.html", "trail.html", t=t)

urls = ["/", "/huts/", "/about/"] + [f"/huts/{h}/" for h in huts] + [f"/trails/{t['id']}/" for t in trails]
(DIST / "sitemap.xml").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + "".join(f"  <url><loc>{SITE_URL}{u}</loc><lastmod>{TODAY}</lastmod></url>\n" for u in urls)
    + "</urlset>\n", encoding="utf-8")
(DIST / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {SITE_URL}/sitemap.xml\n", encoding="utf-8")
(DIST / "data" ).mkdir()
(DIST / "data" / "huts.json").write_text(json.dumps(client, ensure_ascii=False, indent=1), encoding="utf-8")

print(f"built {len(urls)} pages → {DIST}")
