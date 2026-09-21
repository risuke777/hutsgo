#!/usr/bin/env python3
"""HutsGo static site builder.  python3 build.py  →  dist/

日本語版を / に、英語版を /en/ に出す。データは同じ SQLite から両方を生成する。
英語版の狙いは訪日ハイカー: 電話が使えず、受付開始を逃すと泊まれない層。
"""
import json, os, pathlib, shutil, sqlite3, datetime, sys, urllib.parse
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup, escape
import markdown

import i18n

ROOT = pathlib.Path(__file__).parent
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # Windows console (cp932) safety
DIST = ROOT / "dist"
SITE_URL = os.environ.get("SITE_URL", "https://hutsgo.jp").rstrip("/")
# project Pages live under a sub-path (https://user.github.io/repo). Every internal link is prefixed with BASE.
BASE = urllib.parse.urlsplit(SITE_URL).path.rstrip("/")
# custom domain (anything that is not *.github.io) → GitHub Pages wants a CNAME file in the published tree
SITE_HOST = urllib.parse.urlsplit(SITE_URL).hostname or ""
CNAME = SITE_HOST if SITE_HOST and not SITE_HOST.endswith("github.io") and SITE_HOST != "localhost" else None
ANALYTICS = os.environ.get("ANALYTICS_SNIPPET", "")
API_URL = os.environ.get("API_URL", "").rstrip("/")   # XServer 上の計測/投稿 API。空なら計測も投稿フォームも無効
TODAY = datetime.date.today().isoformat()

LOCALES = [("ja", ""), ("en", "/en")]   # (言語, URL 接頭辞)

# 口コミから出していいリンク先。自社サイトと、その小屋自身の公式サイトだけ。
# 承認制でもリンクを自由にすると投稿がスパムの的になる。出口を塞いでおけば的にならない。
REVIEW_LINK_HOSTS = {"emospot.com", "www.emospot.com", SITE_HOST} - {""}

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


# ---------------------------------------------------------------- locale helpers
def disp(row, lang, short=False, with_ja=True):
    """表示名。英語版は 'Enzanso (燕山荘)' の形で日本語を残す。
    現地で小屋の人・バス運転手・道標に対して指させる必要があるため。
    ルート名・運営会社・山域名は誰かに見せるものではないので with_ja=False（英語のみ）。
    断面図のラベルは幅が足りないので short=True で英語のみ。"""
    ja = row.get("name_ja") or row.get("label") or ""
    en = row.get("name_en") or row.get("label_en") or ""
    if lang == "ja" or not en:
        return ja or en
    return en if (short or not with_ja) else f"{en} ({ja})"


def pick(row, field, lang):
    """lang='en' なら <field>_en を優先し、無ければ日本語のまま返す。"""
    if lang == "en":
        v = row.get(field + "_en")
        if v:
            return v
    return row.get(field)


def make_fmt(lang):
    def fmt_time(m):
        if m is None:
            return ""
        h, mm = m // 60, m % 60
        if lang == "ja":
            return f"{h}時間{mm:02d}分" if mm else f"{h}時間"
        return f"{h}h{mm:02d}" if mm else f"{h}h"

    def fmt_date(d):
        if not d:
            return ""
        y, m, dd = (int(x) for x in d.split("-"))
        if lang == "ja":
            return f"{m}月{dd}日"
        return f"{dd} {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]}"

    return fmt_time, fmt_date


def yen(v):
    return f"¥{v:,}"


def metres(v):
    return f"{v:,}m" if v is not None else None


