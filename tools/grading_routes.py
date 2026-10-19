"""長野県の山のグレーディング一覧表の「往復ルート」から、HutsGo のルートの候補を作る（機械で確かめられたものだけ）。

    python tools/grading_routes.py rows.json 24 21 29 ...   # 表の No. を指定。結果は tools/.tilecache/grading_routes.json

1 行ごとに:
  1. 山頂: 地理院の地名検索（msearch.gsi.go.jp）で山名を引き、地理院の標高が表の最高地点の標高に近い候補を選ぶ。
     近くに同じ標高の標高点・三角点の注記があればその位置にする。
  2. 登山口: 地名検索・地図の注記で出発地点の名前を引き、山頂から 15km 以内で標高が表に近いものを選ぶ。
     無ければ、山頂へ道でつながる点のうち、表の出発地点の標高に当たる点（名前の候補にいちばん近いもの）。
  3. 道: 地理院の道路中心線で登山口→山頂の最短経路。往復の道のりが表のルート長と ±25% 以内なら採用。
合わなかった行は理由を付けて落とす（推測で埋めない＝A1）。位置・道は確認用の画像を人が見てから公開する。

長野県以外の表の行も同じ形で渡せる。行に "q"（山頂の地名検索に使う名前）・"sq"（登山口の名前）・
"area"（[南, 北, 西, 東] の緯度経度。山頂の候補をこの範囲に絞る。省略時は長野県とその周り）を足す。
"""
import heapq, json, math, pathlib, re, sys, urllib.parse, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import mvt, trail_paths as tp, trail_profile as pf

UA = {"User-Agent": "HutsGo/1.0 (+https://hutsgo.com)"}
import os
OUT = pathlib.Path(os.environ.get("GR_OUT") or (tp.CACHE / "grading_routes.json"))   # 並べて走らせるときは GR_OUT で出力を分ける


def geocode(q):
    url = "https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + urllib.parse.quote(q)
    try:
        d = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read())
    except Exception:
        return []
    return [(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0], f["properties"].get("title", "")) for f in d]


def annos(lat, lon, r_km):
    d = r_km / 111.0
    x0, y0 = tp.tile_of(lat + d, lon - d * 1.25); x1, y1 = tp.tile_of(lat - d, lon + d * 1.25)
    out = []
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            data = tp.fetch(tp.Z, x, y)
            lay = mvt.decode(data).get("Anno") if data else None
            for f in (lay or {}).get("features", []):
                if f["parts"]:
                    la, lo = tp.tile_to_ll(tp.Z, x, y, *f["parts"][0][0], lay["extent"])
                    out.append((f["props"].get("vt_code"), str(f["props"].get("vt_text") or ""), la, lo))
    return out


def dijkstra(adj, s):
    dist, pq = {s: 0.0}, [(0.0, s)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e18):
            continue
        for v, w in adj[u].items():
            if d + w < dist.get(v, 1e18):
                dist[v] = d + w; heapq.heappush(pq, (d + w, v))
    return dist


def solve(row):
    r = dict(no=row["no"], name=row["name"], ok=False)
    # 1. 山頂
    s0, n0, w0, e0 = row.get("area") or (34.9, 37.4, 136.8, 139.6)
    cands = [(la, lo, t) for la, lo, t in geocode(row.get("q") or row["peak"]) if s0 < la < n0 and w0 < lo < e0]
    best = None
    for la, lo, t in cands:
        e = pf.elev(la, lo)
        if e is not None and abs(e - row["pe"]) <= 70 and (best is None or abs(e - row["pe"]) < best[3]):
            best = (la, lo, t, abs(e - row["pe"]))
    if not best:
        r["why"] = f"山頂が見つからない（候補 {len(cands)}）"; return r
    top = (best[0], best[1])
    near = [(abs(float(t) - row["pe"]), la, lo) for c, t, la, lo in annos(top[0], top[1], 0.8)
            if c in (7102, 7201) and re.fullmatch(r"[\d.]+", t) and abs(float(t) - row["pe"]) <= 3 and tp.hav((la, lo), top) < 800]
    if near:
        near.sort(); top = (near[0][1], near[0][2])
    r["top"] = [round(top[0], 6), round(top[1], 6)]
    # 2. 登山口の名前の候補
    sq = row.get("sq") or row["start"]
    key = re.sub(r"(登山口|駐車場|駅)$", "", sq)
    names = [(la, lo) for la, lo, t in geocode(sq) + geocode(key) if tp.hav((la, lo), top) < 15000]
    names += [(la, lo) for c, t, la, lo in annos(top[0], top[1], 9) if key and key in t]
    # 3. 道
    span = max(0.06, row["L"] / 2 / 111 * 1.2)
    nodes, adj, _ = tp.build_graph(((top[0] - span, top[1] - span * 1.25), (top[0] + span, top[1] + span * 1.25)))
    ti, tsnap = tp.nearest(nodes, adj, top)
    if ti is None or tsnap > 250:
        r["why"] = f"山頂が道から遠い（{int(tsnap or 0)}m）"; return r
    dist = dijkstra(adj, ti)
    want = row["L"] * 1000 / 2
    pick = None
    # 表の出発地点の標高（±40m）で、道のりが表の半分（±25%）の点。名前の候補があればそれに近い順、無ければ道のりの近い順
    for i, dd in dist.items():
        if not (want * 0.75 <= dd <= want * 1.25):
            continue
        e = pf.elev(*nodes[i])
        if e is None or abs(e - row["se"]) > 40:
            continue
        dn = min((tp.hav(nodes[i], n) for n in names), default=None)
        score = (dn if dn is not None else 5000) + abs(dd - want) * 0.5 + abs(e - row["se"]) * 5
        if dn is not None and dn > 1500:
            continue
        if pick is None or score < pick[0]:
            pick = (score, i, dd, e, dn)
    if not pick:
        r["why"] = f"登山口が決まらない（名前の候補 {len(names)}、道のり {int(want)}m 付近に標高 {row['se']}m の点なし）"; return r
    if pick[4] is None:
        r["why"] = "登山口の名前が地理院の検索・注記に無い（位置を名前で確かめられない）"; return r
    _, i, dd, e, dn = pick
    r.update(ok=True, start=[round(nodes[i][0], 6), round(nodes[i][1], 6)], oneway_m=int(dd), start_elev=round(e), name_off_m=int(dn))
    return r


if __name__ == "__main__":
    rows = {d["no"]: d for d in json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))}
    res = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    for no in map(int, sys.argv[2:]):
        if str(no) in res and res[str(no)].get("ok"):
            continue
        try:
            res[str(no)] = solve(rows[no])
        except Exception as ex:
            res[str(no)] = dict(no=no, name=rows[no]["name"], ok=False, why="エラー: " + str(ex)[:120])
        x = res[str(no)]
        print(no, x["name"], "OK" if x["ok"] else "×", x.get("why") or f"片道 {x['oneway_m']}m（表 {int(rows[no]['L'] * 500)}m）登山口の標高 {x['start_elev']}（表 {rows[no]['se']}）名前から {x['name_off_m']}m", flush=True)
        OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
