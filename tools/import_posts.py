#!/usr/bin/env python3
"""XServer に溜まった投稿 (posts/*.jsonl) を seed.sql 用の SQL に変換する。
   python tools/import_posts.py posts/2026-09.jsonl [uploads_dir] > pending.sql
   出力を読んで問題ないものだけ seed.sql の reviews に貼る。写真は EXIF を剥がして static/img/ug/ に書き出す。"""
import json, pathlib, sys, hashlib, re

URL = re.compile(r"(?:https?://|www\.)[^\s<>\"']{3,200}", re.I)

if len(sys.argv) < 2:
    sys.exit(__doc__)
src = pathlib.Path(sys.argv[1])
uploads = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
out_img = pathlib.Path(__file__).resolve().parent.parent / "static" / "img" / "ug"

def q(s):
    return "NULL" if s in (None, "") else "'" + str(s).replace("'", "''") + "'"

print("-- generated from", src.name, "— 読んでから貼ること。status=pending の行しか出していない。")
print("INSERT INTO reviews (id,hut_id,author_type,stayed_on,plan_type,body,verified_stay,created_at) VALUES")
rows = []
for line in src.read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    p = json.loads(line)
    if p.get("status") != "pending" or not p.get("body"):
        continue
    rid = "ug_" + hashlib.sha1((p["ts"] + p["hut"]).encode()).hexdigest()[:10]
    # 本文にリンクは入れない。post.php が退避したものも、古い投稿に残っているものもここで消す。
    # 出したいリンクがあるなら reviews.link_url に手で入れる（行き先は小屋の公式か自社のみ）。
    body = URL.sub("", p["body"]).strip()
    links = list(p.get("links") or []) + URL.findall(p["body"])
    if links:
        print(f"-- リンクを本文から除外 {p['hut']}: {links}  → スパムなら丸ごと捨てる。"
              f"載せるなら reviews.link_url に手で入れる")
    if not body:
        print(f"-- 本文がリンクだけだった投稿を捨てた: {p['hut']} {p['ts'][:10]}")
        continue
    rows.append(f"({q(rid)},{q(p['hut'])},'user',{q(p.get('stayed_on'))},{q(p.get('plan'))},{q(body)},0,{q(p['ts'][:10])})")
    fac = {k: p.get(k) for k in ("toilet", "water", "charging", "payment", "shower") if p.get(k)}
    if fac:
        print(f"-- 設備の申告 {p['hut']} ({p.get('stayed_on') or '日付なし'}): {fac}  → hut_facilities を手で更新 (confidence='reported')")
    if uploads and p.get("photo"):
        try:
            from PIL import Image, ImageOps
            im = ImageOps.exif_transpose(Image.open(uploads / p["photo"])).convert("RGB")
            im.thumbnail((1600, 1600))
            out_img.mkdir(parents=True, exist_ok=True)
            dest = out_img / (rid + ".jpg")
            im.save(dest, quality=80, optimize=True)   # EXIF は書かない = 位置情報が消える
            print(f"-- 写真: {dest.relative_to(out_img.parent.parent)} （本人の同意を確認してから photos に登録）")
        except Exception as e:  # noqa
            print(f"-- 写真 {p['photo']} の変換に失敗: {e}")
print(",\n".join(rows) + ";" if rows else "-- 取り込む投稿はありません")
