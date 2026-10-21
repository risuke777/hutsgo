#!/usr/bin/env python3
"""HutsGo static site builder.  python3 build.py  →  dist/

日本語版を / に、英語版を /en/ に出す。データは同じ SQLite から両方を生成する。
英語版の狙いは訪日ハイカー: 電話が使えず、受付開始を逃すと泊まれない層。
"""
import hashlib, json, os, pathlib, re, shutil, sqlite3, datetime, sys, urllib.parse, urllib.request
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
# ルートページ「いつ泊まれる？」の横軸（営業期間のデータは 2026 年）
GANTT_W0, GANTT_W1 = datetime.date(2026, 4, 1), datetime.date(2026, 11, 30)
GANTT_SPAN = (GANTT_W1 - GANTT_W0).days + 1
GANTT_TICKS = [(m, round((datetime.date(2026, m, 1) - GANTT_W0).days / GANTT_SPAN * 100, 2)) for m in (4, 6, 8, 10)]

LOCALES = [("ja", ""), ("en", "/en")]   # (言語, URL 接頭辞)

# 口コミから出していいリンク先。自社サイトと、その小屋自身の公式サイトだけ。
# 承認制でもリンクを自由にすると投稿がスパムの的になる。出口を塞いでおけば的にならない。
# 県のグレーディングの表の英語名（trail_grading.source_name の先頭で引く）
GRADING_EN = {"長野県": "Nagano Prefecture mountain grading", "富山県": "Toyama Prefecture mountain grading",
              "岐阜県": "Gifu Prefecture mountain grading", "栃木県": "Tochigi Prefecture mountain grading",
              "秋田県": "Akita Prefecture mountain grading", "山形県": "Yamagata Prefecture mountain grading",
              "日本百名山": "the 100 Famous Mountains grading table (Gunma Prefecture)",
              "3 Zinnen Dolomites": "3 Zinnen Dolomites (local tourist board), “Summer-walk around the Drei Zinnen/Tre Cime”"}
# 言語ごとの「いつもの行き先」（docs/REGIONS.md）。トップ（/）がこの地方の入口になり、ほかの地方は /areas/<地方>/。
# イタリア語版・ドイツ語版を作る日は "europe_alps" にする
HOME_ZONE = {"ja": "japan", "en": "japan"}
REVIEW_LINK_HOSTS = {"emospot.com", "www.emospot.com", SITE_HOST} - {""}

# ---------------------------------------------------------------- data
db = ROOT / "hutsgo.db"
if db.exists():
    db.unlink()
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
for f in ("schema.sql", "seed.sql"):
    con.executescript((ROOT / f).read_text(encoding="utf-8"))

# ---- 小屋ごとの記録 content/huts/*.json（日本の外の小屋。docs/REGIONS.md「小屋の記録」）
# 1 軒 = 1 つの JSON。小屋の公式サイトを人が読んで書いた値だけを入れる（A1〜A3）。
# どの値にも出典（src）と確かめた日（checked）が要る。書いていなければ小屋の src / checked を使う
HUT_PARTS = {"early", "mid", "late"}


