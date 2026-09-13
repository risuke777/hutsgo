#!/usr/bin/env python3
"""HutsGo PoC — schema validation + the three query patterns that matter."""
import sqlite3, pathlib, textwrap, sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # Windows console (cp932) safety

DB = pathlib.Path("hutsgo.db")
if DB.exists():
    DB.unlink()

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
for f in ("schema.sql", "seed.sql"):
    con.executescript(pathlib.Path(f).read_text(encoding="utf-8"))

def head(t):
    print("\n" + "=" * 62 + f"\n{t}\n" + "=" * 62)


# --- Q1: 条件で絞り込む（既存サイトに存在しない機能） -----------------
head("Q1  9/20 に営業中 × 素泊まり11,000円以下 × テント場あり")
rows = con.execute("""
    SELECT h.name_ja, r.price_jpy, s.capacity_tents
    FROM huts h
    JOIN hut_seasons s ON s.hut_id = h.id AND s.year = 2026
    JOIN hut_rates   r ON r.hut_id = h.id AND r.year = 2026
                      AND r.plan_type = 'no_meal'
    WHERE (s.status = 'year_round'
           OR ('2026-09-20' BETWEEN s.open_date AND s.close_date))
      AND r.price_jpy <= 11000
      AND s.capacity_tents IS NOT NULL
    ORDER BY r.price_jpy
""").fetchall()
for r in rows:
    print(f"  {r['name_ja']:<12} 素泊 ¥{r['price_jpy']:,}  テント{r['capacity_tents']}張")


# --- Q2: 行程からの逆引き（HutsGo のコア導線） ------------------------
head("Q2  『表銀座縦走 2泊3日』→ 行程上の宿泊候補と予約先")
rows = con.execute("""
    SELECT ts.seq, COALESCE(h.name_ja, th.name_ja) AS stop,
           ts.cumulative_time_min AS t, h.official_url,
           s.open_date, s.close_date
    FROM trail_stops ts
    LEFT JOIN huts h        ON h.id  = ts.hut_id
    LEFT JOIN trailheads th ON th.id = ts.trailhead_id
    LEFT JOIN hut_seasons s ON s.hut_id = h.id AND s.year = 2026
    WHERE ts.trail_id = 'omote_ginza'
    ORDER BY ts.seq
""").fetchall()
for r in rows:
    hm = f"{r['t']//60}h{r['t']%60:02d}"
    season = f"{r['open_date']}〜{r['close_date']}" if r["open_date"] else "—"
    print(f"  {r['seq']}. {r['stop']:<14} +{hm:<6} {season}")
    if r["official_url"]:
        print(f"       予約: {r['official_url']}")


# --- Q3: アクセス制約（構造化できているサイトが皆無） -------------------
head("Q3  登山口アクセスの制約フラグ")
rows = con.execute("""
    SELECT th.name_ja, a.mode, a.operator_name,
           a.private_car_restricted, a.requires_hut_stay
    FROM access_routes a JOIN trailheads th ON th.id = a.trailhead_id
    ORDER BY th.name_ja
""").fetchall()
for r in rows:
    flags = []
    if r["private_car_restricted"]:
        flags.append("マイカー規制")
    if r["requires_hut_stay"]:
        flags.append("小屋宿泊者限定")
    print(f"  {r['name_ja']:<8} {r['mode']:<9} {r['operator_name'] or '—':<18} "
          f"{'/'.join(flags) or '制約なし'}")


# --- データ被覆率レポート（= やることリスト） --------------------------
head("データ被覆率  ※ここが埋まっていない = 参入余地")
total = con.execute("SELECT COUNT(*) FROM huts").fetchone()[0]

def cov(label, sql):
    n = con.execute(sql).fetchone()[0]
    bar = "█" * round(n / total * 24) + "·" * (24 - round(n / total * 24))
    print(f"  {label:<22} {bar} {n:>2}/{total}")

cov("基本情報",       "SELECT COUNT(*) FROM huts WHERE official_url IS NOT NULL")
cov("営業期間 2026",  "SELECT COUNT(*) FROM hut_seasons WHERE year=2026")
cov("料金 2026",      "SELECT COUNT(DISTINCT hut_id) FROM hut_rates WHERE year=2026")
cov("標高",           "SELECT COUNT(*) FROM huts WHERE elevation_m IS NOT NULL")
cov("予約URL/電話",   "SELECT COUNT(*) FROM hut_seasons WHERE year=2026 AND (reservation_url IS NOT NULL OR reservation_phone IS NOT NULL)")
cov("設備（トイレ等）", "SELECT COUNT(*) FROM hut_facilities WHERE toilet_type IS NOT NULL")
cov("電波",           "SELECT COUNT(DISTINCT hut_id) FROM hut_mobile_signal")
cov("口コミ",         "SELECT COUNT(DISTINCT hut_id) FROM reviews")

head("出典の確度")
for r in con.execute("""
    SELECT confidence, COUNT(*) n FROM hut_seasons WHERE year=2026
    GROUP BY confidence"""):
    print(f"  hut_seasons  {r['confidence']:<10} {r['n']}件")
print(textwrap.dedent("""
  → 'reported' は二次情報。公開前に公式サイトで再検証して
     'verified' + last_verified_at 更新が必要。
     この検証済みフラグ自体が API/MCP 提供時の商品価値になる。
"""))
con.close()
