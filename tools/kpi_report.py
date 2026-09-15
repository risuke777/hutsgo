#!/usr/bin/env python3
"""KPI を取りに行って、読める形にして、判断まで出す。

    python tools/kpi_report.py            # 直近30日
    python tools/kpi_report.py --days 7
    python tools/kpi_report.py --save     # 生の JSON を保存（後から差分を見る用）

接続情報は xserver/.kpi.env（git 管理外）か環境変数から読む:

    KPI_URL=https://api.hutsgo.com/kpi.php
    KPI_TOKEN=<config.php の kpi_token>

見ている指標:
  主KPI   送客率 = 小屋ページを見た人のうち公式サイト/予約/電話を押した割合（人×小屋で1回）
  仮説    英語版の送客率 > 日本語版なら「英語で出す価値がある」の裏づけ
  データ  設備の被覆率。ここが埋まらないと他社と差がつかない
  投稿    未承認の数。放置すると投稿が止まる
"""
import argparse, datetime, json, os, pathlib, sqlite3, sys, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV = ROOT / "xserver" / ".kpi.env"
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def load_env() -> dict:
    env = {}
    if ENV.is_file():
        for line in ENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("KPI_URL", "KPI_TOKEN"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def fetch(env: dict, days: int) -> dict:
    url = env["KPI_URL"] + "?" + urllib.parse.urlencode(
        {"token": env["KPI_TOKEN"], "days": days, "format": "json"})
    req = urllib.request.Request(url, headers={"User-Agent": "hutsgo-kpi-report"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def coverage() -> list:
    """seed.sql のデータ被覆率。サイトの中身そのものの指標。"""
    db = ROOT / "hutsgo.db"
    if not db.exists():
        return []
    con = sqlite3.connect(db)
    total = con.execute("SELECT COUNT(*) FROM huts").fetchone()[0]
    q = [
        ("標高",         "SELECT COUNT(*) FROM huts WHERE elevation_m IS NOT NULL"),
        ("予約URL/電話", "SELECT COUNT(*) FROM hut_seasons WHERE year=2026 AND (reservation_url IS NOT NULL OR reservation_phone IS NOT NULL)"),
        ("予約受付開始", "SELECT COUNT(*) FROM hut_seasons WHERE year=2026 AND booking_opens_at IS NOT NULL"),
        ("トイレ種別",   "SELECT COUNT(toilet_type) FROM hut_facilities"),
        ("水",           "SELECT COUNT(water_available) FROM hut_facilities"),
        ("充電",         "SELECT COUNT(charging_service) FROM hut_facilities"),
        ("支払方法",     "SELECT COUNT(*) FROM hut_facilities WHERE credit_card IS NOT NULL OR qr_payment IS NOT NULL OR cash_only IS NOT NULL"),
        ("英語名",       "SELECT COUNT(name_en) FROM huts"),
        ("英語の受付開始", "SELECT COUNT(booking_opens_at_en) FROM hut_seasons WHERE year=2026"),
        ("口コミ",       "SELECT COUNT(DISTINCT hut_id) FROM reviews"),
    ]
    out = [(label, con.execute(sql).fetchone()[0], total) for label, sql in q]
    con.close()
    return out


def bar(n: int, total: int, width: int = 20) -> str:
    fill = round(n / total * width) if total else 0
    return "█" * fill + "·" * (width - fill)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--save", action="store_true", help="生 JSON を tools/kpi/ に保存する")
    a = ap.parse_args()

    print("=" * 62)
    print(f"HutsGo KPI  直近 {a.days} 日   {datetime.date.today().isoformat()}")
    print("=" * 62)

    env = load_env()
    report = None
    if not env.get("KPI_URL") or not env.get("KPI_TOKEN"):
        print("\n[計測] 接続情報がないので取得していません。")
        print(f"       {ENV} に KPI_URL と KPI_TOKEN を書くと、ここに数字が出ます。")
    else:
        try:
            report = fetch(env, a.days)
        except Exception as e:
            print(f"\n[計測] 取得できませんでした: {e}")

    if report:
        p = report["primary"]
        print(f"\n■ 主KPI 送客率  {p['value']}%")
        print(f"   小屋ページを見た {p['hut_viewers']}（人×小屋）のうち {p['senders']} が公式/予約/電話へ")
        print(f"   訪問者 {report['visitors']} 人 / ページビュー {report['pageviews']}")

        if p["hut_viewers"] < 30:
            print("   → 判断: まだ母数が足りません。30（人×小屋）を超えるまで率は見ないこと。")
        elif p["value"] < 10:
            print("   → 判断: 低い。小屋ページに来ても予約へ進んでいません。")
            print("      予約ボタンの位置、受付開始日の見え方、料金の欠けを疑ってください。")
        elif p["value"] < 25:
            print("   → 判断: 妥当な範囲。ここからは小屋別の差を見て、低い小屋の情報を埋めるのが効きます。")
        else:
            print("   → 判断: 高い。役に立っています。この水準ならルートを増やす価値があります。")

        ja = report["by_language"].get("ja", {})
        en = report["by_language"].get("en", {})
        print(f"\n■ 言語別（英語版の仮説検証）")
        for k, v in (("日本語", ja), ("English", en)):
            print(f"   {k:<8} PV {v.get('pageviews', 0):>5}  小屋を見た {v.get('hut_viewers', 0):>4}  "
                  f"送客 {v.get('senders', 0):>4}  送客率 {v.get('send_rate', 0)}%")
        if en.get("hut_viewers", 0) < 30:
            print("   → 判断: 英語版の母数が足りません。結論を出すのは早い。")
        elif en.get("send_rate", 0) > ja.get("send_rate", 0):
            print("   → 判断: 仮説どおり。英語圏のほうが困っている裏づけです。英語の情報を増やす価値があります。")
        else:
            print("   → 判断: 仮説が立っていません。英語版の内容か、流入元を見直してください。")

        if report["by_hut"]:
            print("\n■ 小屋別（閲覧の多い順）")
            for hut, v in list(report["by_hut"].items())[:10]:
                if isinstance(v, dict):
                    print(f"   {hut:<20} 閲覧 {v['views']:>4}  送客 {v['outbound']:>4}  {v['send_rate']:>5}%")

        po = report["posts"]
        print(f"\n■ 投稿  合計 {po['total']} 件 / 未承認 {po['pending']} 件  {po.get('by_lang', {})}")
        if po["pending"]:
            print("   → やること: tools/import_posts.py で取り込み、設備を hut_facilities に反映してください。")
        print(f"\n■ ドロミティ興味  {report['interest_dolomiti']} 回")
        if report["interest_dolomiti"] >= 20:
            print("   → 判断: 着手の目安に届いています。")

    print("\n■ データ被覆率（サイトの中身。ここが差別化の実体）")
    for label, n, total in coverage():
        mark = "" if n == total else "   ← 埋める"
        print(f"   {label:<14} {bar(n, total)} {n:>2}/{total}{mark}")

    if a.save and report:
        out = ROOT / "tools" / "kpi"
        out.mkdir(exist_ok=True)
        f = out / f"{datetime.date.today().isoformat()}-{a.days}d.json"
        f.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n保存: {f.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