def load_hut_records(path):
    recs = json.loads(path.read_text(encoding="utf-8"))
    for r in recs:
        hid = r["id"]
        where = f"{path.name}: {hid}"
        assert re.fullmatch(r"[a-z0-9_]+", hid), f"{where}: id は英小文字・数字・_ だけ"
        # 小屋の公式サイトで人が読んだ値なので verified（確度の決まりは /data/index.json の confidence_levels）
        src, chk, conf = r["src"], r["checked"], r.get("conf", "verified")
        lat, lon = (r.get("pos") or [None, None])
        con.execute("""INSERT INTO huts (id,name_ja,name_en,hut_type,range_id,sub_area_id,lat,lon,elevation_m,elevation_source,
                       official_url,source_url,last_verified_at,confidence,position_source,osm_ref,owner_kind)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (hid, r["name_ja"], r.get("name_en"), r.get("type", "mountain_hut"), r["range"], r.get("sub_area"),
                     lat, lon, r.get("ele"), r.get("ele_src") if r.get("ele") else None,
                     r.get("url"), src, chk, conf, r.get("pos_src"), r.get("osm"), r.get("owner")))
        if r.get("aliases"):
            con.execute("INSERT INTO search_aliases (kind,target_id,words) VALUES ('hut',?,?)", (hid, r["aliases"]))
        se = r.get("season") or {}
        book = r.get("book") or []
        phone = r.get("phone")
        # 年ごとの行（2026）: 営業期間・電話・予約の決まり。営業期間が分からなくても予約の窓口があれば行を作る（status は undecided）
        if se or book or phone or r.get("beds") or r.get("terms"):
            st = se.get("status") or ("open" if se.get("open") or se.get("close") else "undecided")
            web = next((b["url"] for b in book if b["kind"] in ("web", "form")), None)
            con.execute("""INSERT INTO hut_seasons (hut_id,year,status,open_date,close_date,season_note,season_note_en,
                           reservation_required,reservation_url,reservation_phone,booking_opens_at,booking_opens_at_en,
                           capacity_beds,booking_terms,booking_terms_en,source_url,last_verified_at,confidence)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (hid, se.get("year", 2026), st, se.get("open"), se.get("close"), se.get("note"), se.get("note_en"),
                         se.get("required"), web, phone, se.get("opens"), se.get("opens_en"), r.get("beds"),
                         (r.get("terms") or {}).get("ja"), (r.get("terms") or {}).get("en"),
                         se.get("src", src), se.get("checked", chk), se.get("conf", conf if se else "unknown")))
        # 次の年（2027）の営業期間。秋には小屋が次の夏の日付を出し始める。予約の窓口は 2026 の行に持つ
        nx = r.get("next")
        if nx:
            con.execute("""INSERT INTO hut_seasons (hut_id,year,status,open_date,close_date,season_note,season_note_en,
                           source_url,last_verified_at,confidence) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (hid, nx.get("year", 2027), nx.get("status") or ("open" if nx.get("open") or nx.get("close") else "undecided"),
                         nx.get("open"), nx.get("close"), nx.get("note"), nx.get("note_en"),
                         nx.get("src", src), nx.get("checked", chk), nx.get("conf", conf)))
        u = r.get("usual")
        if u:
            fm, fp = (list(u.get("from") or []) + [None, None])[:2]
            tm, tp = (list(u.get("to") or []) + [None, None])[:2]
            assert fp in HUT_PARTS | {None} and tp in HUT_PARTS | {None}, where
            con.execute("""INSERT INTO hut_usual_seasons (hut_id,from_month,from_part,to_month,to_part,winter,note,note_en,
                           source_url,last_verified_at,confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                        (hid, fm, fp, tm, tp, u.get("winter"), u.get("note"), u.get("note_en"),
                         u.get("src", src), u.get("checked", chk), u.get("conf", conf)))
        for i, b in enumerate(book, 1):
            assert b["kind"] in ("web", "form", "email"), where
            assert b["kind"] != "email" or b["url"].startswith("mailto:"), f"{where}: メールは mailto:"
            con.execute("""INSERT INTO hut_booking_channels (hut_id,year,seq,kind,operator,url,url_en,english,note_ja,note_en,
                           availability,system,source_url,last_verified_at,confidence) VALUES (?,?,?,?,'hut',?,?,?,?,?,?,?,?,?,?)""",
                        (hid, 2026, i, b["kind"], b["url"], b.get("url_en"), b.get("english", "unknown"), b.get("note"),
                         b.get("note_en"), b.get("avail"), b.get("system"), b.get("src", src), b.get("checked", chk),
                         b.get("conf", conf)))
        for x in r.get("rates") or []:
            con.execute("""INSERT INTO hut_rates (hut_id,year,plan_type,price_jpy,currency,is_from_price,price_member,note_ja,note_en,
                           source_url,last_verified_at,confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (hid, x.get("year", 2026), x["plan"], x.get("price"), x.get("currency", "EUR"), x.get("from", 0),
                         x.get("member"), x.get("note"), x.get("note_en"), x.get("src", src), x.get("checked", chk),
                         x.get("conf", conf)))
        fac = r.get("fac")
        if fac:
            cols = [k for k in fac if k not in ("src", "checked", "conf")]
            con.execute(f"INSERT INTO hut_facilities (hut_id,{','.join(cols)},source_url,last_verified_at,confidence) "
                        f"VALUES (?,{','.join('?' * len(cols))},?,?,?)",
                        (hid, *[fac[k] for k in cols], fac.get("src", src), fac.get("checked", chk), fac.get("conf", conf)))


for _f in sorted((ROOT / "content" / "huts").glob("*.json")):
    load_hut_records(_f)


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
            return f"{mm}分" if not h else (f"{h}時間{mm:02d}分" if mm else f"{h}時間")
        return f"{mm} min" if not h else (f"{h}h{mm:02d}" if mm else f"{h}h")

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


def money(v, cur="JPY"):
    """料金。円は ¥12,000、ユーロは €72 / €72.50（小数があるときだけ小数を出す）"""
    if v is None:
        return None
    if cur == "JPY":
        return f"¥{int(v):,}"
    sym = {"EUR": "€", "CHF": "CHF "}[cur]
    return f"{sym}{v:,.0f}" if float(v).is_integer() else f"{sym}{v:,.2f}"


def metres(v):
    return f"{v:,}m" if v is not None else None


PART_JA = {"early": "上旬", "mid": "中旬", "late": "下旬"}
PART_EN = {"early": "early ", "mid": "mid-", "late": "late "}
MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def usual_label(u, lang):
    """例年の営業期間の文。「6月中旬〜9月下旬」/ "mid-June to late September" """
    def one(m, part):
        if not m:
            return None
        if lang == "ja":
            return f"{m}月" + PART_JA.get(part, "")
        return PART_EN.get(part, "") + MONTH_EN[m - 1]
    a, b = one(u["from_month"], u["from_part"]), one(u["to_month"], u["to_part"])
    if not (a or b):
        return None
    return (a or "?") + ("〜" if lang == "ja" else " to ") + (b or "?")


# ---------------------------------------------------------------- per-locale model
def _hav_m(a, b):
    import math
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def trail_line(trail_id, pts):
    """地図に引く線。trail_paths/<id>.json（tools/trail_paths.py が地理院の道路中心線から作る）に
    区間の線があればそれを使い、無い区間は小屋・登山口を直線で結ぶ。
    pts = [(stop_id, lat, lon)]（行程順、座標のある stop のみ）。返り値 (座標列, 道をたどれた区間数, 全区間数)。
    座標を直したのに線を作り直していない区間は、端が stop から外れるので直線に戻す（古い線を出さない）。"""
    f = ROOT / "trail_paths" / f"{trail_id}.json"
    legs = {}
    if f.exists():
        for leg in json.loads(f.read_text(encoding="utf-8"))["legs"]:
            if leg.get("coords"):
                legs[(leg["from"], leg["to"])] = leg["coords"]
    line, traced = [], 0
    for i, (sid, lat, lon) in enumerate(pts):
        if i == 0:
            line.append((lat, lon)); continue
        prev = pts[i - 1]
        c = legs.get((prev[0], sid))
        if c and _hav_m(c[0], prev[1:]) < 5 and _hav_m(c[-1], (lat, lon)) < 5:
            line.extend(tuple(p) for p in c[1:]); traced += 1
        else:
            if c:
                print(f"  ! {trail_id}: {prev[0]} → {sid} の線は stop の座標とずれている。"
                      f"python tools/trail_paths.py {trail_id} で作り直す", file=sys.stderr)
            line.append((lat, lon))
    return line, traced, max(len(pts) - 1, 0)


# 標準タイムの式: 時間(h) = 距離(km)×a + 累積登り(km)×b + 累積下り(km)×c
# 長野県「信州 山のグレーディング」一覧表（令和8年4月）の 124 ルートの合計コースタイム・ルート長・累積登り・累積下りに
# 最小二乗で当てはめた（tools/fit_course_time.py）。平均の外れ 約12%、113/124 ルートが ±25% 以内。
# 平地 約3.9km/h・登り 約440m/h・下り 約490m/h に当たる。距離・登り・下りは tools/trail_profile.py が地理院の線と標高から出す。
CT_COEF = (0.2573, 2.2955, 2.0368)


def _ct_h(l_m, u_m, d_m):
    a, b, c = CT_COEF
    return l_m / 1000 * a + u_m / 1000 * b + d_m / 1000 * c


def course_estimate(trail_id, stops):
    """stops = [(stop_id, lat, lon, seq, 名前, 種類)]（座標のある stop を行程順）。
    区間ごとに式で時間を出す。1 区間でも道沿いの線・標高が無ければ None（直線の区間に時間を付けない）。"""
    f = ROOT / "trail_paths" / f"{trail_id}.json"
    if not f.exists() or len(stops) < 2:
        return None
    legs = {(lg["from"], lg["to"]): lg for lg in json.loads(f.read_text(encoding="utf-8"))["legs"]
            if lg.get("coords") and "up_m" in lg}
    out = []
    for a, b in zip(stops, stops[1:]):
        lg = legs.get((a[0], b[0]))
        if not lg or _hav_m(lg["coords"][0], a[1:3]) >= 5 or _hav_m(lg["coords"][-1], b[1:3]) >= 5:
            return None
        out.append(dict(a=a, b=b, h=_ct_h(lg["length_m"], lg["up_m"], lg["down_m"]), L=lg["length_m"],
                        U=lg["up_m"], D=lg["down_m"], coords=lg["coords"], elev=lg.get("elev")))
    return out


def track_of(est, cap=600):
    """3D 地図のスライダー用: [緯度, 経度, 距離km, 標高, 分] の列と、小屋・山頂の位置（何点目・何分）。
    区間の中の時間は、細かい区間ごとに同じ式で重みを付けて配る（急な所ほど時間がかかる）。"""
    pts, marks, t0, d0 = [], [], 0.0, 0.0
    for j, x in enumerate(est):
        c = x["coords"]
        e = x["elev"] or [None] * len(c)
        w, dist = [0.0], [0.0]
        for i in range(1, len(c)):
            d = _hav_m(c[i - 1], c[i])
            dz = (e[i] - e[i - 1]) if e[i] is not None and e[i - 1] is not None else 0
            w.append(w[-1] + _ct_h(d, max(dz, 0), max(-dz, 0)))
            dist.append(dist[-1] + d)
        wt = w[-1] or 1
        if j == 0:
            marks.append(dict(n=x["a"][4], k=x["a"][5], i=0, m=0, km=0))
        for i in range(0 if j == 0 else 1, len(c)):
            pts.append([round(c[i][0], 6), round(c[i][1], 6), round((d0 + dist[i]) / 1000, 3), e[i],
                        round(t0 + x["min"] * w[i] / wt, 1)])
        t0 += x["min"]
        d0 += dist[-1]
        marks.append(dict(n=x["b"][4], k=x["b"][5], i=len(pts) - 1, m=round(t0, 1), km=round(d0 / 1000, 2)))
    if len(pts) > cap:
        step = -(-len(pts) // cap)
        keep = sorted({i for i in range(0, len(pts), step)} | {mk["i"] for mk in marks} | {len(pts) - 1})
        remap = {old: new for new, old in enumerate(keep)}
        pts = [pts[i] for i in keep]
        for mk in marks:
            mk["i"] = remap[mk["i"]]
    return dict(p=pts, s=marks)


def gpx_for(t, line):
    """道をたどれたルートだけ GPX にする。直線の区間を含む GPX はナビに読み込まれると危ないので作らない"""
    from xml.sax.saxutils import escape as x, quoteattr as qa
    desc = ("小屋と登山口を、国土地理院ベクトルタイルの道路中心線（徒歩道）に沿って結んだ線。"
            "通行止め・付け替えは反映しない。現地の標識と最新の登山道情報を優先すること。"
            "Follows footpaths in GSI (Geospatial Information Authority of Japan) map data; "
            "closures and reroutes are not reflected.")
    wpts = "".join(
        f'<wpt lat="{p["lat"]}" lon="{p["lon"]}"><name>{x(p["name_ja"])}</name></wpt>\n'
        for p in [s["hut"] or s["trailhead"] for s in t["stops"] if s["hut"] or s["trailhead"]]
        if p.get("lat") and p.get("lon"))
    pts = "".join(f'<trkpt lat="{la}" lon="{lo}"/>' for la, lo in line)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<gpx version="1.1" creator="HutsGo" xmlns="http://www.topografix.com/GPX/1/1">\n'
            f'<metadata><name>{x(t["name_ja"])}</name><desc>{x(desc)}</desc>'
            f'<link href={qa(SITE_URL + "/trails/" + t["id"] + "/")}><text>HutsGo</text></link></metadata>\n'
            f'{wpts}<trk><name>{x(t["name_ja"])}</name><trkseg>{pts}</trkseg></trk>\n</gpx>\n')


def gsi3d_url(map_line, pxsize=2048):
    """地理院地図3D をルート全体が収まる範囲で開く URL。自前で 3D は描かない（C2）。
    地理院地図3D は中心と zoom から pxsize 四方を切り出すので、ルートの外接範囲に 3割の余白を足して
    収まる最大の zoom を選ぶ。座標が 2 点未満なら None。"""
    import math
    pts = [tuple(map(float, p.split(","))) for p in map_line.split(";") if p]
    if len(pts) < 2:
        return None
    lats, lons = [p[0] for p in pts], [p[1] for p in pts]
    lat, lon = (min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2
    cos = math.cos(math.radians(lat))
    extent = max((max(lats) - min(lats)) * 111320, (max(lons) - min(lons)) * 111320 * cos, 2000) * 1.3
    z = max(10, min(15, math.floor(math.log2(156543.03 * cos * pxsize / extent))))
    return f"https://maps.gsi.go.jp/index_3d.html?z={z}&lat={lat:.5f}&lon={lon:.5f}&pxsize={pxsize}&ls=std"


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

    # 地域の分け方（docs/REGIONS.md）: 地方 → 山域 → 山群。国は決まり（通貨・地図・難易度の区分）の切り替え
    countries = {c["id"]: dict(c, name=disp(c, lang, with_ja=False), emergency_t=pick(c, "emergency", lang))
                 for c in rows("SELECT * FROM countries")}
    zones = {z["id"]: dict(z, name=disp(z, lang, with_ja=False), lede_t=pick(z, "lede", lang), slug=z["id"].replace("_", "-"),
                           path="/" if z["id"] == HOME_ZONE[lang] else f"/areas/{z['id'].replace('_', '-')}/")
             for z in rows("SELECT * FROM zones ORDER BY sort")}
    # 検索の別名（表記ゆれ・現地名・英語名）。表示には使わない
    aliases = {}
    for a in rows("SELECT * FROM search_aliases"):
        aliases[(a["kind"], a["target_id"])] = (aliases.get((a["kind"], a["target_id"]), "") + " " + a["words"]).strip()
    ranges = {}
    for r in rows("SELECT * FROM mountain_ranges"):
        ranges[r["id"]] = dict(id=r["id"], name=disp(r, lang, with_ja=False), name_ja=r["name_ja"], name_en=r["name_en"],
                               slug=r["id"].replace("_", "-"), zone=zones.get(r["zone_id"]),
                               country=countries.get(r["country"]) or countries.get("JP"))
    # 英語版で日本語名を括弧で残すのは日本の小屋・登山口だけ（現地で見せるため）。外国は現地の公式名（name_en）だけ
    th_country = {r["tid"]: r["c"] for r in rows("""SELECT DISTINCT s.trailhead_id tid, m.country c FROM trail_stops s
        JOIN trails t ON t.id = s.trail_id JOIN mountain_ranges m ON m.id = t.range_id WHERE s.trailhead_id IS NOT NULL""")}
    areas = {a["id"]: dict(a, name=disp(a, lang, with_ja=False)) for a in rows("SELECT * FROM sub_areas")}
    operators = {o["id"]: dict(o, name=disp(o, lang, with_ja=False)) for o in rows("SELECT * FROM operators")}
    trailheads = {}
    for t in rows("SELECT * FROM trailheads"):
        t["country"] = th_country.get(t["id"], "JP")
        t["name"] = disp(t, lang, with_ja=t["country"] == "JP")
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
        h["country"] = (ranges.get(h["range_id"]) or {}).get("country", {}).get("id", "JP")
        h["range"] = ranges.get(h["range_id"])
        h["zone"] = (h["range"] or {}).get("zone") or zones[HOME_ZONE[lang]]
        h["name"] = disp(h, lang, with_ja=h["country"] == "JP")
        h["short"] = disp(h, lang, short=True)
        h["type_label"] = T["type_" + h["hut_type"]]
        h["area"] = areas.get(h["sub_area_id"])
        h["operator"] = operators.get(h["operator_id"])
        s = next(iter(rows("SELECT * FROM hut_seasons WHERE hut_id=? AND year=2026", hid)), None)
        if s:
            s["note"] = pick(s, "season_note", lang)
            s["opens"] = pick(s, "booking_opens_at", lang)
            s["terms"] = pick(s, "booking_terms", lang)
        h["season"] = s
        # 次の年（2027）の営業期間（あれば）
        sn = next(iter(rows("SELECT * FROM hut_seasons WHERE hut_id=? AND year=2027", hid)), None)
        if sn:
            sn["note"] = pick(sn, "season_note", lang)
        h["season_next"] = sn
        # 例年の営業期間（年の書いていない公式の案内）。「6月中旬〜9月下旬」の形で出す
        u = next(iter(rows("SELECT * FROM hut_usual_seasons WHERE hut_id=?", hid)), None)
        if u:
            u["note_t"] = pick(u, "note", lang)
            u["label"] = usual_label(u, lang)
        h["usual"] = u
        # 予約の窓口。小屋が自分で案内している窓口だけ（hut_booking_channels の注記を参照）
        h["channels"] = rows("SELECT * FROM hut_booking_channels WHERE hut_id=? AND year=2026 ORDER BY seq", hid)
        for c in h["channels"]:
            c["label"] = T["plan_js_ch_email" if c["kind"] == "email" else
                           "plan_js_ch_hut_form" if c["operator"] == "hut" and c["kind"] == "form"
                           else "plan_js_ch_" + c["operator"]]
            if c["kind"] == "email":
                c["label"] += " " + c["url"][len("mailto:"):]
            c["href"] = c["url_en"] if lang == "en" and c["url_en"] else c["url"]
            c["note_t"] = pick(c, "note", lang)
            c["english_label"] = T["plan_js_ch_en_" + c["english"] + ("_world" if h["country"] != "JP" and c["english"] == "no" else "")]
            # 旅行会社への案内は小屋への送客ではない。送客率（outbound_）に混ぜない
            c["track"] = "agency_link" if c["kind"] == "agency" else "reservation"
        h["rates"] = rows("SELECT * FROM hut_rates WHERE hut_id=? AND year=2026 "
                          "ORDER BY CASE plan_type WHEN 'two_meals' THEN 0 WHEN 'one_meal' THEN 1 "
                          "WHEN 'no_meal' THEN 2 WHEN 'private_room' THEN 3 WHEN 'tent' THEN 4 ELSE 5 END", hid)
        for r in h["rates"]:
            # 日本の「1泊2食」は、日本の外ではハーフボード（夕食・朝食つき）と呼ぶ
            r["label"] = T["plan_" + r["plan_type"] + ("_world" if h["country"] != "JP" and T.get("plan_" + r["plan_type"] + "_world") else "")]
            r["note_t"] = r.get("note_en") if lang == "en" and r.get("note_en") else r.get("note_ja")
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
        # 断面図の横軸。コースタイムが揃っていれば累積時間、欠けていれば行程順（等間隔）。
        # 標高さえ分かれば形は描ける。描かない理由にはしない。
        for i, p in enumerate(pts):
            p["x"] = p["t"] if t["times_known"] else i
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
                f = (p["x"] - a["x"]) / (b["x"] - a["x"]) if b["x"] != a["x"] else 0
                p["y"] = round(a["elev"] + (b["elev"] - a["elev"]) * f)
        return pts

    def summarize(pts):
        known = [p for p in pts if p["elev"] is not None]
        if not known:
            return None
        top = max(known, key=lambda p: p["elev"])
        gain = sum(b["elev"] - a["elev"] for a, b in zip(known, known[1:]) if b["elev"] > a["elev"])
        # 「◯◯から N m 登る」は、登山口から登り始めるルートにだけ意味がある。
        # 稜線から始まって里に下りる縦走（大キレット等）では出さない。
        first_th = next((p for p in pts if p["kind"] == "trailhead" and p["elev"] is not None), None)
        start = first_th if first_th is pts[0] or (first_th and first_th["seq"] == pts[0]["seq"]) else None
        return dict(top=top, gain=gain, start=start,
                    climb=(top["elev"] - start["elev"]) if start else None,
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
                # 時刻が無いルートは標高の内挿も当てにならない。登り下りは出さない
                ys = [x["y"] for x in seg if x["y"] is not None] if t["times_known"] else []
                for a, b in zip(ys, ys[1:]):
                    if b > a:
                        up += b - a
                    else:
                        down += a - b
                # 時刻が未確認のルートは区間時間も出さない（0 分と書かない）
                mins = q["t"] - p["t"] if t["times_known"] else None
                # 公式の区間時間が無ければ、式の目安（線と標高から）。登り・下りも線から
                est_min = None
                if mins is None and t.get("est"):
                    xs = [x for x in t["est"]["legs"] if p["seq"] <= x["a"][3] and x["b"][3] <= q["seq"]]
                    if xs:
                        est_min = round(sum(x["min"] for x in xs) / 5) * 5
                        if not t["times_known"]:
                            up, down, est = sum(x["U"] for x in xs), sum(x["D"] for x in xs), False
                out.append(dict(row="leg", minutes=mins, est_min=est_min, up=up, down=down, est=est,
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
            # 標高が未確認なのは小屋とは限らない（登山口・通過点もある）。
            # ここで kind を絞ると、その行を数値として書式化しようとして落ちる
            if p["elev"] is None or p["est"]:
                txt = f"{p['short']} {T.unknown}"
            elif compact:
                txt = p["short"]
            else:
                txt = f"{p['short']} {p['elev']:,}m"
            labels.append(dict(p=p, text=txt, size=fs if p["kind"] == "hut" else fs_small,
                               w=_label_w(txt, fs if p["kind"] == "hut" else fs_small)))
        ml, mr, mb = (40 if compact else 52), 14, (20 if compact else 24)
        xmax = max(p["x"] for p in pts) or 1
        inner_w = width - ml - mr

        def X(tm):
            return ml + inner_w * tm / xmax

        order = sorted(labels, key=lambda l: l["p"]["x"])
        tiers = []
        for l in order:
            cx = X(l["p"]["x"])
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
        # 横軸が行程順のときは時刻の目盛りを打たない（歩いた時間に見えてしまう）
        xstep = (180 if compact else 120) if t["times_known"] else 0
        tm = 0
        while xstep and tm <= xmax:
            x = X(tm)
            out.append(f'<line class="p-tick" x1="{x:.1f}" x2="{x:.1f}" y1="{height - mb}" y2="{height - mb + 4}"/>')
            lab = f"{tm // 60}h" if (compact or lang == "en") else (f"{tm // 60}時間" if tm else T.start)
            if tm == 0 and not compact and lang == "ja":
                lab = T.start
            anchor = "start" if tm == 0 else "middle"
            out.append(f'<text class="p-axis" x="{x:.1f}" y="{height - mb + 14}" text-anchor="{anchor}" font-size="{fs_small}">{lab}</text>')
            tm += xstep
        out.append(f'<text class="p-axis" x="{ml - 6}" y="{mt - 4}" text-anchor="end" font-size="{fs_small}">m</text>')
        d = " ".join(f"{X(p['x']):.1f},{Y(p['y']):.1f}" for p in pts)
        base = height - mb
        out.append(f'<polygon class="p-area" points="{X(pts[0]["x"]):.1f},{base} {d} {X(pts[-1]["x"]):.1f},{base}"/>')
        out.append(f'<polyline class="p-line" points="{d}"/>')
        for l in order:
            p = l["p"]
            x, y = X(p["x"]), Y(p["y"])
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
            hut_attr = f' data-hut="{p["hut"]["id"]}"' if p["kind"] == "hut" and p.get("hut") else ""
            out.append(f'<a class="{cls}" href="#stop-{p["seq"]}" data-seq="{p["seq"]}"{hut_attr}><title>{escape(title)}</title>')
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
        xmax = max(p["x"] for p in pts) or 1
        ys = [p["y"] for p in pts]
        ymin, ymax = min(ys) - 150, max(ys) + 120
        pad = 8
        X = lambda tm: pad + (width - 2 * pad) * tm / xmax
        Y = lambda e: pad + (height - 2 * pad) * (1 - (e - ymin) / (ymax - ymin))
        d = " ".join(f"{X(p['x']):.1f},{Y(p['y']):.1f}" for p in pts)
        out = [f'<svg class="mini-profile" viewBox="0 0 {width} {height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">',
               f'<polygon class="p-area" points="{X(pts[0]["x"]):.1f},{height} {d} {X(pts[-1]["x"]):.1f},{height}"/>',
               f'<polyline class="p-line" points="{d}"/>']
        for p in pts:
            x, y = X(p["x"]), Y(p["y"])
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
        _first = {}
        for s in t["stops"]:
            s["hut"] = huts.get(s["hut_id"])
            s["trailhead"] = trailheads.get(s["trailhead_id"])
            # 往復ルートの帰りに同じ小屋を通る: 2 回目は「行きと同じ小屋」として 1 行だけ（一覧・カードを重ねない）
            s["again_of"] = _first.get(s["hut_id"]) if s["hut_id"] else None
            if s["hut_id"] and s["hut_id"] not in _first:
                _first[s["hut_id"]] = s["seq"]
            if s["hut"] and not s["again_of"]:
                s["hut"]["trails"].append(t)
        # コースタイムは区間ごとの公式記載が無いルートがある。断面図は横軸が累積時間なので、
        # 1つでも欠けていれば描かない（0 で埋めると嘘の形になる）。行程の並びだけは出す。
        t["times_known"] = all(s["cumulative_time_min"] is not None for s in t["stops"])
        t["total_min"] = max(s["cumulative_time_min"] or 0 for s in t["stops"]) if t["times_known"] else None
        t["hut_count"] = sum(1 for s in t["stops"] if s["hut"] and s["is_overnight_candidate"])
        # 区間のコースタイムが欠けていても、長野県の表と同じ行程なら表の「合計コースタイム」を歩行時間として出す（出典つき）
        _g = rows("SELECT course_time_h, source_url FROM trail_grading WHERE trail_id=? AND match='same' AND course_time_h IS NOT NULL", t["id"])
        t["official_min"] = round(_g[0]["course_time_h"] * 60) if _g else None
        t["official_url"] = _g[0]["source_url"] if _g else None
        # ページの最初に出す「3つの答え」（どれくらい大変か・どう行くか・予約）の材料
        _gr = rows("SELECT * FROM trail_grading WHERE trail_id=?", t["id"])
        t["grading"] = _gr[0] if _gr else None
        if t["grading"]:   # 出典の表の名前（県ごとに違う）。英語は県名から
            _g = t["grading"]
            _sn = _g["source_name"]
            _en = next((v for k, v in GRADING_EN.items() if _sn.startswith(k)), "prefectural mountain grading")
            _g["src_short"] = (re.sub(r"（[^）]*）$", "", _sn).strip() if _g["system"] == "jp_pref" else _sn) if lang == "ja" else _en
            # カードの札。区分が国で違うので混ぜない（県の表は体力度・難易度、観光局・CAI は難易度の言葉だけ）
            _g["chip"] = (f"{T.ans_stamina} {_g['stamina']}{T.mid}{T.ans_tech} {_g['technical']}" if _g["system"] == "jp_pref"
                          else f"{T.ans_tech} {T['grade_' + _g['technical']]}")
        _ths = [s["trailhead"] for s in t["stops"] if s["trailhead"]]
        t["start_th"] = _ths[0] if _ths else None
        t["end_th"] = _ths[-1] if len(_ths) > 1 and _ths[-1]["id"] != _ths[0]["id"] else None
        t["access"] = rows("SELECT * FROM access_routes WHERE trailhead_id=?", t["start_th"]["id"]) if t["start_th"] else []
        for _a in t["access"]:
            _a["from_t"] = pick(_a, "from_place", lang)
        t["car_restricted"] = any(_a["private_car_restricted"] for _a in t["access"])
        t["public_modes"] = [m for m in ("train", "bus", "shuttle", "ropeway", "ferry")
                             if any(_a["mode"] == m for _a in t["access"])]
        t["public_from"] = [_a["from_t"] for _a in t["access"] if _a["mode"] in ("bus", "train", "shuttle") and _a["from_t"]]
        _seen_h, t["stays"] = set(), []
        for s in t["stops"]:
            if s["hut"] and s["is_overnight_candidate"] and s["hut_id"] not in _seen_h:
                _seen_h.add(s["hut_id"])
                t["stays"].append(s["hut"])
        # 「いつ泊まれる？」の帯: 4/1〜11/30 を横幅いっぱいにして、泊まれる小屋の営業期間（2026 年）を並べる。
        #  日付の分からない小屋は帯を描かない（未確認と書く）。今日の線と色は見ている人の端末の日付で site.js が付け直す
        t["gantt"] = []
        for h in t["stays"]:
            se = h["season"] or {}
            bar = None
            if se.get("status") == "year_round":
                bar = (0, 100)
            elif se.get("status") == "open" and se.get("open_date") and se.get("close_date"):
                a = max(GANTT_W0, datetime.date.fromisoformat(se["open_date"]))
                b = min(GANTT_W1, datetime.date.fromisoformat(se["close_date"]))
                if b >= a:
                    bar = (round((a - GANTT_W0).days / GANTT_SPAN * 100, 2), round(((b - a).days + 1) / GANTT_SPAN * 100, 2))
            t["gantt"].append(dict(hut=h, bar=bar, status=se.get("status"), open=se.get("open_date"), close=se.get("close_date"),
                                   now=bool(se.get("status") == "year_round" or (se.get("open_date") and se.get("close_date")
                                                                                    and se["open_date"] <= TODAY <= se["close_date"]))))
        # 下山口の乗り物（縦走で出口が違うとき）
        t["end_access"] = rows("SELECT * FROM access_routes WHERE trailhead_id=?", t["end_th"]["id"]) if t["end_th"] else []
        t["end_modes"] = [m for m in ("train", "bus", "shuttle", "ropeway", "ferry", "taxi")
                          if any(_a["mode"] == m for _a in t["end_access"])]
        t["end_car_restricted"] = any(_a["private_car_restricted"] for _a in t["end_access"])
        t["poster"] = (ROOT / "static" / "img" / "routes" / f"{t['id']}.jpg").exists()   # tools/route_posters.mjs が作る 3D の静止画
        t["range"] = ranges.get(t.get("range_id"))
        _tp = ROOT / "trail_paths" / f"{t['id']}.json"
        # 線が OpenStreetMap 由来（ODbL）。地図の出どころ・出典表示を切り替え、GPX は配らない（docs/REGIONS.md）
        t["osm"] = _tp.exists() and json.loads(_tp.read_text(encoding="utf-8")).get("source_kind") == "osm"
        # トップのカード: 検索の文字（日英の名前・小屋・山頂・登山口）、季節、泊まる小屋の営業期間
        _words = [t["name_ja"], t.get("name_en") or "", t["summary_t"] or ""]
        t["zone"] = (t["range"] or {}).get("zone") or zones[HOME_ZONE[lang]]
        if t["range"]:
            # 山域・地方・国の名前と別名も探す文字に入れる（「イタリア」「アルプス」「海外」で当たる）
            _z, _c = t["range"]["zone"] or {}, t["range"]["country"]
            _words += [t["range"]["name_ja"], t["range"]["name_en"] or "", aliases.get(("range", t["range"]["id"]), ""),
                       _z.get("name_ja", ""), _z.get("name_en") or "", aliases.get(("zone", _z.get("id")), ""),
                       _c["name_ja"], _c["name_en"] or "", "海外" if _c["id"] != "JP" else ""]
        _words.append(aliases.get(("trail", t["id"]), ""))
        for s in t["stops"]:
            if s["hut_id"]:
                _words += [r["name_ja"] + " " + (r["name_en"] or "") for r in rows("SELECT name_ja,name_en FROM huts WHERE id=?", s["hut_id"])]
                _words.append(aliases.get(("hut", s["hut_id"]), ""))
            elif s["trailhead_id"]:
                _words += [r["name_ja"] + " " + (r["name_en"] or "") for r in rows("SELECT name_ja,name_en FROM trailheads WHERE id=?", s["trailhead_id"])]
            elif s.get("label"):
                _words.append((s["label"] or "") + " " + (s.get("label_en") or ""))
        t["search"] = " ".join(dict.fromkeys(w for w in _words if w))
        t["seasons_json"] = json.dumps([dict(k=r["kind"], s=r["start_md"], e=r["end_md"], l=(r["label_en"] if lang == "en" and r["label_en"] else r["label_ja"]),
                                             src=r["source_name"], u=r["source_url"])
                                        for r in rows("SELECT * FROM trail_seasons WHERE trail_id=?", t["id"])],
                                       ensure_ascii=False, separators=(",", ":"))
        t["stays_json"] = json.dumps([[(h["season"] or {}).get("status"), (h["season"] or {}).get("open_date"),
                                       (h["season"] or {}).get("close_date")] for h in t["stays"]], separators=(",", ":"))
        t["routes_json"] = json.dumps([dict(n=t["nights_typical"] or 0, s=(t["grading"] or {}).get("stamina"),
                                            t=(t["grading"] or {}).get("technical"), p=1 if t["public_modes"] else 0)], separators=(",", ":"))
        t["photos"] = [p for p in photos if p["trail_id"] == t["id"] and p["role"] == "trail"]
        t["points"] = build_points(t)
        # 標高が分かれば断面図は描ける。コースタイムが無い場合は横軸を行程順にする
        t["profile"] = summarize(t["points"])
        # 標準タイム（式）。長野県の表と同じ行程なら、表の合計コースタイムに合わせて区間に配る
        _sp = []
        for s in t["stops"]:
            p = s["hut"] or s["trailhead"]
            if p and p.get("lat") and p.get("lon"):
                _sp.append((s["hut_id"] or s["trailhead_id"], p["lat"], p["lon"], s["seq"],
                            p.get("short") or p["name"], "hut" if s["hut"] else "th"))
            elif s.get("label") and s.get("lat") is not None:
                _sp.append(("pk:" + s["label"], s["lat"], s["lon"], s["seq"], pick(s, "label", lang), "peak"))
        _est = course_estimate(t["id"], _sp)
        t["est"], t["track"] = None, ""
        if _est:
            _raw = sum(x["h"] for x in _est) * 60
            _k = t["official_min"] / _raw if t["official_min"] else 1.0
            for x in _est:
                x["min"] = x["h"] * 60 * _k
            t["est"] = dict(legs=_est, total=round(_raw * _k / 5) * 5, scaled=bool(t["official_min"]),
                            km=sum(x["L"] for x in _est) / 1000, up=sum(x["U"] for x in _est), down=sum(x["D"] for x in _est))
            t["track"] = json.dumps(track_of(_est), ensure_ascii=False, separators=(",", ":"))
        t["rows"] = build_legs(t, t["points"])
        t["svg_wide"] = profile_svg(t, t["points"], 720, 300)
        t["svg_narrow"] = profile_svg(t, t["points"], 360, 250, compact=True)
        t["svg_mini"] = profile_mini_svg(t, t["points"])
        # 地図に引く線。小屋・登山口の座標を行程順に結んだだけのもので、登山道そのものではない
        stop_pts = []
        for s in t["stops"]:
            p = s["hut"] or s["trailhead"]
            if p and p.get("lat") and p.get("lon"):
                stop_pts.append((s["hut_id"] or s["trailhead_id"], p["lat"], p["lon"]))
            elif s.get("label") and s.get("lat") is not None:   # 山頂・コル（tools/trail_paths.py と同じ id）
                stop_pts.append(("pk:" + s["label"], s["lat"], s["lon"]))
        line, t["legs_traced"], t["legs_total"] = trail_line(t["id"], stop_pts)
        t["line_pts"] = line
        t["map_line"] = ";".join(f"{la:.6f},{lo:.6f}" for la, lo in line)
        # 「地図（3D）」に出す点: 小屋・登山口・山頂（位置のあるものだけ、同じ点は 1 回）
        _pts, _seen = [], set()
        for s in t["stops"]:
            p = s["hut"] or s["trailhead"]
            if p and p.get("lat"):
                k, n, la, lo, el = ("hut" if s["hut"] else "th"), p["name"], p["lat"], p["lon"], p.get("elevation_m")
                pid = s["hut_id"] or s["trailhead_id"]
            elif s.get("label") and s.get("lat") is not None:
                k, n, la, lo, el = "peak", pick(s, "label", lang), s["lat"], s["lon"], s.get("elevation_m")
                pid = None
            else:
                continue
            if (la, lo, n) in _seen:
                continue
            _seen.add((la, lo, n))
            _pts.append({"k": k, "n": n, "lat": round(la, 6), "lon": round(lo, 6), "e": el, **({"id": pid} if pid else {})})
        t["map_points"] = json.dumps(_pts, ensure_ascii=False, separators=(",", ":"))
        t["has_gpx"] = t["legs_total"] > 0 and t["legs_traced"] == t["legs_total"] and not t["osm"]
        t["gsi3d"] = gsi3d_url(t["map_line"])
        trails.append(t)

    # 山から探す: ルートの通過点のうち山頂（名前が 岳・山・峰 で終わり、位置と標高のあるもの）を「山」としてまとめる。
    # 同じ山に登るルートが 1 つのページに並ぶ。乗越・コル・独標は山にしない
    MT_ALIAS = {"富士山（剣ヶ峰）": ("富士山", "Mount Fuji"), "西天狗岳": ("天狗岳", "Tengudake"),
                "乗鞍岳（剣ヶ峰）": ("乗鞍岳", "Norikuradake"), "谷川岳（トマの耳）": ("谷川岳", "Tanigawadake"), "鳥海山（新山）": ("鳥海山", "Chokaisan")}
    mountains = {}
    for t in trails:
        for s in t["stops"]:
            lb = s.get("label")
            if not lb or s.get("lat") is None or not s.get("elevation_m"):
                continue
            ja, en = MT_ALIAS.get(lb, (lb, s.get("label_en") or lb))
            if not re.search(r"(岳|山|峰)$", ja):
                continue
            mid = re.sub(r"[^a-z0-9]+", "-", en.lower()).strip("-")
            m = mountains.setdefault(mid, dict(id=mid, name_ja=ja, name_en=en, elev=s["elevation_m"], lat=s["lat"], lon=s["lon"],
                                               trails=[], range=t.get("range")))
            if s["elevation_m"] > m["elev"]:
                m.update(elev=s["elevation_m"], lat=s["lat"], lon=s["lon"])
            if all(x["id"] != t["id"] for x in m["trails"]):
                m["trails"].append(t)
    for m in mountains.values():
        _jp = (m["range"] or {}).get("country", {}).get("id", "JP") == "JP"
        m["name"] = m["name_ja"] if lang == "ja" else (f"{m['name_en']} ({m['name_ja']})" if _jp else m["name_en"])
        m["zone"] = (m["range"] or {}).get("zone") or zones[HOME_ZONE[lang]]
        m["short"] = m["name_ja"] if lang == "ja" else m["name_en"]
        # いちばん軽いルート（体力度の小さい順、無ければ日数の少ない順）を先に
        # 歩く時間の短い順（公式の合計 → 県の表の合計 → 式の目安）。時間が無ければ体力度
        m["trails"].sort(key=lambda t: ((t["total_min"] if t["times_known"] else t.get("official_min") or (t.get("est") or {}).get("total") or 99999),
                                        (t.get("grading") or {}).get("stamina") or 99))
        m["easiest"] = m["trails"][0]
        seen, m["huts"] = set(), []
        for t in m["trails"]:
            for h in t["stays"]:
                if h["id"] not in seen:
                    seen.add(h["id"]); m["huts"].append(h)

    # 山の説明・アイキャッチ・絞り込み用のデータ。説明は確かめられる事実だけで組む（名山の区分・標高の順位・いちばん軽いルート・小屋の数）
    _meta = {r["id"]: r for r in rows("SELECT * FROM mountain_meta")}

    def _walk(t):
        if t["times_known"]:
            return fmt_time(t["total_min"])
        if t.get("official_min"):
            return fmt_time(t["official_min"])
        return (T.approx + fmt_time(t["est"]["total"])) if t.get("est") else None

    def _is_top(m, t):
        tops = [s for s in t["stops"] if s.get("label") and s.get("elevation_m")]
        if not tops:
            return False
        top = max(tops, key=lambda s: s["elevation_m"])["label"]
        return MT_ALIAS.get(top, (top,))[0] == m["name_ja"]

    for m in mountains.values():
        m["meta"] = _meta.get(m["id"])
        key = m["name_ja"].replace("ヶ", "").replace("ケ", "")
        named = lambda p: key in (p["alt"] or "").replace("ヶ", "").replace("ケ", "")
        own = [p for t in m["trails"] if _is_top(m, t) for p in t["photos"]]
        allp = [p for t in m["trails"] for p in t["photos"]]
        m["photo"] = next((p for p in own if named(p)), None) or next((p for p in allp if named(p)), None) or (own[0] if own else None)
        m["poster"] = next((t["id"] for t in m["trails"] if t.get("poster")), None)
        m["minor"] = not any(_is_top(m, t) for t in m["trails"])   # どのルートでも最高地点でない山（通過点）は、おすすめ順で少し後ろへ
        e = m["easiest"]
        g = e.get("grading")
        days = T.nights.format(n=e["nights_typical"], m=e["nights_typical"] + 1) if e["nights_typical"] else T.ans_day_trip
        start = re.sub(r"\s*[（(].*$", "", (e.get("start_th") or {}).get("short") or "") or None
        parts = []
        if m["meta"] and m["meta"]["meizan"]:
            note = pick(m["meta"], "meizan_note", lang)
            parts.append(T["meizan_" + m["meta"]["meizan"]] + (T.mt_d_note.format(note=note) if note else "") + T.mt_d_stop)
        if m["meta"] and pick(m["meta"], "fact", lang) if m["meta"] and lang == "en" else (m["meta"] and m["meta"]["fact_ja"]):
            parts.append((m["meta"]["fact_en"] if lang == "en" and m["meta"]["fact_en"] else m["meta"]["fact_ja"]) + T.mt_d_stop)
        w = _walk(e)
        parts.append(T.mt_d_route.format(start=start or T.unknown, days=days, time=w or T.unknown)
                     + (T.mt_d_grade.format(s=g["stamina"], t=g["technical"]) if g and g["system"] == "jp_pref" else "") + T.mt_d_stop)
        if len(m["trails"]) > 1:
            parts.append(T.mt_d_routes.format(n=len(m["trails"])) + T.mt_d_stop)
        if m["huts"]:
            parts.append(T.mt_d_huts.format(n=len(m["huts"])) + T.mt_d_stop)
        m["desc"] = T.mt_d_join.join(parts)
        m["routes_json"] = json.dumps([dict(n=t["nights_typical"] or 0, s=(t.get("grading") or {}).get("stamina"),
                                            t=(t.get("grading") or {}).get("technical"), p=1 if t["public_modes"] else 0)
                                       for t in m["trails"]], separators=(",", ":"))
        seen_s, ss = set(), []
        for t in m["trails"]:
            for s in json.loads(t["seasons_json"]):
                if (s["k"], s["l"]) not in seen_s:
                    seen_s.add((s["k"], s["l"])); ss.append(s)
        m["seasons_json"] = json.dumps(ss, ensure_ascii=False, separators=(",", ":"))
        m["stays_json"] = json.dumps([[(h["season"] or {}).get("status"), (h["season"] or {}).get("open_date"),
                                       (h["season"] or {}).get("close_date")] for h in m["huts"]], separators=(",", ":"))

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

    return dict(T=T, huts=huts, trails=trails, areas=areas, photos=photos, client=client, mountains=mountains,
                trailheads=trailheads, ranges=ranges, zones=zones, countries=countries, aliases=aliases,
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


# ---------------------------------------------------------------- transit
# 登山口ごとの「行き方と帰りの最終便」。年1回の更新で維持できる粒度だけを持つ:
# 運行期間・始発・最終・所要・運賃・間隔・注意フラグ。便ごとの時刻は公式時刻表へ送る。
TRANSIT_YEAR = 2026


def transit_model(lang):
    ops = {o["id"]: o for o in rows("SELECT * FROM transit_operators")}
    lines = {}
    for ln in rows("SELECT * FROM transit_lines"):
        ln["name"] = disp(ln, lang)
        ln["note"] = pick(ln, "note", lang)
        op = ops.get(ln["operator_id"])
        ln["operator"] = dict(op, name=disp(op, lang, with_ja=False)) if op else None
        ln["periods"] = []
        lines[ln["id"]] = ln
    for p in rows("SELECT * FROM transit_periods WHERE year=? ORDER BY start_date", TRANSIT_YEAR):
        p["name"] = disp(p, lang, with_ja=False)
        p["note"] = pick(p, "note", lang)
        p["headway_note"] = pick(p, "headway_note", lang)
        p["year_round"] = p["start_date"].endswith("-01-01") and p["end_date"].endswith("-12-31")
        if p["line_id"] in lines:
            lines[p["line_id"]]["periods"].append(p)

    gateways = []
    for st in rows("SELECT * FROM transit_stops WHERE trailhead_id IS NOT NULL"):
        th = next(iter(rows("SELECT * FROM trailheads WHERE id=?", st["trailhead_id"])), None)
        if not th:
            continue
        th["name"] = disp(th, lang)
        th["parking"] = pick(th, "parking_note", lang)
        # その登山口に着く停留所を通る路線。停留所を直接持たない路線も、乗継でつながるものを拾う
        # 乗継でつながる停留所まで含めて「この登山口に来る路線」とする
        conn = rows("SELECT * FROM transit_connections WHERE to_stop_id=? OR from_stop_id=?", st["id"], st["id"])
        near = {st["id"]} | {c["from_stop_id"] for c in conn} | {c["to_stop_id"] for c in conn}
        ls = []
        for ln in lines.values():
            stops = rows("SELECT s.*, ls.seq FROM transit_line_stops ls JOIN transit_stops s ON s.id=ls.stop_id"
                         " WHERE ls.line_id=? ORDER BY ls.seq", ln["id"])
            if ln["periods"] and any(s["id"] in near for s in stops):
                ln = dict(ln, stops=[dict(s, name=disp(s, lang)) for s in stops])
                ls.append(ln)
        ls.sort(key=lambda l: l["mode"] != "bus")   # 里から順に読めるよう、バスを先に
        gateways.append({"th": th, "stop": st, "lines": ls, "conn": conn})
    return {"gateways": gateways, "lines": lines}


# ---------------------------------------------------------------- render
env = Environment(loader=FileSystemLoader(ROOT / "templates", encoding="utf-8"),
                  autoescape=select_autoescape(["html"]))
env.globals.update(SITE_URL=SITE_URL, BASE=BASE, ANALYTICS=ANALYTICS, API_URL=API_URL, TODAY=TODAY,
                   GANTT_TICKS=GANTT_TICKS, GANTT_W0=GANTT_W0.isoformat(), GANTT_W1=GANTT_W1.isoformat())

DIST.mkdir(exist_ok=True)
for p in DIST.iterdir():
    shutil.rmtree(p) if p.is_dir() else p.unlink()
shutil.copytree(ROOT / "static", DIST / "static")

urls = []
th_urls = []        # 登山口ページ
article_urls = []   # (url, 相手言語版があるか, 更新日)


def th_urls_for(prefix):
    return [u for u in th_urls if u.startswith(prefix + "/trailheads/") or (not prefix and u.startswith("/trailheads/"))]


def write(path, tpl, **ctx):
    out = DIST / path
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(env.get_template(tpl).render(**ctx), encoding="utf-8")


FLY_ROUTES = {}
for lang, prefix in LOCALES:
    m = build_model(lang)
    # 記事の日付は年をまたぐので年まで出す（小屋の営業期間は年が自明なので fmt_date は月日だけ）
    fmt_ymd = (lambda d: f"{d[:4]}年{m['fmt_date'](d)}") if lang == "ja" else (lambda d: f"{m['fmt_date'](d)} {d[:4]}")
    env.filters.update(fmt_time=m["fmt_time"], fmt_date=m["fmt_date"], yen=yen, money=money, fmt_ymd=fmt_ymd,
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
    # 試作 /lab/flyover/ 用のルート（線と、座標のある小屋・登山口）。言語ごとの名前だけ足していく
    for t in trails_l:
        r = FLY_ROUTES.setdefault(t["id"], {
            "id": t["id"], "name": {}, "traced": t["legs_total"] > 0 and t["legs_traced"] == t["legs_total"],
            "course_min": t["total_min"],   # 公式のコースタイムの合計（区間が欠けていれば None）。エネルギー収支の行動時間に使う
            "official_min": t.get("official_min"),   # 長野県の表の合計コースタイム（同じ行程のときだけ）
            "line": [[round(a, 6), round(b, 6)] for a, b in t["line_pts"]],
            "stops": [{"id": s["hut_id"] or s["trailhead_id"], "kind": "hut" if s["hut"] else "trailhead", "name": {},
                       "lat": p["lat"], "lon": p["lon"], "elev": p["elevation_m"]}
                      for s in t["stops"] for p in [s["hut"] or s["trailhead"]] if p and p.get("lat") and p.get("lon")]})
        r["name"][lang] = t["name"]
        if "photos" not in r:
            # 写真の場所: 位置情報が道から 3km 以内ならそこ、無ければ山頂（いちばん高い通過点）。動画の中で写真を出す所
            _tops = sorted([s for s in t["stops"] if s.get("label") and s.get("lat") is not None and s.get("elevation_m")],
                           key=lambda s: -s["elevation_m"])
            _top = (_tops[0]["lat"], _tops[0]["lon"]) if _tops else t["line_pts"][len(t["line_pts"]) // 2]
            r["photos"] = []
            for p in t["photos"]:
                ll = (p["lat"], p["lon"]) if p.get("lat") is not None else None
                if ll and min(_hav_m(ll, q) for q in t["line_pts"][::5] + [t["line_pts"][-1]]) > 3000:
                    ll = None
                who = (p["credit"] or "").replace("撮影：", "").strip()
                r["photos"].append({"u": f"{BASE}/static/img/{p['file']}.jpg", "lat": (ll or _top)[0], "lon": (ll or _top)[1],
                                    "cap": p["alt"], "cr": "Photo: " + who + (" / " + p["license"] if p.get("license") else "")})
        for st, s in zip(r["stops"], [s for s in t["stops"] if (s["hut"] or s["trailhead"]) and (s["hut"] or s["trailhead"]).get("lat")]):
            st["name"][lang] = (s["hut"] or s["trailhead"])["name"]

    arts = ARTICLES[lang]
    for h in huts_l:
        h["articles"] = [a for a in arts if h["id"] in a["huts"]]
    for t in trails_l:
        t["articles"] = [a for a in arts if t["id"] in a["trails"]]
    g["HAS_ARTICLES"] = bool(arts)

    # トップの「エリア」: ルートのある山域だけ、ルートの多い順
    _rc = {}
    for _t in trails_l:
        if _t["range"]:
            _rc.setdefault(_t["range"]["id"], [_t["range"], 0])[1] += 1
    _ranges = [v[0] for v in sorted(_rc.values(), key=lambda v: -v[1])]
    # 行き先（地方）ごとにまとめる（docs/REGIONS.md）。地方の並びは zones.sort、中は山域のルートの多い順。
    # 一覧（トップ・山・小屋）はいつも 1 つの地方だけを出す。ほかの地方へは「行き先」の切り替えと検索から
    home_zone = HOME_ZONE[lang]
    zone_groups = []
    for z in m["zones"].values():
        zg = dict(zone=z, ranges=[r for r in _ranges if (r["zone"] or {}).get("id") == z["id"]],
                  trails=[t for t in trails_l if t["zone"]["id"] == z["id"]],
                  huts=[h for h in huts_l if h["zone"]["id"] == z["id"]])
        zg["n"], zg["n_huts"] = len(zg["trails"]), len(zg["huts"])
        # 入口のカードの写真: その地方の山域の写真（案内・エリア）、無ければいちばん上のルートの 3D の絵
        _rids = {r["id"] for r in zg["ranges"]}
        zg["photo"] = next((p for p in photos if p["role"] in ("teaser", "area") and p["range_id"] in _rids), None)
        zg["poster"] = next((t["id"] for t in zg["trails"] if t["poster"]), None)
        # 国の名前（地方の名前と同じとき＝日本は出さない）
        zg["countries"] = [c for c in dict.fromkeys(r["country"]["name"] for r in zg["ranges"]) if c != z["name"]]
        if zg["trails"]:
            zone_groups.append(zg)
    _slugs = [zg["zone"]["slug"] for zg in zone_groups] + [r["slug"] for r in _ranges]
    assert len(_slugs) == len(set(_slugs)), f"地方と山域の slug が重なっている: {_slugs}"
    _home = next(zg for zg in zone_groups if zg["zone"]["id"] == home_zone)
    # 山域の入口ページ /areas/<山域>/。ルートのある山域だけ作る（空のページを作らない）
    _area_pages = []
    for r in _ranges:
        r_trails = [t for t in trails_l if (t["range"] or {}).get("id") == r["id"]]
        r_huts = sorted([h for h in huts_l if h["range_id"] == r["id"]], key=lambda h: -(h["elevation_m"] or 0))
        r_mts = sorted([x for x in m["mountains"].values() if (x["range"] or {}).get("id") == r["id"]], key=lambda x: -x["elev"])
        r["n_trails"], r["n_huts"] = len(r_trails), len(r_huts)
        _area_pages.append((r, r_trails, r_huts, r_mts))
    g["ZONES"] = zone_groups
    g["HOME_ZONE"] = home_zone
    _others = [zg for zg in zone_groups if zg["zone"]["id"] != home_zone]
    write(f"{d}index.html", "index.html", trails=_home["trails"], huts=huts_l, page="/", articles=arts[:3],
          ranges=_home["ranges"], other_zones=_others, **g)
    # ほかの地方の入口 /areas/<地方>/（トップと同じ作り: 山域・探す・ルート）
    for zg in _others:
        write(f"{d}areas/{zg['zone']['slug']}/index.html", "zone.html", page=zg["zone"]["path"], zg=zg, z=zg["zone"],
              trails=zg["trails"], ranges=zg["ranges"], other_zones=[x for x in zone_groups if x is not zg], **g)
    for r, r_trails, r_huts, r_mts in _area_pages:
        write(f"{d}areas/{r['slug']}/index.html", "area.html", page=f"/areas/{r['slug']}/", r=r,
              trails=r_trails, huts=r_huts, mts=r_mts, any_osm=any(t["osm"] for t in r_trails), **g)
    write(f"{d}areas/index.html", "areas.html", page="/areas/", **g)
    # 山から探す: 山域ごとに、高い順
    _mts = sorted([x for x in m["mountains"].values() if x["zone"]["id"] == home_zone], key=lambda x: -x["elev"])
    _groups = {}
    for _m in _mts:
        _r = _m["range"] or dict(id="other", name=g["T"].mt_other)
        _groups.setdefault(_r["id"], dict(range=_r, mts=[]))["mts"].append(_m)
    write(f"{d}mountains/index.html", "mountains.html", page="/mountains/", mountains=_mts, n_routes=len(trails_l),
          ranges=[x["range"] for x in sorted(_groups.values(), key=lambda x: -len(x["mts"])) if x["range"]["id"] != "other"], **g)
    for _m in m["mountains"].values():
        write(f"{d}mountains/{_m['id']}/index.html", "mountain.html", page=f"/mountains/{_m['id']}/", m=_m, **g)
    # 小屋をさがす（料金は円）: いつもの地方の小屋だけ。ほかの地方の小屋は山域の入口ページに並ぶ
    _home_hut_ids = {h["id"] for h in _home["huts"]}
    _home_rids = {r["id"] for r in _home["ranges"]}
    write(f"{d}huts/index.html", "huts.html", huts=_home["huts"], page="/huts/",
          client_json=json.dumps([c for c in m["client"] if c["id"] in _home_hut_ids], ensure_ascii=False),
          **dict(g, areas=[a for a in g["areas"] if a["range_id"] in _home_rids]))
    # 行き先をまたぐ検索の索引（/search.json）。一覧に出ていない地方のルート・小屋・山を、探す欄から見つけられるように
    def _where(z, r):
        return " › ".join(x for x in (z["name"], (r or {}).get("name")) if x)
    _idx = [dict(k="t", n=t["name"], u=f"{g['LB']}/trails/{t['id']}/", z=t["zone"]["id"], w=_where(t["zone"], t["range"]), q=t["search"])
            for t in trails_l]
    _idx += [dict(k="h", n=h["name"], u=f"{g['LB']}/huts/{h['id']}/", z=h["zone"]["id"], w=_where(h["zone"], h["range"]),
                  q=" ".join(x for x in (h["name_ja"], h["name_en"] or "", m["aliases"].get(("hut", h["id"]), "")) if x))
             for h in huts_l]
    _idx += [dict(k="m", n=x["name"], u=f"{g['LB']}/mountains/{x['id']}/", z=x["zone"]["id"], w=_where(x["zone"], x["range"]),
                  q=f"{x['name_ja']} {x['name_en']}") for x in m["mountains"].values()]
    (DIST / f"{d}search.json").write_text(json.dumps(_idx, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    write(f"{d}about/index.html", "about.html", huts=huts_l, page="/about/", **g)
    # 行程ボードは JS 側にも文言が要る。i18n を唯一の出どころにするため、ここで渡す
    plan_strings = {k[len("plan_js_"):]: v for k, v in m["T"].items() if k.startswith("plan_js_")}
    # 行程ボードの行き先（地方）: 小屋のある地方だけ。地図の出どころは国の決まり（日本 = 地理院、日本の外 = OpenTopoMap）
    _pz = []
    for z in m["zones"].values():
        _rs = [r for r in m["ranges"].values() if (r["zone"] or {}).get("id") == z["id"]]
        if any(h["zone"]["id"] == z["id"] for h in huts_l):
            _src = "topo" if any(r["country"]["line_source"] == "osm" for r in _rs) else "gsi"
            _pz.append(dict(id=z["id"], name=z["name"], source=_src))
    # 地図で小屋を押したときの絵: 小屋の写真（role=hut）。無ければ小屋のまわりの 3D の静止画（tools/hut_posters.mjs）
    _pics = {}
    for h in huts_l:
        _ph = next((p for p in h.get("photos") or [] if p["role"] == "hut"), None)
        if _ph:
            _pics[h["id"]] = dict(src=f"/static/img/{_ph['file']}-800.jpg", kind="photo",
                                  alt=(_ph.get("alt_en") if lang == "en" else None) or _ph["alt"],
                                  credit=" ".join(x for x in (_ph.get("credit"), _ph.get("license")) if x))
        elif (ROOT / "static" / "img" / "huts" / f"{h['id']}.jpg").exists():
            _pics[h["id"]] = dict(src=f"/static/img/huts/{h['id']}.jpg", kind="3d")
    write(f"{d}plan/index.html", "plan.html", page="/plan/", plan_strings=plan_strings, plan_zones=_pz,
          plan_pics=_pics, trails=m["trails"], **g)

    tr = transit_model(lang)
    if tr["gateways"]:
        write(f"{d}access/index.html", "access.html", page="/access/", gateways=tr["gateways"], **g)
    # 登山口ページ。行程・小屋・交通が集まる場所なので、カードから飛ぶ先として要る
    by_th = {gw["th"]["id"]: gw for gw in tr["gateways"]}
    for th in m["trailheads"].values():
        gw = by_th.get(th["id"])
        th_huts = []
        for r in rows("SELECT * FROM hut_trailheads WHERE trailhead_id=?", th["id"]):
            hut = m["huts"].get(r["hut_id"])
            if hut:
                th_huts.append(dict(hut, walk_up=r["walk_time_up_min"]))
        th_trails = [t for t in m["trails"]
                     if any(s["trailhead_id"] == th["id"] for s in t["stops"])]
        if not (gw or th_huts or th_trails):
            continue
        ctx = dict(th, lines=(gw or {}).get("lines", []), conn=(gw or {}).get("conn", []),
                   huts=sorted(th_huts, key=lambda h: h["elevation_m"] or 0),
                   trails=th_trails)
        write(f"{d}trailheads/{th['id']}/index.html", "trailhead.html", th=ctx,
              page=f"/trailheads/{th['id']}/", **g)
        th_urls.append(f"{prefix}/trailheads/{th['id']}/")
    # データから作るまとめページ。手書き記事と違い seed.sql を直せば直る
    write(f"{d}booking/index.html", "booking.html", huts=huts_l, page="/booking/",
          known=sorted([h for h in huts_l if h["season"] and h["season"].get("opens")],
                       key=lambda h: ((h["area"] or {}).get("name", ""), h["name"])),
          unknown=[h for h in huts_l if not (h["season"] and h["season"].get("opens"))], **g)
    for h in huts_l:
        write(f"{d}huts/{h['id']}/index.html", "hut.html", h=h, page=f"/huts/{h['id']}/", **g)
    for t in trails_l:
        write(f"{d}trails/{t['id']}/index.html", "trail.html", t=t, page=f"/trails/{t['id']}/",
              plan_strings=plan_strings, gw=by_th.get((t["start_th"] or {}).get("id")), **g)
        if t["has_gpx"] and not d:
            (DIST / "trails" / t["id"] / "route.gpx").write_text(gpx_for(t, t["line_pts"]), encoding="utf-8")

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

    urls += th_urls_for(prefix)         + [f"{prefix}/", f"{prefix}/huts/", f"{prefix}/about/", f"{prefix}/booking/", f"{prefix}/plan/"] \
        + ([f"{prefix}/access/"] if tr["gateways"] else []) \
        + [f"{prefix}/areas/"] + [f"{prefix}/areas/{r['slug']}/" for r in _ranges] \
        + [f"{prefix}{zg['zone']['path']}" for zg in _others] \
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
#
# ライセンスは CC BY-NC 4.0（2026-09-27 に CC BY 4.0 から変更）。
# 個人・研究・AI アシスタントからの引用は今まで通り無料。商用利用（代行業者・旅行会社が
# そのまま自社サービスに組み込む等）だけ許諾が要る形にする。理由は docs/CONCEPT.md の変更記録を参照。
DATA_LICENSE = "CC BY-NC 4.0"
DATA_LICENSE_URL = "https://creativecommons.org/licenses/by-nc/4.0/"
DATA_VERSION = "2026.2"


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

    huts_out, osm_out = [], {}
    for h in rows("SELECT * FROM huts ORDER BY id"):
        hid = h["id"]
        # OSM から引いた位置・標高は ODbL。CC BY-NC の huts.json には入れず、huts-osm.json に分ける（docs/REGIONS.md）
        _osm_pos = h["position_source"] == "osm"
        _osm_ele = h["elevation_source"] == "osm"
        if _osm_pos or _osm_ele:
            osm_out[hid] = {"lat": h["lat"] if _osm_pos else None, "lon": h["lon"] if _osm_pos else None,
                            "elevation_m": h["elevation_m"] if _osm_ele else None, "osm": h["osm_ref"]}
        se = next(iter(rows("SELECT * FROM hut_seasons WHERE hut_id=? AND year=2026", hid)), None)
        fac = next(iter(rows("SELECT * FROM hut_facilities WHERE hut_id=?", hid)), None)
        a, o = areas.get(h["sub_area_id"]), ops.get(h["operator_id"])
        rec = {
            "id": hid,
            "name": _bi(h, "name"),
            "type": h["hut_type"],
            "range_id": h["range_id"],
            # 国（docs/REGIONS.md）。地図の出どころと通貨はこれで決まる
            "country": (rows("SELECT country FROM mountain_ranges WHERE id=?", h["range_id"]) or [{}])[0].get("country") or "JP",
            # 行き先（地方）。行程ボードの地図はこれで切り替える
            "zone": (rows("SELECT zone_id FROM mountain_ranges WHERE id=?", h["range_id"]) or [{}])[0].get("zone_id") or "japan",
            # 持ち主の種類（cai / sat / avs / province / private / other）。CAI・SAT の小屋だけ CAI の料金表と決まりが当てはまる
            "owner_kind": h["owner_kind"],
            "area": {"id": a["id"], "name": _bi(a, "name")} if a else None,
            "operator": {"id": o["id"], "name": _bi(o, "name"), "website": o["website"]} if o else None,
            "location": {"lat": None if _osm_pos else h["lat"], "lon": None if _osm_pos else h["lon"],
                         "elevation_m": None if _osm_ele else h["elevation_m"],
                         "elevation_source": None if _osm_ele else h["elevation_source"],
                         # 'osm' なら位置は /data/huts-osm.json（ODbL）にある
                         "position_source": h["position_source"]},
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
                    # 小屋が案内している予約の窓口。english は予約画面そのものの言語（yes/partial/no/unknown）。
                    # kind='agency' は旅行会社のパッケージで、小屋への直接の予約ではない
                    "channels": [{
                        "kind": c["kind"], "operator": c["operator"], "url": c["url"], "url_en": c["url_en"],
                        "english": c["english"], "guide_en_url": c["guide_en_url"],
                        # 申し込む前に空きが見られるページか（1）。system は予約の仕組みの名前
                        "availability": c["availability"], "system": c["system"],
                        "note": _bi(c, "note"), "provenance": _prov(c),
                    } for c in rows("SELECT * FROM hut_booking_channels WHERE hut_id=? AND year=2026 ORDER BY seq", h["id"])],
                    # 訪日ハイカーに最も価値のある項目。英語圏のどこにも構造化されていない
                    "opens_at": _bi(se, "booking_opens_at"),
                    # 上の自由文のうち、カレンダーに正確な日時を入れられる範囲だけの構造化版。
                    # rule='unknown' は「間に合う日を計算できない」の意味で、確度とは別（M1 参照）
                    "opens_rule": {
                        "rule": se["booking_opens_rule"] or "unknown",
                        "month": se["booking_opens_month"], "day": se["booking_opens_day"],
                        "offset_months": se["booking_opens_offset_months"],
                        "time": se["booking_opens_time"],
                    } if se["booking_opens_rule"] and se["booking_opens_rule"] != "unknown" else None,
                },
                "capacity": {"beds": se["capacity_beds"], "tents": se["capacity_tents"]},
                # 前払い・取り消しの決まり（小屋の公式の文言を短く）
                "booking_terms": _bi(se, "booking_terms"),
                "provenance": _prov(se),
            }
        rec["rates_2026"] = [{
            "plan": r["plan_type"], "price": r["price_jpy"],
            "currency": r.get("currency", "JPY"),
            "price_member": r["price_member"], "note": _bi(r, "note"),
            "is_from_price": bool(r["is_from_price"]), "provenance": _prov(r),
        } for r in rows("SELECT * FROM hut_rates WHERE hut_id=? AND year=2026 ORDER BY plan_type", hid)]
        s7 = next(iter(rows("SELECT * FROM hut_seasons WHERE hut_id=? AND year=2027", hid)), None)
        if s7:
            # 次の夏の営業期間（予約の窓口は season_2026.reservation にある）
            rec["season_2027"] = {"status": s7["status"], "open_date": s7["open_date"], "close_date": s7["close_date"],
                                  "note": _bi(s7, "season_note"), "provenance": _prov(s7)}
        us = next(iter(rows("SELECT * FROM hut_usual_seasons WHERE hut_id=?", hid)), None)
        if us:
            # 例年の営業期間（年の書いていない公式の案内）。part は early / mid / late（上旬・中旬・下旬）
            rec["usual_season"] = {"from_month": us["from_month"], "from_part": us["from_part"],
                                   "to_month": us["to_month"], "to_part": us["to_part"], "winter": us["winter"],
                                   "note": _bi(us, "note"), "provenance": _prov(us)}
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
        "description": ("Mountain huts in Japan and the Italian Dolomites. Every fact carries its source URL, "
                        "the date it was checked and a confidence level, so a machine can tell a confirmed "
                        "fact from a second-hand one and never has to guess."),
        "version": DATA_VERSION,
        "generated_at": TODAY,
        "license": DATA_LICENSE,
        "license_url": DATA_LICENSE_URL,
        "commercial_use": ("Requires separate permission. Personal, research and AI-assistant use "
                           "(including citing this data in an assistant's answer) is not commercial "
                           "use and needs none. Building a paid product or service on top of it does."),
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
        "files": {"huts": "/data/huts.json", "trails": "/data/trails.json", "huts_osm": "/data/huts-osm.json"},
    }
    osm_file = {
        "license": "ODbL 1.0", "license_url": "https://opendatacommons.org/licenses/odbl/1-0/",
        "attribution": "© OpenStreetMap contributors",
        "note": ("Positions and elevations of huts outside Japan, taken from OpenStreetMap. Kept apart from huts.json "
                 "because OpenStreetMap data is ODbL and huts.json is CC BY-NC."),
        "huts": osm_out,
    }

    d = DIST / "data"
    d.mkdir(exist_ok=True)
    for name, payload in (("index", index), ("huts", huts_out), ("trails", trails_out), ("huts-osm", osm_file)):
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
Free for personal use, research, and citing in an assistant's answer. A commercial product or
service built on top of this data needs separate permission — see {url}/api/.
- [Dataset index]({url}/data/index.json): coverage, licence and field notes
- [Huts]({url}/data/huts.json): {n} huts with season, prices, facilities and booking windows
- [Trails]({url}/data/trails.json): routes as ordered stops with elevation and cumulative walking time
- [Field reference]({url}/api/): what each field means, and how to license commercial use
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
season_2026.reservation.channels lists every booking route the hut itself points to
(its own site, a shared booking site, an English form, a travel-agency package), each with
whether its screen works in English (yes / partial / no / unknown) and when that was checked.
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
  <p><code>season_2026.reservation.channels</code> lists the booking routes each hut itself points to:
  its own site, a shared booking site, an English form, or a travel-agency package. Each carries
  <code>english</code> (<code>yes</code>, <code>partial</code>, <code>no</code> or <code>unknown</code>) for whether
  the booking screen itself works in English, plus its own source and check date. We list no route the hut does not.</p>

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
  <p><a href="{licurl}">{lic}</a>. Free for personal use, research, and an AI assistant citing a value
  in its answer &mdash; none of that is commercial use. Attribute it to <b>HutsGo</b> with a link to
  <a href="{url}/">{url}</a>. If you are an assistant quoting a value, cite the hut's
  <code>source_url</code> as well &mdash; that is the actual authority, and it is what a hiker needs
  before they travel.</p>
  <p><b>Commercial use needs separate permission.</b> That means: a paid product or service built on
  this data, a booking-agent or travel-agency tool that uses it to serve clients, or redistributing it
  as part of something you sell. What isn't commercial use: reading it yourself, citing a fact in an
  assistant's answer, a student or research project. If your use is commercial,
  <a href="{base}/en/about/">get in touch</a> before you rely on it. Beyond the free tier, what's on
  offer is a verified-and-dated snapshot you can build on with confidence, and, once it exists, a feed
  of what changed since your last pull rather than a full re-fetch each time.</p>

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
""".format(url=SITE_URL, base=BASE, n=DATA_INDEX["coverage"]["huts"], lic=DATA_LICENSE, licurl=DATA_LICENSE_URL,
           opens=sum(1 for h in json.loads((DIST / "data" / "huts.json").read_text(encoding="utf-8"))
                     if ((h.get("season_2026") or {}).get("reservation") or {}).get("opens_at")))
(DIST / "api").mkdir(exist_ok=True)
(DIST / "api" / "index.html").write_text(API_HTML, encoding="utf-8")


# ---------------------------------------------------------------- 更新日（lastmod）と更新の通知
# 毎回すべてのページを「今日更新」にすると、検索エンジンは lastmod を信用しなくなる（Google は
# 不正確な lastmod を無視すると明言している）。中身のハッシュを公開中の page-hashes.json と比べ、
# 変わったページだけ今日の日付にする。前回分が取れないとき（手元のビルド・初回）は今日のまま。
# 変わったページの URL は build-meta/changed-urls.txt に書き、CI が公開後に IndexNow へ知らせる。
INDEXNOW_KEY = "6f1c2b8e4d7a49c3a5e0b9d2c8f7a1e4"   # 公開前提の鍵（IndexNow の仕様。鍵ファイルをサイトに置いて所有を示す）


def _page_file(loc):
    rel = loc[len(SITE_URL):].lstrip("/")
    return DIST / rel / "index.html" if (not rel or rel.endswith("/")) else DIST / rel


def _page_hash(p):
    # 日付だけ違うページを「変わった」と数えない（テンプレートが今日の日付を埋めている箇所がある）
    return hashlib.sha256(p.read_bytes().replace(TODAY.encode(), b"")).hexdigest()[:16]


def stamp_lastmod():
    prev = {}
    if not SITE_URL.startswith(("http://localhost", "https://hutsgo.jp")):
        try:
            with urllib.request.urlopen(SITE_URL + "/page-hashes.json", timeout=15) as r:
                prev = json.loads(r.read().decode("utf-8"))
        except Exception as e:   # 初回や一時的な失敗。今日の日付で出すだけなので止めない
            print(f"  page-hashes.json を取れなかった（{e}）。lastmod は今日のまま", file=sys.stderr)
    sm = DIST / "sitemap.xml"
    xml = sm.read_text(encoding="utf-8")
    cur, changed = {}, []

    def repl(m):
        loc = m.group(1)
        f = _page_file(loc)
        if not f.exists():
            return m.group(0)
        hsh = _page_hash(f)
        old = prev.get(loc) or {}
        same = bool(prev) and old.get("hash") == hsh
        last = old.get("lastmod") if same and old.get("lastmod") else TODAY
        if not same:
            changed.append(loc)
        cur[loc] = {"hash": hsh, "lastmod": last}
        return re.sub(r"<lastmod>[^<]*</lastmod>", f"<lastmod>{last}</lastmod>", m.group(0))

    xml = re.sub(r"<url><loc>([^<]+)</loc>.*?</url>", repl, xml)
    sm.write_text(xml, encoding="utf-8")
    (DIST / "page-hashes.json").write_text(json.dumps(cur, ensure_ascii=False, indent=0), encoding="utf-8")
    (DIST / f"{INDEXNOW_KEY}.txt").write_text(INDEXNOW_KEY, encoding="utf-8")
    meta = ROOT / "build-meta"
    meta.mkdir(exist_ok=True)
    (meta / "changed-urls.txt").write_text("\n".join(changed) + ("\n" if changed else ""), encoding="utf-8")
    host = urllib.parse.urlsplit(SITE_URL).hostname or ""
    (meta / "indexnow.json").write_text(json.dumps({
        "host": host, "key": INDEXNOW_KEY, "keyLocation": f"{SITE_URL}/{INDEXNOW_KEY}.txt",
        "urlList": changed, "first_build": not prev}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"sitemap: {len(cur)} URL、変更 {len(changed)}" + ("" if prev else "（前回分なし）"))


# ---------------------------------------------------------------- 試作: 立体の飛行動画（/lab/flyover/）
# サイトからリンクしない・検索に出さない（noindex、サイトマップに入れない）。写真・動画は端末の中だけで使う
(DIST / "lab" / "flyover").mkdir(parents=True, exist_ok=True)
(DIST / "lab" / "flyover" / "routes.json").write_text(
    json.dumps(list(FLY_ROUTES.values()), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
(DIST / "lab" / "flyover" / "manifest.webmanifest").write_text(json.dumps({
    "name": "山ムービー（HutsGo）", "short_name": "山ムービー", "lang": "ja",
    "description": "歩いた山を、3D の地図と写真でショート動画に",
    "start_url": f"{BASE}/lab/flyover/", "scope": f"{BASE}/lab/flyover/", "display": "standalone",
    "background_color": "#16241d", "theme_color": "#16241d",
    "icons": [{"src": f"{BASE}/static/lab/icon-{n}.png", "sizes": f"{n}x{n}", "type": "image/png"} for n in (192, 512)]},
    ensure_ascii=False, indent=1), encoding="utf-8")
(DIST / "lab" / "flyover" / "index.html").write_text(
    env.get_template("lab_flyover.html").render(BASE=BASE, API_URL=API_URL, SITE_URL=SITE_URL), encoding="utf-8")


# ---------------------------------------------------------------- 試作: ルートを選ぶ縦フィード（/lab/feed/）
# 条件（泊数・アクセス・体力度）で絞り、ルートの 3D を流して選ぶ。数字は確認済みデータと県のグレーディング（出典つき）。
# 動画ファイルは持たない（3D は見る人のブラウザで作る）。保存は見る人の端末の中だけ
FEED = []
for t in rows("SELECT * FROM trails"):
    fr = FLY_ROUTES.get(t["id"])
    if not fr or len(fr["line"]) < 2:
        continue
    stops = rows("SELECT * FROM trail_stops WHERE trail_id=? ORDER BY seq", t["id"])
    hut_ids = [x["hut_id"] for x in stops if x["hut_id"] and x["is_overnight_candidate"]]
    hut_names = {x["id"]: x["name_ja"] for x in rows("SELECT id,name_ja FROM huts")}
    ths = [x["trailhead_id"] for x in stops if x["trailhead_id"]]
    def access_of(th_id):
        if not th_id:
            return None
        th = rows("SELECT * FROM trailheads WHERE id=?", th_id)[0]
        ar = rows("SELECT mode,from_place,private_car_restricted,duration_min FROM access_routes WHERE trailhead_id=?", th_id)
        return {"id": th_id, "name": th["name_ja"], "parking": th["parking_spaces"],
                "modes": sorted({a["mode"] for a in ar}), "from": sorted({a["from_place"] for a in ar if a["from_place"]}),
                "car_restricted": any(a["private_car_restricted"] for a in ar)}
    g = rows("SELECT * FROM trail_grading WHERE trail_id=?", t["id"])
    g = g[0] if g else None
    FEED.append({
        "id": t["id"], "name": t["name_ja"], "nights": t["nights_typical"], "course_min": fr["course_min"] or fr.get("official_min"),
        "huts": [hut_names.get(h, h) for h in hut_ids],
        "start": access_of(ths[0] if ths else None), "end": access_of(ths[-1] if len(ths) > 1 else None),
        "grading": g and {"stamina": g["stamina"], "technical": g["technical"], "no": g["source_route_no"], "route": g["source_route_name"],
                          "match": g["match"], "note": g["note"], "source": g["source_name"], "url": g["source_url"], "confidence": g["confidence"]},
        "range": t.get("range_id"),
        "line": fr["line"][::max(1, len(fr["line"]) // 120)] + [fr["line"][-1]],
        "url": f"{BASE}/trails/{t['id']}/"})
# 提供された道（承認したものだけが contrib/ にある。tools/import_contrib.py で取り込む）
CONTRIB = []
for f in sorted((ROOT / "contrib").glob("*.json")) if (ROOT / "contrib").is_dir() else []:
    c = json.loads(f.read_text(encoding="utf-8"))
    if c.get("status") == "approved" and re.fullmatch(r"v=z\.[A-Za-z0-9_-]{50,20000}", c.get("link", "")):
        CONTRIB.append({k: c.get(k) for k in ("id", "title", "comment", "trail", "region", "link", "km", "up")})
(DIST / "lab" / "feed").mkdir(parents=True, exist_ok=True)
(DIST / "lab" / "feed" / "feed.json").write_text(
    json.dumps({"routes": FEED, "contrib": CONTRIB}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
(DIST / "lab" / "feed" / "index.html").write_text(
    env.get_template("lab_feed.html").render(BASE=BASE, API_URL=API_URL, SITE_URL=SITE_URL), encoding="utf-8")

stamp_lastmod()

print(f"articles: ja {len(ARTICLES['ja'])} / en {len(ARTICLES['en'])}")
print(f"built {len(urls)} pages ({len(LOCALES)} languages) + dataset v{DATA_VERSION} ({DATA_INDEX['coverage']['huts']} huts) → {DIST}")