# ---------------------------------------------------------------- per-locale model
def build_model(lang):
    T = i18n.table(lang)
    fmt_time, fmt_date = make_fmt(lang)

    def metres_t(v):
        return f"{v:,}m" if v is not None else T.elev_unknown

    def conf_text(row):
        if not row:
            return T.conf_unknown
        c, d = row.get("confidence", "unknown"), row.get("last_verified_at")
        if c == "verified":
            return T.conf_verified.format(d=d) if d else T.conf_verified.split("（")[0].split(" (")[0]
        if c == "reported":
            return T.conf_reported.format(d=d) if d else T.conf_unknown
        return T.conf_unknown

    def fac_chips(f):
        """一目で読める設備。分かっているものだけ出す。"""
        if not f or f.get("confidence") == "unknown":
            return []
        out = []
        if f.get("toilet_type"):
            s = T.chip_toilet.format(v=T["toilet_" + f["toilet_type"]])
            if f.get("toilet_fee_jpy"):
                s += f"・{f['toilet_fee_jpy']}円" if lang == "ja" else f" (¥{f['toilet_fee_jpy']})"
            out.append(s)
        elif f.get("toilet_fee_jpy"):
            out.append(T.chip_toilet_fee.format(n=f["toilet_fee_jpy"]))
        if f.get("water_available"):
            out.append(T.chip_water.format(v=T["water_" + f["water_available"]]))
        if f.get("charging_service") == 1:
            out.append(T.chip_charge_fee.format(n=f["charging_fee_jpy"]) if f.get("charging_fee_jpy") else T.chip_charge_ok)
        elif f.get("charging_service") == 0:
            out.append(T.chip_charge_no)
        elif f.get("power_outlet"):
            out.append(T.f_outlet)
        if f.get("credit_card") == 1:
            out.append(T.f_card)
        if f.get("qr_payment") == 1:
            out.append(T.f_qr)
        if f.get("cash_only") == 1:
            out.append(T.f_cash_only)
        if f.get("bath"):
            out.append(T.f_bath + ("あり" if lang == "ja" else ""))
        if f.get("drying_room"):
            out.append(T.f_drying)
        return out

    areas = {a["id"]: dict(a, name=disp(a, lang, with_ja=False)) for a in rows("SELECT * FROM sub_areas")}
    operators = {o["id"]: dict(o, name=disp(o, lang, with_ja=False)) for o in rows("SELECT * FROM operators")}
    trailheads = {}
    for t in rows("SELECT * FROM trailheads"):
        t["name"] = disp(t, lang)
        t["short"] = disp(t, lang, short=True)
        t["parking"] = pick(t, "parking_note", lang)
        trailheads[t["id"]] = t
    photos = []
    for p in rows("SELECT * FROM photos ORDER BY sort, id"):
        p["alt_t"] = pick(p, "alt", lang)
        p["caption_t"] = pick(p, "caption", lang)
        # DB には撮影者名だけを持ち、「撮影：」/「Photo:」は言語側で付ける
        who = (p["credit"] or "").replace("撮影：", "").strip()
        p["credit_t"] = T.photo_credit.format(who=who) if who else ""

        photos.append(p)

    huts = {}
    for h in rows("SELECT * FROM huts ORDER BY name_ja"):
        hid = h["id"]
        h["name"] = disp(h, lang)
        h["short"] = disp(h, lang, short=True)
        h["type_label"] = T["type_" + h["hut_type"]]
        h["area"] = areas.get(h["sub_area_id"])
        h["operator"] = operators.get(h["operator_id"])
        s = next(iter(rows("SELECT * FROM hut_seasons WHERE hut_id=? AND year=2026", hid)), None)
        if s:
            s["note"] = pick(s, "season_note", lang)
            s["opens"] = pick(s, "booking_opens_at", lang)
        h["season"] = s
        h["rates"] = rows("SELECT * FROM hut_rates WHERE hut_id=? AND year=2026 "
                          "ORDER BY CASE plan_type WHEN 'two_meals' THEN 0 WHEN 'one_meal' THEN 1 "
                          "WHEN 'no_meal' THEN 2 WHEN 'private_room' THEN 3 WHEN 'tent' THEN 4 ELSE 5 END", hid)
        for r in h["rates"]:
            r["label"] = T["plan_" + r["plan_type"]]
        h["price_two"] = next((r for r in h["rates"] if r["plan_type"] == "two_meals"), None)
        h["price_none"] = next((r for r in h["rates"] if r["plan_type"] == "no_meal"), None)
        h["price_tent"] = next((r for r in h["rates"] if r["plan_type"] == "tent"), None)
        h["fac"] = next(iter(rows("SELECT * FROM hut_facilities WHERE hut_id=?", hid)), {})
        h["fac_chips"] = fac_chips(h["fac"])
        h["signal"] = rows("SELECT * FROM hut_mobile_signal WHERE hut_id=?", hid)
        for sg in h["signal"]:
            sg["carrier_label"] = {"docomo": "docomo", "au": "au", "softbank": "SoftBank",
                                   "rakuten": "Rakuten", "starlink": "Starlink"}[sg["carrier"]]
            sg["quality_label"] = {"good": "○", "spotty": "△", "none": "×"}.get(sg["quality"], T.unknown)
        h["reviews"] = rows("SELECT * FROM reviews WHERE hut_id=? ORDER BY stayed_on DESC", hid)
        for r in h["reviews"]:
            r["link_label_t"] = pick(r, "link_label", lang)
            if r.get("link_url"):
                host = urllib.parse.urlsplit(r["link_url"]).hostname or ""
                allowed = REVIEW_LINK_HOSTS | {urllib.parse.urlsplit(h["official_url"] or "").hostname or ""}
                if not r["link_url"].startswith("https://") or host not in allowed:
                    sys.exit(f"review {r['id']}: リンク先 {r['link_url']} は許可されていない"
                             f"（小屋の公式サイトか {', '.join(sorted(REVIEW_LINK_HOSTS))} のみ）")
        h["access"] = []
        for ht in rows("SELECT * FROM hut_trailheads WHERE hut_id=?", hid):
            th = dict(trailheads[ht["trailhead_id"]])
            th["walk_up"] = ht["walk_time_up_min"]
            th["routes"] = rows("SELECT * FROM access_routes WHERE trailhead_id=?", th["id"])
            for r in th["routes"]:
                r["mode_label"] = T["mode_" + r["mode"]]
                r["operator"] = pick(r, "operator_name", lang)
                r["origin"] = pick(r, "from_place", lang)
            h["access"].append(th)
        h["trails"] = []
        h["photos"] = [p for p in photos if p["hut_id"] == hid]
        # the one link a hiker actually needs: official reservation page, else official site
        h["book_url"] = (h["season"] or {}).get("reservation_url") or h["official_url"]
        huts[hid] = h

    # ------------------------------------------------------------ profile
    def build_points(t):
        """One point per trail_stop. Unknown hut elevations are interpolated (est=True)
        so the marker sits on the line, but they are drawn hollow and labelled as unconfirmed."""
        pts = []
        for s in t["stops"]:
            if s["hut"]:
                p = dict(kind="hut", name=s["hut"]["name"], short=s["hut"]["short"],
                         elev=s["hut"]["elevation_m"], src=s["hut"]["elevation_source"], hut=s["hut"])
            elif s["trailhead"]:
                p = dict(kind="trailhead", name=s["trailhead"]["name"], short=s["trailhead"]["short"],
                         elev=s["trailhead"]["elevation_m"], src="official")
            else:
                p = dict(kind="peak", name=disp(s, lang), short=disp(s, lang, short=True),
                         elev=s["elevation_m"], src="gsi")
            p.update(seq=s["seq"], t=s["cumulative_time_min"] or 0,
                     overnight=bool(s["is_overnight_candidate"]))
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
        gain = sum(b["elev"] - a["elev"] for a, b in zip(known, known[1:]) if b["elev"] > a["elev"])
        start = next((p for p in pts if p["kind"] == "trailhead" and p["elev"] is not None), known[0])
        return dict(top=top, gain=gain, start=start, climb=top["elev"] - start["elev"],
                    unverified=[p["short"] for p in pts if p["kind"] == "hut" and p["est"]])

    def build_legs(t, pts):
        """Timeline rows: stop cards, with the leg (time / up / down / peaks passed) between them."""
        out = []
        anchors = [p for p in pts if p["kind"] != "peak"]
        for i, p in enumerate(anchors):
            out.append(dict(row="stop", p=p, stop=next(s for s in t["stops"] if s["seq"] == p["seq"])))
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
                out.append(dict(row="leg", minutes=q["t"] - p["t"], up=up, down=down, est=est,
                                vias=[x for x in seg if x["kind"] == "peak"]))
        return out

    def _label_w(text, fs):
        return sum(fs * (0.58 if ch.isascii() else 1.0) for ch in text)

    def profile_svg(t, pts, width, height, compact=False):
        """Inline SVG elevation profile. x = cumulative course time, y = elevation. No JS."""
        pts = [p for p in pts if p["y"] is not None]
        if len(pts) < 2:
            return ""
        fs = 10.5 if compact else 12
        fs_small = 9.5 if compact else 10.5
        tier_h = fs + 3
        labels = []
        for p in pts:
            if p["kind"] == "hut" and p["est"]:
                txt = f"{p['short']} {T.unknown}"
            elif compact:
                txt = p["short"]
            else:
                txt = f"{p['short']} {p['elev']:,}m"
            labels.append(dict(p=p, text=txt, size=fs if p["kind"] == "hut" else fs_small,
                               w=_label_w(txt, fs if p["kind"] == "hut" else fs_small)))
        ml, mr, mb = (40 if compact else 52), 14, (20 if compact else 24)
        xmax = max(p["t"] for p in pts) or 1
        inner_w = width - ml - mr

        def X(tm):
            return ml + inner_w * tm / xmax

        order = sorted(labels, key=lambda l: l["p"]["t"])
        tiers = []
        for l in order:
            cx = X(l["p"]["t"])
            x0, x1 = cx - l["w"] / 2, cx + l["w"] / 2
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
        mt = 10 + len(tiers) * tier_h + 6
        inner_h = height - mt - mb
        ys = [p["y"] for p in pts]
        ymin = (min(ys) - 120) // 100 * 100
        ymax = -((-(max(ys) + 100)) // 100) * 100

        def Y(e):
            return mt + inner_h * (1 - (e - ymin) / (ymax - ymin))

        sid = f'{t["id"]}-{lang}-{"n" if compact else "w"}'
        out = [f'<svg class="profile-svg {"profile-svg--narrow" if compact else "profile-svg--wide"}" '
               f'viewBox="0 0 {width} {height}" preserveAspectRatio="xMidYMid meet" role="img" '
               f'aria-labelledby="ptitle-{sid}" xmlns="http://www.w3.org/2000/svg">',
               f'<title id="ptitle-{sid}">{escape(T.profile_title.format(name=t["name"]))}</title>']
        e = -((-ymin) // 500) * 500
        while e <= ymax:
            y = Y(e)
            out.append(f'<line class="p-grid" x1="{ml}" x2="{width - mr}" y1="{y:.1f}" y2="{y:.1f}"/>')
            out.append(f'<text class="p-axis" x="{ml - 6}" y="{y + 3.5:.1f}" text-anchor="end" font-size="{fs_small}">{e:,}</text>')
            e += 500
        xstep = 180 if compact else 120
        tm = 0
        while tm <= xmax:
            x = X(tm)
            out.append(f'<line class="p-tick" x1="{x:.1f}" x2="{x:.1f}" y1="{height - mb}" y2="{height - mb + 4}"/>')
            lab = f"{tm // 60}h" if (compact or lang == "en") else (f"{tm // 60}時間" if tm else T.start)
            if tm == 0 and not compact and lang == "ja":
                lab = T.start
            anchor = "start" if tm == 0 else "middle"
            out.append(f'<text class="p-axis" x="{x:.1f}" y="{height - mb + 14}" text-anchor="{anchor}" font-size="{fs_small}">{lab}</text>')
            tm += xstep
        out.append(f'<text class="p-axis" x="{ml - 6}" y="{mt - 4}" text-anchor="end" font-size="{fs_small}">m</text>')
        d = " ".join(f"{X(p['t']):.1f},{Y(p['y']):.1f}" for p in pts)
        base = height - mb
        out.append(f'<polygon class="p-area" points="{X(pts[0]["t"]):.1f},{base} {d} {X(pts[-1]["t"]):.1f},{base}"/>')
        out.append(f'<polyline class="p-line" points="{d}"/>')
        for l in order:
            p = l["p"]
            x, y = X(p["t"]), Y(p["y"])
            ly = mt - 6 - l["tier"] * tier_h
            cls = {"hut": "pm pm-hut", "trailhead": "pm pm-th", "peak": "pm pm-peak"}[p["kind"]]
            if p["kind"] == "hut" and p["est"]:
                cls += " pm-est"
            if p["kind"] == "hut" and not p["overnight"]:
                cls += " pm-pass"
            sep = "　" if lang == "ja" else " · "
            title = sep.join(filter(None, [
                p["name"], metres_t(p["elev"]),
                (f"出発から{fmt_time(p['t'])}" if lang == "ja" else f"{fmt_time(p['t'])} from the start"),
                {"hut": (T.legend_hut.split("（")[0] if p["overnight"] else ""),
                 "trailhead": T.trailhead, "peak": T.legend_peak}[p["kind"]],
            ]))
            out.append(f'<a class="{cls}" href="#stop-{p["seq"]}" data-seq="{p["seq"]}"><title>{escape(title)}</title>')
            out.append(f'<circle class="p-hit" cx="{x:.1f}" cy="{y:.1f}" r="16"/>')
            out.append(f'<rect class="p-hit" x="{l["x0"] - 4:.1f}" y="{ly - l["size"] - 2:.1f}" width="{l["x1"] - l["x0"] + 8:.1f}" height="{l["size"] + 6:.1f}"/>')
            out.append(f'<line class="p-leader" x1="{x:.1f}" x2="{x:.1f}" y1="{ly + 2:.1f}" y2="{y - 6:.1f}"/>')
            if p["kind"] == "hut":
                out.append(f'<circle class="p-dot" cx="{x:.1f}" cy="{y:.1f}" r="{5 if compact else 5.5}"/>')
            elif p["kind"] == "trailhead":
                s_ = 8 if compact else 9
                out.append(f'<rect class="p-sq" x="{x - s_ / 2:.1f}" y="{y - s_ / 2:.1f}" width="{s_}" height="{s_}"/>')
            else:
                out.append(f'<polygon class="p-tri" points="{x:.1f},{y - 5:.1f} {x + 5:.1f},{y + 3.5:.1f} {x - 5:.1f},{y + 3.5:.1f}"/>')
            tx = (l["x0"] + l["x1"]) / 2
            out.append(f'<text class="p-label{" p-label-peak" if p["kind"] != "hut" else ""}" x="{tx:.1f}" y="{ly:.1f}" text-anchor="middle" font-size="{l["size"]}">{escape(l["text"])}</text>')
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
        out = [f'<svg class="mini-profile" viewBox="0 0 {width} {height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">',
               f'<polygon class="p-area" points="{X(pts[0]["t"]):.1f},{height} {d} {X(pts[-1]["t"]):.1f},{height}"/>',
               f'<polyline class="p-line" points="{d}"/>']
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
        t["name"] = disp(t, lang, with_ja=False)
        t["summary_t"] = pick(t, "summary", lang)
        t["stops"] = rows("SELECT * FROM trail_stops WHERE trail_id=? ORDER BY seq", t["id"])
        for s in t["stops"]:
            s["hut"] = huts.get(s["hut_id"])
            s["trailhead"] = trailheads.get(s["trailhead_id"])
            if s["hut"]:
                s["hut"]["trails"].append(t)
        t["total_min"] = max(s["cumulative_time_min"] or 0 for s in t["stops"])
        t["hut_count"] = sum(1 for s in t["stops"] if s["hut"] and s["is_overnight_candidate"])
        t["photos"] = [p for p in photos if p["trail_id"] == t["id"] and p["role"] == "trail"]
        t["points"] = build_points(t)
        t["profile"] = summarize(t["points"])
        t["rows"] = build_legs(t, t["points"])
        t["svg_wide"] = profile_svg(t, t["points"], 720, 300)
        t["svg_narrow"] = profile_svg(t, t["points"], 360, 250, compact=True)
        t["svg_mini"] = profile_mini_svg(t, t["points"])
        trails.append(t)

    client = [{
        "id": h["id"], "name": h["name"], "type": h["type_label"],
        "area": h["area"]["name"] if h["area"] else "", "area_id": h["sub_area_id"],
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

    return dict(T=T, huts=huts, trails=trails, areas=areas, photos=photos, client=client,
                fmt_time=fmt_time, fmt_date=fmt_date, metres=metres_t, conf_text=conf_text)


# ---------------------------------------------------------------- articles
# 記事は content/articles/*.md。1 記事 1 ファイル、先頭に --- で挟んだメタ情報。
#   <slug>.md     → /articles/<slug>/      （日本語）
#   <slug>.en.md  → /en/articles/<slug>/   （英語。同じ slug なら言語切替で行き来できる）
# 書式は content/articles/README.md。下書きはリポジトリの外に置く（公開リポジトリなので）。
ARTICLES_DIR = ROOT / "content" / "articles"
ARTICLE_KEYS = {"title", "date", "summary", "huts", "trails", "author", "visited", "draft", "external"}


def load_articles():
    hut_ids = {r["id"] for r in rows("SELECT id FROM huts")}
    trail_ids = {r["id"] for r in rows("SELECT id FROM trails")}
    out = {"ja": [], "en": []}
    files = sorted(ARTICLES_DIR.glob("*.md")) if ARTICLES_DIR.is_dir() else []
    for f in files:
        if f.name.upper() == "README.MD":
            continue
        stem, lang = (f.stem[:-3], "en") if f.stem.endswith(".en") else (f.stem, "ja")
        text = f.read_text(encoding="utf-8").lstrip("﻿")
        if not text.startswith("---"):
            sys.exit(f"{f.name}: 先頭に --- で挟んだメタ情報が要る（content/articles/README.md）")
        _, head, body = text.split("---", 2)
        meta = {}
        for line in head.strip().splitlines():
            k, _, v = line.partition(":")
            k = k.strip()
            if k not in ARTICLE_KEYS:
                sys.exit(f"{f.name}: 知らないキー '{k}'（使えるのは {sorted(ARTICLE_KEYS)}）")
            meta[k] = v.strip()
        if meta.get("draft", "").lower() in ("true", "yes", "1"):
            continue
        for k in ("title", "date"):
            if not meta.get(k):
                sys.exit(f"{f.name}: {k} が無い")
        huts_ = [x.strip() for x in meta.get("huts", "").split(",") if x.strip()]
        trails_ = [x.strip() for x in meta.get("trails", "").split(",") if x.strip()]
        bad = [x for x in huts_ if x not in hut_ids] + [x for x in trails_ if x not in trail_ids]
        if bad:   # 黙ってリンク切れを出さない
            sys.exit(f"{f.name}: 存在しない小屋/ルート id: {', '.join(bad)}")
        # external: 本文を持たず、他サイト（Emospot 等）の記事へリンクするだけの行。
        # 体験記は Emospot に置き、HutsGo は小屋・ルートから参照する。重複掲載はしない。
        ext = meta.get("external") or None
        if ext and not ext.startswith("https://"):
            sys.exit(f"{f.name}: external は https:// で始まる URL にする")
        out[lang].append({
            "slug": stem, "lang": lang, "title": meta["title"], "date": meta["date"],
            "visited": meta.get("visited") or None,
            "summary": meta.get("summary", ""), "author": meta.get("author") or None,
            "huts": huts_, "trails": trails_,
            "external": ext, "site": urllib.parse.urlsplit(ext).hostname if ext else None,
            "html": Markup(markdown.markdown(body, extensions=["tables", "sane_lists"])) if not ext else None,
        })
    for lang in out:
        out[lang].sort(key=lambda a: a["date"], reverse=True)
        other = {a["slug"] for a in out["en" if lang == "ja" else "ja"] if not a["external"]}
        for a in out[lang]:
            a["has_alt"] = not a["external"] and a["slug"] in other
    return out


ARTICLES = load_articles()


# ---------------------------------------------------------------- render
env = Environment(loader=FileSystemLoader(ROOT / "templates", encoding="utf-8"),
                  autoescape=select_autoescape(["html"]))
env.globals.update(SITE_URL=SITE_URL, BASE=BASE, ANALYTICS=ANALYTICS, API_URL=API_URL, TODAY=TODAY)

DIST.mkdir(exist_ok=True)
for p in DIST.iterdir():
    shutil.rmtree(p) if p.is_dir() else p.unlink()
shutil.copytree(ROOT / "static", DIST / "static")

urls = []
article_urls = []   # (url, 相手言語版があるか, 更新日)


def write(path, tpl, **ctx):
    out = DIST / path
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(env.get_template(tpl).render(**ctx), encoding="utf-8")


for lang, prefix in LOCALES:
    m = build_model(lang)
    # 記事の日付は年をまたぐので年まで出す（小屋の営業期間は年が自明なので fmt_date は月日だけ）
    fmt_ymd = (lambda d: f"{d[:4]}年{m['fmt_date'](d)}") if lang == "ja" else (lambda d: f"{m['fmt_date'](d)} {d[:4]}")
    env.filters.update(fmt_time=m["fmt_time"], fmt_date=m["fmt_date"], yen=yen, fmt_ymd=fmt_ymd,
                       metres=m["metres"], conf_text=m["conf_text"])
    photos = m["photos"]
    g = dict(T=m["T"], LANG=lang, LB=BASE + prefix,
             ALT=BASE + (dict(LOCALES)["en"] if lang == "ja" else ""),   # counterpart language root
             ALT_LANG="en" if lang == "ja" else "ja",
             PREFIX=prefix,
             areas=list(m["areas"].values()),
             HERO=next((p for p in photos if p["role"] == "hero"), None),
             TEASER=[p for p in photos if p["role"] == "teaser"],
             AREA_PHOTO=next((p for p in photos if p["role"] == "area"), None))
    d = (prefix.lstrip("/") + "/") if prefix else ""
    huts_l, trails_l = list(m["huts"].values()), m["trails"]

    arts = ARTICLES[lang]
    for h in huts_l:
        h["articles"] = [a for a in arts if h["id"] in a["huts"]]
    for t in trails_l:
        t["articles"] = [a for a in arts if t["id"] in a["trails"]]
    g["HAS_ARTICLES"] = bool(arts)

    write(f"{d}index.html", "index.html", trails=trails_l, huts=huts_l, page="/", articles=arts[:3], **g)
    write(f"{d}huts/index.html", "huts.html", huts=huts_l, page="/huts/",
          client_json=json.dumps(m["client"], ensure_ascii=False), **g)
    write(f"{d}about/index.html", "about.html", huts=huts_l, page="/about/", **g)
    # データから作るまとめページ。手書き記事と違い seed.sql を直せば直る
    write(f"{d}booking/index.html", "booking.html", huts=huts_l, page="/booking/",
          known=sorted([h for h in huts_l if h["season"] and h["season"].get("opens")],
                       key=lambda h: ((h["area"] or {}).get("name", ""), h["name"])),
          unknown=[h for h in huts_l if not (h["season"] and h["season"].get("opens"))], **g)
    for h in huts_l:
        write(f"{d}huts/{h['id']}/index.html", "hut.html", h=h, page=f"/huts/{h['id']}/", **g)
    for t in trails_l:
        write(f"{d}trails/{t['id']}/index.html", "trail.html", t=t, page=f"/trails/{t['id']}/", **g)

    if arts:
        hut_names = {h["id"]: h["name"] for h in huts_l}
        trail_names = {t["id"]: t["name"] for t in trails_l}
        alt_has_articles = bool(ARTICLES[g["ALT_LANG"]])
        write(f"{d}articles/index.html", "articles.html", articles=arts, page="/articles/",
              single_lang=not alt_has_articles, alt_page="/articles/" if alt_has_articles else "/", **g)
        for a in arts:
            if a["external"]:      # 外部記事はページを作らない（重複掲載しない）
                continue
            # 記事は言語ごとに別物。相手言語に同じ slug が無ければ、言語切替は相手のトップへ
            pg = f"/articles/{a['slug']}/"
            write(f"{d}articles/{a['slug']}/index.html", "article.html", a=a, page=pg,
                  single_lang=not a["has_alt"], alt_page=pg if a["has_alt"] else "/",
                  hut_names=hut_names, trail_names=trail_names, **g)
            article_urls.append((f"{prefix}{pg}", a["has_alt"], a["date"]))
        article_urls.append((f"{prefix}/articles/", alt_has_articles, TODAY))

    urls += [f"{prefix}/", f"{prefix}/huts/", f"{prefix}/about/", f"{prefix}/booking/"] \
        + [f"{prefix}/huts/{h['id']}/" for h in huts_l] \
        + [f"{prefix}/trails/{t['id']}/" for t in trails_l]

# sitemap with hreflang pairs so Google serves the right language
def alt_links(u):
    bare = u[3:] if u.startswith("/en") else u
    return ('<xhtml:link rel="alternate" hreflang="ja" href="%s%s"/>'
            '<xhtml:link rel="alternate" hreflang="en" href="%s/en%s"/>'
            '<xhtml:link rel="alternate" hreflang="x-default" href="%s%s"/>' % (SITE_URL, bare, SITE_URL, bare, SITE_URL, bare))


(DIST / "sitemap.xml").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
    + "".join(f"  <url><loc>{SITE_URL}{u}</loc>{alt_links(u)}<lastmod>{TODAY}</lastmod></url>\n" for u in urls)
    + "".join(f"  <url><loc>{SITE_URL}{u}</loc>{alt_links(u) if paired else ''}<lastmod>{d}</lastmod></url>\n"
              for u, paired, d in article_urls)
    + f"  <url><loc>{SITE_URL}/api/</loc><lastmod>{TODAY}</lastmod></url>\n"
    + "</urlset>\n", encoding="utf-8")
(DIST / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {SITE_URL}/sitemap.xml\n", encoding="utf-8")
if CNAME:
    (DIST / "CNAME").write_text(CNAME + "\n", encoding="utf-8")



# ---------------------------------------------------------------- machine-readable dataset
# 2026 年の検索は 7 割近くがクリックを生まない。人がサイトに来る前提だけでは届かない。
# 一方で AI が答えを作るには「出典と確認日の付いた事実」が要る。これは今どこにも構造化されていない。
# そこでサイト本体とは別に、確度メタデータを保ったままデータセットを公開する。
DATA_LICENSE = "CC BY 4.0"
DATA_VERSION = "2026.1"


def _prov(row):
    if not row:
        return None
    return {"source_url": row.get("source_url"),
            "last_verified_at": row.get("last_verified_at"),
            "confidence": row.get("confidence")}


def _bi(row, field):
    """日英の両方を返す。どちらも無ければ None。
    列名は name_ja/name_en の形と、label/label_en のように日本語側が無印の形が混在する。"""
    ja = row.get(field + "_ja")
    if ja is None:
        ja = row.get(field)
    en = row.get(field + "_en")
    if ja is None and en is None:
        return None
    return {"ja": ja, "en": en}


def export_dataset():
    areas = {a["id"]: a for a in rows("SELECT * FROM sub_areas")}
    ops = {o["id"]: o for o in rows("SELECT * FROM operators")}
    ths = {t["id"]: t for t in rows("SELECT * FROM trailheads")}

    huts_out = []
    for h in rows("SELECT * FROM huts ORDER BY id"):
        hid = h["id"]
        se = next(iter(rows("SELECT * FROM hut_seasons WHERE hut_id=? AND year=2026", hid)), None)
        fac = next(iter(rows("SELECT * FROM hut_facilities WHERE hut_id=?", hid)), None)
        a, o = areas.get(h["sub_area_id"]), ops.get(h["operator_id"])
        rec = {
            "id": hid,
            "name": _bi(h, "name"),
            "type": h["hut_type"],
            "range_id": h["range_id"],
            "area": {"id": a["id"], "name": _bi(a, "name")} if a else None,
            "operator": {"id": o["id"], "name": _bi(o, "name"), "website": o["website"]} if o else None,
            "location": {"lat": h["lat"], "lon": h["lon"],
                         "elevation_m": h["elevation_m"],
                         "elevation_source": h["elevation_source"]},
            "official_url": h["official_url"],
            "provenance": _prov(h),
        }
        if se:
            rec["season_2026"] = {
                "status": se["status"], "open_date": se["open_date"], "close_date": se["close_date"],
                "note": _bi(se, "season_note"),
                "reservation": {
                    "required": se["reservation_required"],
                    "url": se["reservation_url"],
                    "phone": se["reservation_phone"],
                    # 訪日ハイカーに最も価値のある項目。英語圏のどこにも構造化されていない
                    "opens_at": _bi(se, "booking_opens_at"),
                },
                "capacity": {"beds": se["capacity_beds"], "tents": se["capacity_tents"]},
                "provenance": _prov(se),
            }
        rec["rates_2026"] = [{
            "plan": r["plan_type"], "price": r["price_jpy"],
            "currency": r.get("currency", "JPY"),
            "is_from_price": bool(r["is_from_price"]), "provenance": _prov(r),
        } for r in rows("SELECT * FROM hut_rates WHERE hut_id=? AND year=2026 ORDER BY plan_type", hid)]
        if fac:
            rec["facilities"] = {k: fac[k] for k in (
                "toilet_type", "toilet_fee_jpy", "water_available", "power_outlet", "charging_service",
                "charging_fee_jpy", "wifi", "private_room", "bath", "shower", "drying_room", "shop",
                "bento_available", "credit_card", "qr_payment", "cash_only")}
            rec["facilities"]["provenance"] = _prov(fac)
        sig = rows("SELECT * FROM hut_mobile_signal WHERE hut_id=?", hid)
        if sig:
            rec["mobile_signal"] = [{"carrier": g["carrier"], "quality": g["quality"],
                                     "provenance": _prov(g)} for g in sig]
        huts_out.append(rec)

    trails_out = []
    for t in rows("SELECT * FROM trails ORDER BY id"):
        stops = []
        for st in rows("SELECT * FROM trail_stops WHERE trail_id=? ORDER BY seq", t["id"]):
            hut = st["hut_id"]
            th = ths.get(st["trailhead_id"])
            # 標高は hut / trailhead / 通過点のどこかにある。消費側で結合させず、ここで解決して入れる。
            hrow = next((x for x in rows("SELECT * FROM huts WHERE id=?", hut)), None) if hut else None
            elev = (hrow or {}).get("elevation_m") if hut else (th["elevation_m"] if th else st["elevation_m"])
            stops.append({
                "seq": st["seq"],
                "kind": "hut" if hut else ("trailhead" if th else "waypoint"),
                "hut_id": hut,
                "name": _bi(hrow, "name") if hrow else (_bi(th, "name") if th else _bi(st, "label")),
                "trailhead_id": th["id"] if th else None,
                "elevation_m": elev,
                # 稜線の小屋は公式に標高記載が無いものがある。false のときは断面図を描く前に注意すること
                "elevation_confirmed": elev is not None,
                "cumulative_time_min": st["cumulative_time_min"],
                "overnight_candidate": bool(st["is_overnight_candidate"]),
            })
        trails_out.append({
            "id": t["id"], "name": _bi(t, "name"), "summary": _bi(t, "summary"),
            "nights_typical": t["nights_typical"], "difficulty": t["difficulty"], "stops": stops,
        })

    verified = sum(1 for h in huts_out
                   if ((h.get("season_2026") or {}).get("provenance") or {}).get("confidence") == "verified")
    index = {
        "name": "HutsGo open dataset",
        "description": ("Mountain huts of the Northern Japan Alps. Every fact carries its source URL, "
                        "the date it was checked and a confidence level, so a machine can tell a confirmed "
                        "fact from a second-hand one and never has to guess."),
        "version": DATA_VERSION,
        "generated_at": TODAY,
        "license": DATA_LICENSE,
        "attribution": "HutsGo (" + SITE_URL + ")",
        "contact": SITE_URL + "/about/",
        "season": 2026,
        "coverage": {"huts": len(huts_out), "trails": len(trails_out),
                     "season_verified_on_official_site": verified},
        "confidence_levels": {
            "verified": "Checked on the hut's own website or by phone on last_verified_at.",
            "reported": "Taken from a reliable non-official source. Not yet confirmed officially.",
            "unknown": "Not checked. Absent rather than guessed.",
        },
        "note": ("Null means not confirmed. It is never zero and never a guess. Mountain information "
                 "is safety-relevant, so do not infer a missing value."),
        "files": {"huts": "/data/huts.json", "trails": "/data/trails.json"},
    }

    d = DIST / "data"
    d.mkdir(exist_ok=True)
    for name, payload in (("index", index), ("huts", huts_out), ("trails", trails_out)):
        (d / (name + ".json")).write_text(
            json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    return index


DATA_INDEX = export_dataset()

# llms.txt は正式な標準ではなく、主要な AI 各社も採用を明言していない。
# ただし設置は数分で、読まれた場合の効きは大きい。戦略の柱にはしない。
LLMS = """# HutsGo

> {desc}

Every published fact carries source_url, last_verified_at and confidence
(verified / reported / unknown). A missing value means not confirmed. It is never a
guess and never zero. Mountain information is safety-relevant, so please quote the
confidence level and the check date alongside any value you cite.

## Data ({lic}, attribution: HutsGo {url})
- [Dataset index]({url}/data/index.json): coverage, licence and field notes
- [Huts]({url}/data/huts.json): {n} huts with season, prices, facilities and booking windows
- [Trails]({url}/data/trails.json): routes as ordered stops with elevation and cumulative walking time
- [Field reference]({url}/api/): what each field means
- MCP server (hosted, no install): `https://api.hutsgo.com/mcp.php`
  tools: search_huts, get_hut, booking_windows, get_trail

## Pages
- [Japanese site]({url}/)
- [English site]({url}/en/): written for visitors who cannot phone a hut in Japanese
- [Sources and method]({url}/about/)

## Why this exists
Japanese mountain huts take bookings by phone, in Japanese, and the popular ones fill
within minutes of their booking window opening. That window is published on each hut's
own site and nowhere in machine-readable form. season_2026.reservation.opens_at carries it.
""".format(desc=DATA_INDEX["description"], lic=DATA_LICENSE, url=SITE_URL,
           n=DATA_INDEX["coverage"]["huts"])
(DIST / "llms.txt").write_text(LLMS, encoding="utf-8")


# ---------------------------------------------------------------- field reference (/api/)
# 開発者と AI 向けの 1 枚。多言語にはしない（読み手は英語で足りる）。
API_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HutsGo data — field reference</title>
<meta name="description" content="Open dataset of Northern Japan Alps mountain huts. Every fact carries its source, check date and confidence level.">
<link rel="canonical" href="{url}/api/">
<link rel="stylesheet" href="{base}/static/site.css">
<link rel="icon" href="{base}/static/favicon.svg" type="image/svg+xml">
</head>
<body>
<header class="site-head">
  <a class="wordmark" href="{base}/en/" aria-label="HutsGo home">
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><path d="M2 22 L10 8 L14 14 L17 10 L24 22 Z" fill="currentColor"/></svg>
    <span>HutsGo</span>
  </a>
  <nav aria-label="Main">
    <a href="{base}/en/">By route</a>
    <a href="{base}/en/huts/">Search by filter</a>
    <a href="{base}/en/about/">About the data</a>
  </nav>
</header>
<main id="main">
<article class="prose">
  <header class="page-head">
    <h1>Data</h1>
    <p class="lede">Mountain huts of the Northern Japan Alps, as machine-readable JSON. Every fact
    carries the URL it came from, the date we checked it, and how far that check went.</p>
  </header>

  <h2>Files</h2>
  <ul>
    <li><a href="{base}/data/index.json"><code>/data/index.json</code></a> &mdash; coverage, licence, field notes</li>
    <li><a href="{base}/data/huts.json"><code>/data/huts.json</code></a> &mdash; {n} huts: season, prices, facilities, booking window</li>
    <li><a href="{base}/data/trails.json"><code>/data/trails.json</code></a> &mdash; routes as ordered stops with elevation and cumulative walking time</li>
  </ul>
  <p>Static JSON, no key, no rate limit. Rebuilt whenever the source data changes;
  <code>generated_at</code> in the index tells you when.</p>

  <h2>Provenance</h2>
  <p>Every block that carries facts has a <code>provenance</code> object:</p>
  <table class="rates">
    <tbody>
      <tr><th scope="row"><code>source_url</code></th><td>Where the value came from. For <code>verified</code> rows this is the hut's own site.</td></tr>
      <tr><th scope="row"><code>last_verified_at</code></th><td>The date a human read that page. Not the date the file was generated.</td></tr>
      <tr><th scope="row"><code>confidence</code></th><td><code>verified</code> / <code>reported</code> / <code>unknown</code></td></tr>
    </tbody>
  </table>
  <p><b>A null is not a zero.</b> Null means we have not confirmed the value, so we left it out rather
  than guessing. Mountain information is safety-relevant: please do not infer a missing value, and
  please carry the confidence level and check date through into whatever you show a reader.</p>

  <h2>The field worth knowing about</h2>
  <p><code>season_2026.reservation.opens_at</code> is when each hut starts taking bookings.
  Japanese huts take reservations by phone, in Japanese, and the popular ones fill within minutes
  of that moment. Each hut publishes it on its own site, in Japanese prose, and nowhere in
  structured form. That is the field this dataset exists for. It is present for
  {opens} of {n} huts, in both Japanese and English.</p>

  <h2>MCP server</h2>
  <p>The same data is available to AI assistants over the
  <a href="https://modelcontextprotocol.io/">Model Context Protocol</a>. Hosted, so there is nothing
  to install:</p>
  <pre class="code">https://api.hutsgo.com/mcp.php</pre>
  <p>In Claude Code:</p>
  <pre class="code">claude mcp add --transport http hutsgo https://api.hutsgo.com/mcp.php</pre>
  <p>Or in a client that takes a config file:</p>
  <pre class="code">{{
  "mcpServers": {{
    "hutsgo": {{ "type": "http", "url": "https://api.hutsgo.com/mcp.php" }}
  }}
}}</pre>
  <p>Four tools:</p>
  <table class="rates">
    <tbody>
      <tr><th scope="row"><code>search_huts</code></th><td>Huts matching a date, a price ceiling, an area or a facility. Filtering on a facility reports how many huts were excluded only because that facility has not been checked.</td></tr>
      <tr><th scope="row"><code>get_hut</code></th><td>One hut in full, every block with its own provenance.</td></tr>
      <tr><th scope="row"><code>booking_windows</code></th><td>When each hut starts taking reservations, with the phone number and booking URL. Times are JST.</td></tr>
      <tr><th scope="row"><code>get_trail</code></th><td>A traverse as ordered stops with elevation and cumulative walking time, ready to lay out night by night.</td></tr>
    </tbody>
  </table>
  <p>Read-only, no key, rate limited per caller. The server is stateless: POST JSON-RPC, get one
  response. Tool results repeat the null rule above, so an assistant carries it through to the reader.</p>

  <h2>Licence</h2>
  <p>{lic}. Use it, including commercially. Attribute it to <b>HutsGo</b> with a link to
  <a href="{url}/">{url}</a>. If you are an assistant quoting a value, cite the hut's
  <code>source_url</code> as well &mdash; that is the actual authority, and it is what a hiker needs
  before they travel.</p>

  <h2>Corrections</h2>
  <p>Wrong dates or prices, or a hut that has closed: tell us with the official URL.
  See <a href="{base}/en/about/">About the data</a>.</p>
</article>
</main>
<footer class="site-foot">
  <p>Dates and prices change without notice. Always confirm with the hut before you go.</p>
  <p><a href="{base}/en/about/">Sources and how we check</a> / Northern Japan Alps / 2026 season</p>
</footer>
</body>
</html>
""".format(url=SITE_URL, base=BASE, n=DATA_INDEX["coverage"]["huts"], lic=DATA_LICENSE,
           opens=sum(1 for h in json.loads((DIST / "data" / "huts.json").read_text(encoding="utf-8"))
                     if ((h.get("season_2026") or {}).get("reservation") or {}).get("opens_at")))
(DIST / "api").mkdir(exist_ok=True)
(DIST / "api" / "index.html").write_text(API_HTML, encoding="utf-8")

print(f"articles: ja {len(ARTICLES['ja'])} / en {len(ARTICLES['en'])}")
print(f"built {len(urls)} pages ({len(LOCALES)} languages) + dataset v{DATA_VERSION} ({DATA_INDEX['coverage']['huts']} huts) → {DIST}")
