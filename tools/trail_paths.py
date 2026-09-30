"""ルートの線を、地理院ベクトルタイルの道路中心線（登山道＝徒歩道を含む）に沿わせる。

    python tools/trail_paths.py omote_ginza            # 計算して trail_paths/omote_ginza.json と確認用 PNG を書く
    python tools/trail_paths.py omote_ginza --png-only # 保存済みの線で確認用 PNG だけ作り直す

- 小屋・登山口（座標のある stop）を行程順に並べ、区間ごとに道路網の最短経路をとる。
- 計算した線は status="auto"。地図に重ねた PNG を人が見て、正しければ JSON の status を "checked" に
  書き換え、checked_on に日付を入れる（A1/A2: 機械の出力をそのまま確認済みにしない）。
- 道でつながらない区間、始点・終点が道から遠い区間は線を作らない（build.py は直線の目安で描く）。
- 出典: 国土地理院ベクトルタイル（optimal_bvmap-v1）。スクレイピングではなく公開タイルの利用（A3）。
"""
import datetime, heapq, json, math, pathlib, sqlite3, sys, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import mvt

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "trail_paths"
CACHE = ROOT / "tools" / ".tilecache"
Z = 16
TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf"
SOURCE = "国土地理院ベクトルタイル（optimal_bvmap-v1・道路中心線）"
MARGIN_M = 1500      # 外接範囲の余白。尾根を大きく回り込む道を取りこぼさないため
JOIN_M = 12          # タイル境界で切れた線の端どうしをつなぐ距離
SNAP_MAX_M = 250     # 小屋・登山口から道までこれ以上遠ければ、その区間は作らない
DETOUR_MAX = 4.0     # 道のり ÷ 直線 がこれを超えたら別ルートを拾った疑い → 作らない


def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def tile_of(lat, lon, z=Z):
    n = 2 ** z
    return (int((lon + 180) / 360 * n),
            int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n))


def tile_to_ll(z, x, y, px, py, extent):
    n = 2 ** z
    fx, fy = x + px / extent, y + py / extent
    lon = fx / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * fy / n))))
    return lat, lon


def fetch(z, x, y):
    p = CACHE / f"{z}_{x}_{y}.pbf"
    if not p.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        try:
            data = urllib.request.urlopen(TILE_URL.format(z=z, x=x, y=y), timeout=30).read()
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            data = b""
        p.write_bytes(data)
    return p.read_bytes()


def stops_of(trail_id):
    db = sqlite3.connect(ROOT / "hutsgo.db"); db.row_factory = sqlite3.Row
    out = []
    for r in db.execute("""SELECT s.seq, COALESCE(s.hut_id, s.trailhead_id) id,
            COALESCE(h.name_ja, t.name_ja) name, COALESCE(h.lat, t.lat) lat, COALESCE(h.lon, t.lon) lon
          FROM trail_stops s LEFT JOIN huts h ON h.id = s.hut_id LEFT JOIN trailheads t ON t.id = s.trailhead_id
          WHERE s.trail_id = ? ORDER BY s.seq""", (trail_id,)):
        if r["lat"] is not None and r["lon"] is not None:
            out.append(dict(r))
    return out


def build_graph(bbox):
    (la0, lo0), (la1, lo1) = bbox
    x0, y1 = tile_of(la0, lo0); x1, y0 = tile_of(la1, lo1)
    nodes, key_of, adj = [], {}, []

    def node(ll):
        k = (round(ll[0], 5), round(ll[1], 5))
        if k not in key_of:
            key_of[k] = len(nodes); nodes.append(ll); adj.append({})
        return key_of[k]

    def link(a, b):
        if a != b:
            d = hav(nodes[a], nodes[b])
            adj[a][b] = min(adj[a].get(b, d), d); adj[b][a] = adj[a][b]

    ntiles = 0
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            data = fetch(Z, x, y); ntiles += 1
            if not data:
                continue
            lay = mvt.decode(data).get("RdCL")
            if not lay:
                continue
            for f in lay["features"]:
                for part in f["parts"]:
                    ids = [node(tile_to_ll(Z, x, y, px, py, lay["extent"])) for px, py in part]
                    for a, b in zip(ids, ids[1:]):
                        link(a, b)

    # タイル境界で切れた線をつなぐ: 端点（次数1）から JOIN_M 以内の点へ辺を足す
    cell = JOIN_M / 111320
    grid = {}
    for i, (la, lo) in enumerate(nodes):
        grid.setdefault((int(la / cell), int(lo / cell)), []).append(i)
    for i, (la, lo) in enumerate(nodes):
        if len(adj[i]) != 1:
            continue
        gi, gj = int(la / cell), int(lo / cell)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for j in grid.get((gi + di, gj + dj), ()):
                    if j != i and j not in adj[i] and hav(nodes[i], nodes[j]) <= JOIN_M:
                        link(i, j)
    return nodes, adj, ntiles


