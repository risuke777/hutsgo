#!/usr/bin/env python3
"""公開後に、中身が変わったページだけを IndexNow（Bing・Yandex・Naver・Seznam など）へ知らせる。

    python tools/indexnow.py            # build-meta/indexnow.json の URL を送る
    python tools/indexnow.py --dry-run  # 送らずに中身だけ表示

CI（.github/workflows/deploy.yml）が公開の後に呼ぶ。公開前に知らせると古いページを取りに来られるため。
Google は IndexNow を使わない。Google には正確な lastmod のサイトマップ（robots.txt に記載）と、
分析画面の「サイトマップを送信」（Search Console API）で伝える。
"""
import json, pathlib, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
META = ROOT / "build-meta" / "indexnow.json"
ENDPOINT = "https://api.indexnow.org/indexnow"


def main():
    if not META.exists():
        sys.exit("build-meta/indexnow.json が無い。先に build.py を実行する")
    m = json.loads(META.read_text(encoding="utf-8"))
    urls = m["urlList"]
    if m["host"] in ("", "localhost", "127.0.0.1", "hutsgo.jp") or m["host"].endswith("github.io"):
        print(f"本番ドメインではない（{m['host']}）ので送らない"); return
    if m.get("first_build"):
        # 前回分が取れなかった＝全ページが「変更」扱い。毎回全件を送ると無視されやすいので送らない
        print("前回の page-hashes.json が無かったので送らない（次の公開から差分を送る）"); return
    if not urls:
        print("変わったページなし"); return
    body = {k: m[k] for k in ("host", "key", "keyLocation")} | {"urlList": urls[:10000]}
    print(f"{len(urls)} 件: " + ", ".join(urls[:5]) + (" …" if len(urls) > 5 else ""))
    if "--dry-run" in sys.argv:
        return
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print("IndexNow:", r.status)   # 200=受付 / 202=鍵の確認待ち
    except urllib.error.HTTPError as e:
        # 失敗しても公開そのものは済んでいる。CI を赤くして気づけるようにだけする
        sys.exit(f"IndexNow: {e.code} {e.read()[:200]!r}")


if __name__ == "__main__":
    main()
