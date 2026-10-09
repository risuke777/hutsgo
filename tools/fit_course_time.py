"""標準タイムの式（build.py の CT_COEF）を、長野県の表から求め直す。

    python tools/fit_course_time.py

長野県「信州 山のグレーディング」一覧表（PDF）の各ルートの
合計コースタイム(時間)・ルート長(km)・累積登り(km)・累積下り(km) に、
  時間 = a×距離 + b×登り + c×下り
を最小二乗で当てはめる。表の「ルート定数」（1.8×時間＋0.3×距離＋10×登り＋0.6×下り）と合わない行は読み違いとして外す。
pdftotext（poppler）が要る。表が改定されたら実行し、出た係数を build.py の CT_COEF に写す。
"""
import pathlib, re, subprocess, tempfile, urllib.request

URL = "https://www.pref.nagano.lg.jp/kankoki/sangyo/kanko/documents/2026_grading_list.pdf"


def main():
    import numpy as np
    with tempfile.TemporaryDirectory() as d:
        pdf = pathlib.Path(d) / "list.pdf"
        req = urllib.request.Request(URL, headers={"User-Agent": "HutsGo (+https://hutsgo.com)"})
        pdf.write_bytes(urllib.request.urlopen(req, timeout=60).read())
        txt = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(pdf), "-"],
                             capture_output=True, check=True).stdout.decode("utf-8")
    rows = []
    for line in txt.splitlines():
        m = re.search(r"(\d+\.\d)\s+(\d+\.\d)\s+(\d+\.\d\d)\s+(\d+\.\d\d)\s+(\d+\.\d)\s*$", line)
        if m:
            t, l, u, dn, c = map(float, m.groups())
            if abs(1.8 * t + 0.3 * l + 10 * u + 0.6 * dn - c) < 0.3:
                rows.append((t, l, u, dn))
    a = np.array([[r[1], r[2], r[3]] for r in rows])
    y = np.array([r[0] for r in rows])
    coef = np.linalg.lstsq(a, y, rcond=None)[0]
    err = (a @ coef - y) / y
    print(f"{len(rows)} ルート")
    print("CT_COEF = (%.4f, %.4f, %.4f)" % tuple(coef))
    print("平均の外れ %.1f%%、±25%% 以内 %d/%d" % (100 * np.mean(np.abs(err)), (np.abs(err) <= .25).sum(), len(y)))
    print("平地 %.1f km/h・登り %.0f m/h・下り %.0f m/h に当たる" % (1 / coef[0], 1000 / coef[1], 1000 / coef[2]))


if __name__ == "__main__":
    main()