def nearest(nodes, adj, ll):
    best, bd = None, float("inf")
    for i, p in enumerate(nodes):
        if adj[i]:
            d = hav(p, ll)
            if d < bd:
                best, bd = i, d
    return best, bd


def shortest(adj, s, t):
    dist, prev, pq = {s: 0.0}, {}, [(0.0, s)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == t:
            break
        if d > dist[u]:
            continue
        for v, w in adj[u].items():
            nd = d + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd; prev[v] = u; heapq.heappush(pq, (nd, v))
    if t not in dist:
        return None, None
    path = [t]
    while path[-1] != s:
        path.append(prev[path[-1]])
    return path[::-1], dist[t]


def simplify(pts, tol_m=4):
    """Douglas-Peucker（メートル近似）。描画と JSON を軽くする"""
    if len(pts) < 3:
        return pts
    lat0 = math.radians(pts[0][0])
    xy = [(p[1] * 111320 * math.cos(lat0), p[0] * 111320) for p in pts]

    def rec(i, j, keep):
        (x1, y1), (x2, y2) = xy[i], xy[j]
        L = math.hypot(x2 - x1, y2 - y1) or 1e-9
        k, dm = None, 0
        for m in range(i + 1, j):
            d = abs((x2 - x1) * (y1 - xy[m][1]) - (x1 - xy[m][0]) * (y2 - y1)) / L
            if d > dm:
                k, dm = m, d
        if k is not None and dm > tol_m:
            rec(i, k, keep); keep.add(k); rec(k, j, keep)

    keep = {0, len(pts) - 1}
    rec(0, len(pts) - 1, keep)
    return [pts[i] for i in sorted(keep)]


def compute(trail_id):
    stops = stops_of(trail_id)
    if len(stops) < 2:
        sys.exit(f"{trail_id}: 座標のある stop が 2 つ未満")
    m = MARGIN_M / 111320
    bbox = ((min(s["lat"] for s in stops) - m, min(s["lon"] for s in stops) - m * 1.25),
            (max(s["lat"] for s in stops) + m, max(s["lon"] for s in stops) + m * 1.25))
    nodes, adj, ntiles = build_graph(bbox)
    print(f"{trail_id}: タイル {ntiles} 枚 / 道の点 {len(nodes)}")

    prev_old = {}
    old_path = OUT / f"{trail_id}.json"
    if old_path.exists():
        for leg in json.loads(old_path.read_text(encoding="utf-8"))["legs"]:
            prev_old[(leg["from"], leg["to"])] = leg

    legs = []
    for a, b in zip(stops, stops[1:]):
        leg = {"from": a["id"], "to": b["id"], "from_name": a["name"], "to_name": b["name"]}
        na, da = nearest(nodes, adj, (a["lat"], a["lon"]))
        nb, db_ = nearest(nodes, adj, (b["lat"], b["lon"]))
        straight = hav((a["lat"], a["lon"]), (b["lat"], b["lon"]))
        leg["snap_m"] = [round(da), round(db_)]
        if da > SNAP_MAX_M or db_ > SNAP_MAX_M:
            leg.update(status="none", reason=f"道から遠い（{round(da)}m / {round(db_)}m）")
        else:
            path, length = shortest(adj, na, nb)
            if path is None:
                leg.update(status="none", reason="道でつながらない")
            elif straight > 0 and length / straight > DETOUR_MAX:
                leg.update(status="none", reason=f"回り道が大きすぎる（直線の{length / straight:.1f}倍）")
            else:
                pts = [(a["lat"], a["lon"])] + [nodes[i] for i in path] + [(b["lat"], b["lon"])]
                pts = simplify(pts)
                full = sum(hav(p, q) for p, q in zip(pts, pts[1:]))
                leg.update(status="auto", length_m=round(full), straight_m=round(straight),
                           coords=[[round(p[0], 6), round(p[1], 6)] for p in pts])
                old = prev_old.get((a["id"], b["id"]))
                # 線が変わっていなければ人の確認結果を引き継ぐ
                if old and old.get("status") == "checked" and old.get("coords") == leg["coords"]:
                    leg.update(status="checked", checked_on=old.get("checked_on"))
        print(f"  {a['name']} → {b['name']}: {leg['status']}"
              + (f" {leg['length_m']}m（直線 {leg['straight_m']}m）" if "length_m" in leg else f" {leg.get('reason', '')}")
              + f" snap {leg['snap_m']}")
        legs.append(leg)

    OUT.mkdir(exist_ok=True)
    doc = {"trail_id": trail_id, "source": SOURCE, "source_zoom": Z,
           "computed_on": datetime.date.today().isoformat(),
           "note": "地図データ上の道をたどった線。登山道の現況（通行止め・付け替え）は反映しない", "legs": legs}
    old_path.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    return doc


def render_png(doc, out_png, z=15):
    """地理院の標準地図に線を重ねた確認用画像。赤=auto、緑=checked、灰の破線=作れなかった区間（直線）"""
    from PIL import Image, ImageDraw
    pts = [p for leg in doc["legs"] for p in leg.get("coords", [])]
    stops = stops_of(doc["trail_id"])
    pts += [(s["lat"], s["lon"]) for s in stops]
    la0, la1 = min(p[0] for p in pts), max(p[0] for p in pts)
    lo0, lo1 = min(p[1] for p in pts), max(p[1] for p in pts)
    x0, y1 = tile_of(la0, lo0, z); x1, y0 = tile_of(la1, lo1, z)
    x0 -= 1; y0 -= 1; x1 += 1; y1 += 1
    img = Image.new("RGB", ((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256), "white")
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            p = CACHE / f"std_{z}_{x}_{y}.png"
            if not p.exists():
                CACHE.mkdir(parents=True, exist_ok=True)
                p.write_bytes(urllib.request.urlopen(
                    f"https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", timeout=30).read())
            img.paste(Image.open(p).convert("RGB"), ((x - x0) * 256, (y - y0) * 256))
    img = Image.blend(img, Image.new("RGB", img.size, "white"), 0.35)
    d = ImageDraw.Draw(img)
    n = 2 ** z

    def px(ll):
        lat, lon = ll
        fx = (lon + 180) / 360 * n
        fy = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
        return ((fx - x0) * 256, (fy - y0) * 256)

    byid = {s["id"]: s for s in stops}
    for leg in doc["legs"]:
        if leg.get("coords"):
            col = (20, 150, 60) if leg["status"] == "checked" else (220, 30, 30)
            d.line([px(p) for p in leg["coords"]], fill=col, width=4)
        else:
            a, b = byid[leg["from"]], byid[leg["to"]]
            d.line([px((a["lat"], a["lon"])), px((b["lat"], b["lon"]))], fill=(120, 120, 120), width=2)
    for s in stops:
        cx, cy = px((s["lat"], s["lon"]))
        d.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill="white", outline=(20, 40, 120), width=3)
    img.save(out_png)
    print("確認用画像:", out_png)


if __name__ == "__main__":
    tid = sys.argv[1]
    if "--png-only" in sys.argv:
        doc = json.loads((OUT / f"{tid}.json").read_text(encoding="utf-8"))
    else:
        doc = compute(tid)
    render_png(doc, pathlib.Path(sys.argv[sys.argv.index("--png") + 1]) if "--png" in sys.argv
               else CACHE / f"{tid}.png")
