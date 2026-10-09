"""ルートの線に標高を付け、区間ごとの距離・登り・下りを出す（標準タイムの式の材料）。

    python tools/trail_profile.py kisokoma        # 1 ルート
    python tools/trail_profile.py --all           # trail_paths/*.json すべて
    python tools/trail_profile.py --check         # 長野県の表と同じ行程のルートで、距離・登り・下りを表と比べる

- 標高は国土地理院の標高タイル（dem_png・ズーム14＝10m メッシュ）。公開タイルの利用（A3）。
- 線を 10m ごとに細かくして標高を取り、登り・下りは 5m 以上の上下だけを数える（DEM の細かな揺れで登りが増えないように）。
- 結果は trail_paths/<id>.json の各区間に up_m・down_m・elev（coords と同じ並びの標高）として書き足す。
- 時間の式（build.py の CT_COEF）は、長野県「信州 山のグレーディング」の 124 ルートの合計コースタイム・ルート長・
  累積登り・累積下りから最小二乗で求めたもの（tools/fit_course_time.py）。
"""
import io, json, math, pathlib, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PATHS = ROOT / "trail_paths"
CACHE = ROOT / "tools" / ".tilecache" / "dem"
Z = 14
URL = "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"
STEP_M = 10        # 標高を取る間隔
HYST_M = 5         # この高さ以上の上下だけを登り・下りに数える
_tiles = {}


def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def tile(x, y):
    k = (x, y)
    if k in _tiles:
        return _tiles[k]
    p = CACHE / f"{Z}_{x}_{y}.png"
    if not p.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        try:
            p.write_bytes(urllib.request.urlopen(URL.format(z=Z, x=x, y=y), timeout=30).read())
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            p.write_bytes(b"")
    from PIL import Image
    data = p.read_bytes()
    _tiles[k] = Image.open(io.BytesIO(data)).convert("RGB") if data else None
    return _tiles[k]


def _px(img, x, y):
    r, g, b = img.getpixel((min(max(x, 0), 255), min(max(y, 0), 255)))
    if (r, g, b) == (128, 0, 0):
        return None
    v = r * 65536 + g * 256 + b
    return (v if v < 2 ** 23 else v - 2 ** 24) * 0.01


def elev(lat, lon):
    """双一次補間した標高（m）。海・欠測は None。"""
    n = 2 ** Z
    fx = (lon + 180) / 360 * n
    fy = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    tx, ty = int(fx), int(fy)
    img = tile(tx, ty)
    if img is None:
        return None
    px, py = (fx - tx) * 256 - 0.5, (fy - ty) * 256 - 0.5
    x0, y0 = math.floor(px), math.floor(py)
    dx, dy = px - x0, py - y0
    vals = [_px(img, x0, y0), _px(img, x0 + 1, y0), _px(img, x0, y0 + 1), _px(img, x0 + 1, y0 + 1)]
    if any(v is None for v in vals):
        return next((v for v in vals if v is not None), None)
    a, b, c, d = vals
    return (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy


def densify(coords):
    out = [tuple(coords[0])]
    for a, b in zip(coords, coords[1:]):
        d = hav(a, b)
        k = max(1, int(d // STEP_M))
        for i in range(1, k + 1):
            out.append((a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k))
    return out


def up_down(es):
    """5m のヒステリシスで数えた登り・下り（m）。"""
    up = down = 0.0
    ref = es[0]
    for e in es[1:]:
        if e - ref >= HYST_M:
            up += e - ref; ref = e
        elif ref - e >= HYST_M:
            down += ref - e; ref = e
    return up, down


def profile(trail_id):
    f = PATHS / f"{trail_id}.json"
    doc = json.loads(f.read_text(encoding="utf-8"))
    for leg in doc["legs"]:
        c = leg.get("coords")
        if not c:
            continue
        dense = densify(c)
        es = [elev(*p) for p in dense]
        es = [e if e is not None else (es[i - 1] if i else 0) for i, e in enumerate(es)]
        leg["up_m"], leg["down_m"] = (round(v) for v in up_down(es))
        leg["length_m"] = round(sum(hav(a, b) for a, b in zip(c, c[1:])))
        leg["elev"] = [round(elev(*p) or 0) for p in c]
    doc["elev_source"] = "国土地理院 標高タイル（dem_png・z14＝10m メッシュ）。登り・下りは 10m 間隔・5m 以上の上下だけを数えた"
    f.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    tot = [sum(l.get(k, 0) for l in doc["legs"]) for k in ("length_m", "up_m", "down_m")]
    print(f"{trail_id}: {tot[0] / 1000:.1f} km, 登り {tot[1]} m, 下り {tot[2]} m（{len(doc['legs'])} 区間）")
    return tot


def check():
    """長野県の表と同じ行程（match='same'）のルートで、距離・登り・下りを表と並べる。"""
    import sqlite3
    db = sqlite3.connect(ROOT / "hutsgo.db")
    for tid, L, U, name in db.execute("SELECT trail_id, length_km, ascent_km, source_route_name FROM trail_grading "
                                      "WHERE match='same' AND length_km IS NOT NULL"):
        f = PATHS / f"{tid}.json"
        if not f.exists():
            continue
        legs = json.loads(f.read_text(encoding="utf-8"))["legs"]
        l = sum(x.get("length_m", 0) for x in legs) / 1000
        u = sum(x.get("up_m", 0) for x in legs) / 1000
        print(f"{tid:18s} 距離 {l:5.1f} / 表 {L:5.1f} km ({(l / L - 1) * 100:+4.0f}%)   "
              f"登り {u:4.2f} / 表 {U:4.2f} km ({(u / U - 1) * 100:+4.0f}%)  {name}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--check" in args:
        check()
    else:
        ids = [p.stem for p in sorted(PATHS.glob("*.json"))] if "--all" in args else args
        for t in ids:
            profile(t)
