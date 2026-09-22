#!/usr/bin/env python3
"""年1回の見直しリスト。確認から時間が経った行を、確認先の URL つきで出す。

    python tools/verify_due.py                # 既定: 180日より古い行
    python tools/verify_due.py --days 300
    python tools/verify_due.py --only transit

時刻表とダイヤは毎年変わる。全便を持たない代わりに、
「いつ確認したか」を持ち、期限が来たら自分に突きつける。これが年1更新の実体。
出た行を公式ページで見て seed.sql を直し、last_verified_at を当日に、
確認できたら confidence を 'verified' に上げる。
"""
import argparse, datetime, pathlib, sqlite3, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# (表示名, テーブル, 名前の列, 確認先の列)
TARGETS = {
    "transit": [
        ("交通事業者", "transit_operators", "name_ja", "timetable_url"),
        ("路線",       "transit_lines",     "name_ja", "source_url"),
        ("ダイヤ期間", "transit_periods",   "name_ja", "source_url"),
        ("停留所",     "transit_stops",     "name_ja", "source_url"),
        ("乗継",       "transit_connections", "id",    "source_url"),
    ],
    "huts": [
        ("小屋",       "huts",           "name_ja", "official_url"),
        ("営業期間",   "hut_seasons",    "hut_id",  "source_url"),
        ("料金",       "hut_rates",      "hut_id",  "source_url"),
        ("設備",       "hut_facilities", "hut_id",  "source_url"),
    ],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--only", choices=sorted(TARGETS), help="transit か huts に絞る")
    a = ap.parse_args()

    db = ROOT / "hutsgo.db"
    if not db.exists():
        sys.exit("hutsgo.db がありません。先に python build.py を実行してください。")
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    cutoff = (datetime.date.today() - datetime.timedelta(days=a.days)).isoformat()

    groups = TARGETS if not a.only else {a.only: TARGETS[a.only]}
    total = 0
    for group, targets in groups.items():
        print(f"\n=== {group}（{cutoff} より前に確認した行、または未確認）===")
        for label, table, name_col, url_col in targets:
            try:
                rs = con.execute(
                    f"SELECT {name_col} AS name, {url_col} AS url, last_verified_at AS d, confidence AS c "
                    f"FROM {table} WHERE last_verified_at IS NULL OR last_verified_at < ? "
                    f"ORDER BY last_verified_at IS NOT NULL, last_verified_at, name", (cutoff,)).fetchall()
            except sqlite3.OperationalError as e:
                print(f"  {label}: 読めません（{e}）")
                continue
            if not rs:
                continue
            print(f"\n  {label}（{len(rs)}件）")
            for r in rs:
                total += 1
                mark = {"verified": "✔", "reported": "△", "unknown": "?"}.get(r["c"], "?")
                print(f"    {mark} {r['name']:<24} {r['d'] or '未確認':<12} {r['url'] or ''}")

    print(f"\n合計 {total} 件。'△' は二次情報のまま。公式で確認したら confidence='verified' に上げる。")
    if total:
        print("直す先は seed.sql。直したら python build.py → python demo.py。")


if __name__ == "__main__":
    main()
