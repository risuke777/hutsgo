#!/usr/bin/env python3
"""HutsGo static site builder.  python3 build.py  →  dist/"""
import json, os, pathlib, shutil, sqlite3, datetime, sys, urllib.parse
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup, escape

ROOT = pathlib.Path(__file__).parent
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # Windows console (cp932) safety
DIST = ROOT / "dist"
SITE_URL = os.environ.get("SITE_URL", "https://hutsgo.jp").rstrip("/")
# project Pages live under a sub-path (https://user.github.io/repo). Every internal link is prefixed with BASE.
BASE = urllib.parse.urlsplit(SITE_URL).path.rstrip("/")
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
TOILET_LABEL = {"flush": "水洗", "vault": "汲み取り", "composting": "バイオ", "portable": "カートリッジ式", "none": "なし"}
WATER_LABEL = {"free": "無料", "paid": "有料", "none": "なし"}
CARRIER_LABEL = {"docomo": "docomo", "au": "au", "softbank": "SoftBank", "rakuten": "楽天", "starlink": "Starlink"}
QUALITY_LABEL = {"good": "○", "spotty": "△", "none": "×"}

areas = {a["id"]: a for a in rows("SELECT * FROM sub_areas")}
operators = {o["id"]: o for o in rows("SELECT * FROM operators")}
trailheads = {t["id"]: t for t in rows("SELECT * FROM trailheads")}


def conf_text(row):
    """'公式サイトで確認（2026-09-13）' style sentence for a fact-bearing row."""
    if not row:
        return "未確認"
    c = row.get("confidence", "unknown")
    d = row.get("last_verified_at")
    if c == "verified":
        return f"公式サイトで確認（{d}）" if d else "公式サイトで確認"
    if c == "reported":
        return f"二次情報（{d}時点）" if d else "二次情報"
    return "未確認"


def fac_chips(f):
    """Short facility facts a hiker scans in one glance. Only what is actually known."""
    if not f or f.get("confidence") == "unknown":
        return []
    out = []
    if f.get("toilet_type"):
        s = "トイレ " + TOILET_LABEL[f["toilet_type"]]
        if f.get("toilet_fee_jpy"):
            s += f"・{f['toilet_fee_jpy']}円"
        out.append(s)
    elif f.get("toilet_fee_jpy"):
        out.append(f"トイレ {f['toilet_fee_jpy']}円")
    if f.get("water_available"):
        out.append("水 " + WATER_LABEL[f["water_available"]])
    if f.get("charging_service") == 1:
        out.append("充電 可" + (f"（{f['charging_fee_jpy']}円〜）" if f.get("charging_fee_jpy") else ""))
    elif f.get("charging_service") == 0:
        out.append("充電 不可")
    elif f.get("power_outlet"):
        out.append("コンセントあり")
    if f.get("credit_card") == 1:
        out.append("カード可")
    if f.get("qr_payment") == 1:
        out.append("QR決済可")
    if f.get("cash_only") == 1:
        out.append("現金のみ")
    if f.get("bath"):
        out.append("風呂あり")
    if f.get("drying_room"):
        out.append("乾燥室")
    return out


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
    h["fac_chips"] = fac_chips(h["fac"])
    h["signal"] = rows("SELECT * FROM hut_mobile_signal WHERE hut_id=?", hid)
    for sg in h["signal"]:
        sg["carrier_label"] = CARRIER_LABEL[sg["carrier"]]
        sg["quality_label"] = QUALITY_LABEL.get(sg["quality"], "未確認")
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
    # the one link a hiker actually needs: official reservation page, else official site
    h["book_url"] = (h["season"] or {}).get("reservation_url") or h["official_url"]
    huts[hid] = h


# ---------------------------------------------------------------- trails + elevation profile
def fmt_time(m):
    if m is None:
        return ""
    return f"{m // 60}時間{m % 60:02d}分" if m % 60 else f"{m // 60}時間"

def fmt_time_short(m):
    return f"{m // 60}h{m % 60:02d}" if m % 60 else f"{m // 60}h"

def fmt_date(d):
    if not d:
        return ""
    y, m, dd = d.split("-")
    return f"{int(m)}月{int(dd)}日"

def yen(v):
    return f"¥{v:,}"

def metres(v):
    return f"{v:,}m" if v is not None else "標高未確認"


