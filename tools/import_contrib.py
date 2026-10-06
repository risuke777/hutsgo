#!/usr/bin/env python3
"""XServer に溜まった道の提供 (contrib/*.jsonl) を、確かめるためのファイルにする。
   python tools/import_contrib.py contrib/2026-10.jsonl
   contrib/<id>.json を "status": "review" で書き出し、見るためのリンクを出す。
   リンクを開いて道と題・ひとことを確かめ、載せてよいものだけ "status": "approved" に書き換えて commit する。
   載せないものはファイルを消す。build.py は approved のものだけを /lab/feed/ に出す。"""
import json, pathlib, sys, hashlib, re

URL = re.compile(r"(?:https?://|www\.)[^\s<>\"']{3,200}", re.I)
OUT = pathlib.Path(__file__).resolve().parent.parent / "contrib"
SITE = "https://hutsgo.com"

if len(sys.argv) < 2:
    sys.exit(__doc__)
OUT.mkdir(exist_ok=True)
n = 0
for line in pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    p = json.loads(line)
    if p.get("status") != "pending" or not re.fullmatch(r"v=z\.[A-Za-z0-9_-]{50,20000}", p.get("link", "")):
        continue
    cid = "c_" + hashlib.sha1((p["ts"] + p["link"][:200]).encode()).hexdigest()[:10]
    f = OUT / f"{cid}.json"
    if f.exists():
        continue
    # 題とひとことにリンクは残さない（contribute.php でも外しているが、古いものや抜けに備える）
    title, comment = URL.sub("", p.get("title") or "").strip(), URL.sub("", p.get("comment") or "").strip()
    rec = {"id": cid, "status": "review", "received": p["ts"][:10], "title": title, "comment": comment,
           "trail": p.get("trail") or "", "region": p.get("region") or "", "km": p.get("km"), "up": p.get("up"), "link": p["link"]}
    f.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    n += 1
    print(f"{cid}  {title or '（題なし）'}  {p.get('km')}km ↑{p.get('up')}m  近いルート: {p.get('trail') or '—'}")
    if comment:
        print(f"    ひとこと: {comment}")
    if p.get("links"):
        print(f"    外したリンク: {p['links']}  → スパムなら消す")
    print(f"    確かめる: {SITE}/lab/flyover/#{p['link'][:60]}…（全体は {f.name} の link）")
print(f"-- {n} 件を contrib/ に書き出した。確かめて、載せるものだけ status を approved に。")