def build_points(t):
    """One point per trail_stop. Unknown hut elevations are interpolated (flagged est=True)
    so the marker sits on the line, but they are drawn hollow and labelled 未確認."""
    pts = []
    for s in t["stops"]:
        if s["hut"]:
            p = dict(kind="hut", name=s["hut"]["name_ja"], elev=s["hut"]["elevation_m"],
                     src=s["hut"]["elevation_source"], hut=s["hut"])
        elif s["trailhead"]:
            p = dict(kind="trailhead", name=s["trailhead"]["name_ja"], elev=s["trailhead"]["elevation_m"], src="official")
        else:
            p = dict(kind="peak", name=s["label"], elev=s["elevation_m"], src="gsi")
        p.update(seq=s["seq"], t=s["cumulative_time_min"] or 0, overnight=bool(s["is_overnight_candidate"]))
        pts.append(p)
    known = [i for i, p in enumerate(pts) if p["elev"] is not None]
    for i, p in enumerate(pts):
        if p["elev"] is not None:
            p["y"], p["est"] = p["elev"], False
            continue
        p["est"] = True
        prev = max((k for k in known if k < i), default=None)
        nxt = min((k for k in known if k > i), default=None)
        if prev is None and nxt is None:
            p["y"] = None
        elif prev is None:
            p["y"] = pts[nxt]["elev"]
        elif nxt is None:
            p["y"] = pts[prev]["elev"]
        else:
            a, b = pts[prev], pts[nxt]
            f = (p["t"] - a["t"]) / (b["t"] - a["t"]) if b["t"] != a["t"] else 0
            p["y"] = round(a["elev"] + (b["elev"] - a["elev"]) * f)
    return pts


def summarize(pts):
    known = [p for p in pts if p["elev"] is not None]
    if not known:
        return None
    top = max(known, key=lambda p: p["elev"])
    gain = 0
    for a, b in zip(known, known[1:]):
        if b["elev"] > a["elev"]:
            gain += b["elev"] - a["elev"]
    start = next((p for p in pts if p["kind"] == "trailhead" and p["elev"] is not None), known[0])
    return dict(top=top, gain=gain, start=start, climb=top["elev"] - start["elev"],
                unverified=[p["name"] for p in pts if p["kind"] == "hut" and p["est"]])


def build_legs(t, pts):
    """Rows for the timeline: stop cards with the leg (time / up / down / via-peaks) between them."""
    rowsout = []
    anchors = [p for p in pts if p["kind"] != "peak"]
    for i, p in enumerate(anchors):
        rowsout.append(dict(row="stop", p=p, stop=next(s for s in t["stops"] if s["seq"] == p["seq"])))
        if i + 1 < len(anchors):
            q = anchors[i + 1]
            seg = [x for x in pts if p["seq"] <= x["seq"] <= q["seq"]]
            up = down = 0
            est = any(x["elev"] is None for x in seg)
            ys = [x["y"] for x in seg if x["y"] is not None]
            for a, b in zip(ys, ys[1:]):
                if b > a:
                    up += b - a
                else:
                    down += a - b
            vias = [x for x in seg if x["kind"] == "peak"]
            rowsout.append(dict(row="leg", minutes=q["t"] - p["t"], up=up, down=down, est=est, vias=vias))
    return rowsout


def _label_w(text, fs):
    w = 0
    for ch in text:
        w += fs * (0.58 if ch.isascii() else 1.0)
    return w


def profile_svg(t, pts, width, height, compact=False):
    """Inline SVG elevation profile. x = cumulative course time, y = elevation. No JS."""
    pts = [p for p in pts if p["y"] is not None]
    if len(pts) < 2:
        return ""
    fs = 10.5 if compact else 12
    fs_small = 9.5 if compact else 10.5
    tier_h = fs + 3
    # --- labels: which points get one, and collision tiers
    labels = []
    for p in pts:
        if p["kind"] == "peak":
            txt = p["name"] if compact else f"{p['name']} {p['elev']:,}m"
            size = fs_small
        elif p["kind"] == "trailhead":
            txt = p["name"].replace("登山口", "") if compact else f"{p['name']} {p['elev']:,}m"
            size = fs_small
        else:
            if p["est"]:
                txt = f"{p['name']} 未確認" if compact else f"{p['name']} 標高未確認"
            else:
                txt = f"{p['name']} {p['elev']:,}m"
            size = fs
        labels.append(dict(p=p, text=txt, size=size, w=_label_w(txt, size)))
    ml, mr, mb = (40 if compact else 52), 14, (20 if compact else 24)
    xmax = max(p["t"] for p in pts) or 1
    inner_w = width - ml - mr
    def X(tm):
        return ml + inner_w * tm / xmax
    # greedy tiers, left to right, keep a label in the lowest tier where it does not overlap
    order = sorted(labels, key=lambda l: l["p"]["t"])
    tiers = []  # list of lists of (x0, x1)
    for l in order:
        cx = X(l["p"]["t"])
        x0, x1 = cx - l["w"] / 2, cx + l["w"] / 2
        # clamp inside the drawing so edge labels do not get cut
        if x0 < 2:
            x1 += 2 - x0; x0 = 2
        if x1 > width - 2:
            x0 -= x1 - (width - 2); x1 = width - 2
        l["x0"], l["x1"] = x0, x1
        for ti, tier in enumerate(tiers):
            if all(x1 < a - 6 or x0 > b + 6 for a, b in tier):
                tier.append((x0, x1)); l["tier"] = ti; break
        else:
            tiers.append([(x0, x1)]); l["tier"] = len(tiers) - 1
    ntier = len(tiers)
    mt = 10 + ntier * tier_h + 6
    inner_h = height - mt - mb
    ys = [p["y"] for p in pts]
    ymin = (min(ys) - 120) // 100 * 100
    ymax = -((-(max(ys) + 100)) // 100) * 100
    def Y(e):
        return mt + inner_h * (1 - (e - ymin) / (ymax - ymin))
    out = []
    out.append(f'<svg class="profile-svg {"profile-svg--narrow" if compact else "profile-svg--wide"}" viewBox="0 0 {width} {height}" '
               f'preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="ptitle-{t["id"]}-{"n" if compact else "w"}" xmlns="http://www.w3.org/2000/svg">')
    out.append(f'<title id="ptitle-{t["id"]}-{"n" if compact else "w"}">{escape(t["name_ja"])}の標高断面図。横軸は累積コースタイム、縦軸は標高。</title>')
    # grid
    step = 500
    g0 = -((-ymin) // step) * step
    e = g0
    while e <= ymax:
        y = Y(e)
        out.append(f'<line class="p-grid" x1="{ml}" x2="{width - mr}" y1="{y:.1f}" y2="{y:.1f}"/>')
        out.append(f'<text class="p-axis" x="{ml - 6}" y="{y + 3.5:.1f}" text-anchor="end" font-size="{fs_small}">{e:,}</text>')
        e += step
    xstep = 180 if compact else 120
    tm = 0
    while tm <= xmax:
        x = X(tm)
        out.append(f'<line class="p-tick" x1="{x:.1f}" x2="{x:.1f}" y1="{height - mb}" y2="{height - mb + 4}"/>')
        lab = f"{tm // 60}h" if compact else (f"{tm // 60}時間" if tm else "出発")
        anchor = "start" if tm == 0 else "middle"
        out.append(f'<text class="p-axis" x="{x:.1f}" y="{height - mb + 14}" text-anchor="{anchor}" font-size="{fs_small}">{lab}</text>')
        tm += xstep
    out.append(f'<text class="p-axis" x="{ml - 6}" y="{mt - 4}" text-anchor="end" font-size="{fs_small}">m</text>')
    # area + line
    d = " ".join(f"{X(p['t']):.1f},{Y(p['y']):.1f}" for p in pts)
    base = height - mb
    out.append(f'<polygon class="p-area" points="{X(pts[0]["t"]):.1f},{base} {d} {X(pts[-1]["t"]):.1f},{base}"/>')
    out.append(f'<polyline class="p-line" points="{d}"/>')
    # markers + labels (drawn last so they sit on top)
    for l in order:
        p = l["p"]
        x, y = X(p["t"]), Y(p["y"])
        ly = mt - 6 - l["tier"] * tier_h
        cls = {"hut": "pm pm-hut", "trailhead": "pm pm-th", "peak": "pm pm-peak"}[p["kind"]]
        if p["kind"] == "hut" and p["est"]:
            cls += " pm-est"
        if p["kind"] == "hut" and not p["overnight"]:
            cls += " pm-pass"
        title = f"{p['name']}　{metres(p['elev'])}　出発から{fmt_time(p['t'])}"
        if p["kind"] == "hut":
            title += "　宿泊候補" if p["overnight"] else ""
            title += "（標高は前後の地点から按分した仮の位置）" if p["est"] else ""
        elif p["kind"] == "trailhead":
            title += "　登山口"
        else:
            title += "　通過点"
        href = f'href="#stop-{p["seq"]}"'
        out.append(f'<a class="{cls}" {href} data-seq="{p["seq"]}"><title>{escape(title)}</title>')
        # invisible hit areas: a generous circle around the marker and a box behind the label (thumb-sized on phones)
        out.append(f'<circle class="p-hit" cx="{x:.1f}" cy="{y:.1f}" r="16"/>')
        out.append(f'<rect class="p-hit" x="{l["x0"] - 4:.1f}" y="{ly - l["size"] - 2:.1f}" width="{l["x1"] - l["x0"] + 8:.1f}" height="{l["size"] + 6:.1f}"/>')
        # leader from label to marker
        out.append(f'<line class="p-leader" x1="{x:.1f}" x2="{x:.1f}" y1="{ly + 2:.1f}" y2="{y - 6:.1f}"/>')
        if p["kind"] == "hut":
            out.append(f'<circle class="p-dot" cx="{x:.1f}" cy="{y:.1f}" r="{5.5 if not compact else 5}"/>')
        elif p["kind"] == "trailhead":
            s = 9 if not compact else 8
            out.append(f'<rect class="p-sq" x="{x - s / 2:.1f}" y="{y - s / 2:.1f}" width="{s}" height="{s}"/>')
        else:
            s = 5
            out.append(f'<polygon class="p-tri" points="{x:.1f},{y - s:.1f} {x + s:.1f},{y + s * 0.7:.1f} {x - s:.1f},{y + s * 0.7:.1f}"/>')
        # label; anchor depends on clamping
        anchor, tx = "middle", (l["x0"] + l["x1"]) / 2
        out.append(f'<text class="p-label{" p-label-peak" if p["kind"] != "hut" else ""}" x="{tx:.1f}" y="{ly:.1f}" text-anchor="{anchor}" font-size="{l["size"]}">{escape(l["text"])}</text>')
        out.append('</a>')
    out.append('</svg>')
    return Markup("".join(out))


def profile_mini_svg(t, pts, width=640, height=96):
    """Label-free silhouette for route cards on the home page."""
    pts = [p for p in pts if p["y"] is not None]
    if len(pts) < 2:
        return ""
    xmax = max(p["t"] for p in pts) or 1
    ys = [p["y"] for p in pts]
    ymin, ymax = min(ys) - 150, max(ys) + 120
    pad = 8
    X = lambda tm: pad + (width - 2 * pad) * tm / xmax
    Y = lambda e: pad + (height - 2 * pad) * (1 - (e - ymin) / (ymax - ymin))
    d = " ".join(f"{X(p['t']):.1f},{Y(p['y']):.1f}" for p in pts)
    out = [f'<svg class="mini-profile" viewBox="0 0 {width} {height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">']
    out.append(f'<polygon class="p-area" points="{X(pts[0]["t"]):.1f},{height} {d} {X(pts[-1]["t"]):.1f},{height}"/>')
    out.append(f'<polyline class="p-line" points="{d}"/>')
    for p in pts:
        x, y = X(p["t"]), Y(p["y"])
        if p["kind"] == "hut" and p["overnight"]:
            out.append(f'<circle class="p-dot{" pm-est" if p["est"] else ""}" cx="{x:.1f}" cy="{y:.1f}" r="4.5"/>')
        elif p["kind"] == "trailhead":
            out.append(f'<rect class="p-sq" x="{x - 4:.1f}" y="{y - 4:.1f}" width="8" height="8"/>')
    out.append('</svg>')
    return Markup("".join(out))


trails = []
for t in rows("SELECT * FROM trails"):
    t["stops"] = rows("SELECT * FROM trail_stops WHERE trail_id=? ORDER BY seq", t["id"])
    for s in t["stops"]:
        s["hut"] = huts.get(s["hut_id"])
        s["trailhead"] = trailheads.get(s["trailhead_id"])
        if s["hut"]:
            s["hut"]["trails"].append(t)
    t["total_min"] = max(s["cumulative_time_min"] or 0 for s in t["stops"])
    t["hut_count"] = sum(1 for s in t["stops"] if s["hut"] and s["is_overnight_candidate"])
    t["points"] = build_points(t)
    t["profile"] = summarize(t["points"])
    t["rows"] = build_legs(t, t["points"])
    t["svg_wide"] = profile_svg(t, t["points"], 720, 300)
    t["svg_narrow"] = profile_svg(t, t["points"], 360, 250, compact=True)
    t["svg_mini"] = profile_mini_svg(t, t["points"])
    trails.append(t)

# compact JSON for the client-side filter
client = [{
    "id": h["id"], "name": h["name_ja"], "type": h["type_label"],
    "area": h["area"]["name_ja"] if h["area"] else "", "area_id": h["sub_area_id"],
    "elev": h["elevation_m"],
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
env = Environment(loader=FileSystemLoader(ROOT / "templates", encoding="utf-8"),
                  autoescape=select_autoescape(["html"]))
env.filters.update(fmt_time=fmt_time, fmt_time_short=fmt_time_short, fmt_date=fmt_date, yen=yen, metres=metres,
                   conf_text=conf_text)
env.globals.update(SITE_URL=SITE_URL, BASE=BASE, ANALYTICS=ANALYTICS, TODAY=TODAY,
                   CONF_LABEL=CONF_LABEL, TOILET_LABEL=TOILET_LABEL, WATER_LABEL=WATER_LABEL,
                   areas=list(areas.values()))

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
(DIST / "data").mkdir()
(DIST / "data" / "huts.json").write_text(json.dumps(client, ensure_ascii=False, indent=1), encoding="utf-8")

print(f"built {len(urls)} pages → {DIST}")
