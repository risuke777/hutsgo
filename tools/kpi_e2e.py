"""kpi.php の手元試験（python tools/kpi_e2e.py）。PHP は環境変数 PHP_BIN か PATH の php（openssl・curl 拡張が要る）。
偽の Google（トークン・Search Console API）を立て、PHP 内蔵サーバーで kpi.php を動かす。
   - JWT の署名を公開鍵で検証する（openssl CLI）
   - 検索パフォーマンス・サイトマップ・URL 検査の表示、サイトマップ送信（PUT）、合言葉違いの拒否
   - curl 拡張あり／なしの両方
"""
import base64, http.server, json, os, pathlib, shutil, subprocess, sys, threading, time, urllib.parse, urllib.request

import tempfile
API = pathlib.Path(__file__).resolve().parent.parent / "xserver" / "api"
PHP = pathlib.Path(os.environ.get("PHP_BIN") or shutil.which("php") or "php")
EXT_DIR = os.environ.get("PHP_EXT_DIR") or str(PHP.parent / "ext")
W = pathlib.Path(tempfile.mkdtemp(prefix="hutsgo-kpi-"))
MOCK, WEB = 8790, 8791
TOKEN = "testtoken-123"
calls = []
results = []


def ok(label, cond, extra=""):
    results.append(cond)
    print(("PASS  " if cond else "FAIL  ") + label + (f"  [{extra}]" if extra and not cond else ""))


def b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _authed(self):
        return self.headers.get("Authorization") == "Bearer mock-access-token"

    def do_POST(self):
        raw = self._body()
        calls.append(("POST", self.path))
        if self.path == "/token":
            f = urllib.parse.parse_qs(raw.decode())
            jwt = f.get("assertion", [""])[0]
            head, claim, sig = jwt.split(".")
            (W / "jwt_in.txt").write_bytes((head + "." + claim).encode())
            (W / "jwt_sig.bin").write_bytes(b64d(sig))
            v = subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(W / "pub.pem"), "-signature",
                                str(W / "jwt_sig.bin"), str(W / "jwt_in.txt")], capture_output=True, text=True)
            c = json.loads(b64d(claim))
            calls.append(("JWT", v.stdout.strip(), c.get("scope"), c.get("iss")))
            if "Verified OK" not in v.stdout:
                return self._send(400, {"error": "invalid_grant", "error_description": "bad signature"})
            return self._send(200, {"access_token": "mock-access-token", "expires_in": 3600})
        if not self._authed():
            return self._send(401, {"error": {"message": "no auth"}})
        if self.path.endswith("/searchAnalytics/query"):
            q = json.loads(raw)
            dims = q.get("dimensions", [])
            if not dims:
                prev = q["startDate"] < time.strftime("%Y-%m-%d", time.gmtime(time.time() - 40 * 86400))
                return self._send(200, {"rows": [{"clicks": 3 if prev else 12, "impressions": 150 if prev else 420,
                                                  "ctr": 0.0286, "position": 18.4}]})
            if dims == ["date"]:
                return self._send(200, {"rows": [{"keys": [time.strftime("%Y-%m-%d", time.gmtime(time.time() - i * 86400))],
                                                  "clicks": i % 3, "impressions": 10 + i} for i in range(3, 20)]})
            key = {"query": ["表銀座 山小屋 予約", "yarigatake sanso booking"], "page": ["https://hutsgo.com/en/huts/yarigatake_sanso/"],
                   "country": ["jpn", "usa", "twn"]}[dims[0]]
            return self._send(200, {"rows": [{"keys": [k], "clicks": 2, "impressions": 40 - i, "ctr": 0.05, "position": 9.1}
                                             for i, k in enumerate(key)]})
        if self.path == "/v1/urlInspection/index:inspect":
            u = json.loads(raw)["inspectionUrl"]
            idx = u.endswith("/plan/")
            return self._send(200, {"inspectionResult": {"indexStatusResult": {
                "verdict": "NEUTRAL" if idx else "PASS",
                "coverageState": "Discovered - currently not indexed" if idx else "Submitted and indexed",
                "lastCrawlTime": "2026-09-28T03:00:00Z", "googleCanonical": u}}})
        return self._send(404, {"error": {"message": "unknown " + self.path}})

    def do_GET(self):
        calls.append(("GET", self.path))
        if not self._authed():
            return self._send(401, {"error": {"message": "no auth"}})
        if self.path.endswith("/sitemaps"):
            return self._send(200, {"sitemap": [{"path": "https://hutsgo.com/sitemap.xml", "lastSubmitted": "2026-09-19T01:00:00Z",
                                                 "lastDownloaded": "2026-09-30T05:00:00Z", "warnings": "0", "errors": "0",
                                                 "contents": [{"type": "web", "submitted": "87"}]}]})
        return self._send(404, {"error": {"message": "unknown"}})

    def do_PUT(self):
        n = self.headers.get("Content-Length")
        self._body()
        calls.append(("PUT", self.path, n))
        if not self._authed():
            return self._send(401, {"error": {"message": "no auth"}})
        if n is None:
            return self._send(411, {"error": {"message": "Length Required"}})
        return self._send(200)


def setup():
    if W.exists():
        shutil.rmtree(W)
    W.mkdir()
    for f in API.glob("*.php"):
        shutil.copy(f, W / f.name)
    subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(W / "key.pem")],
                   check=True, capture_output=True)
    subprocess.run(["openssl", "pkey", "-in", str(W / "key.pem"), "-pubout", "-out", str(W / "pub.pem")], check=True, capture_output=True)
    (W / "data" / "events").mkdir(parents=True)
    (W / "data" / "gsc-key.json").write_text(json.dumps({"type": "service_account", "client_email": "kpi@test.iam.gserviceaccount.com",
                                                         "private_key": (W / "key.pem").read_text()}))
    cfg = f"""<?php return [
  'allowed_origins' => ['https://hutsgo.com'], 'kpi_token' => '{TOKEN}', 'data_dir' => __DIR__ . '/data',
  'max_photo_bytes' => 1, 'max_photo_edge' => 1, 'photo_quality' => 70,
  'gsc_key_file' => __DIR__ . '/data/gsc-key.json', 'gsc_site' => 'sc-domain:hutsgo.com',
  'gsc_sitemap' => 'https://hutsgo.com/sitemap.xml', 'gsc_inspect' => ['https://hutsgo.com/', 'https://hutsgo.com/plan/'],
  'gsc_token_url' => 'http://127.0.0.1:{MOCK}/token', 'gsc_api_base' => 'http://127.0.0.1:{MOCK}',
];"""
    (W / "config.php").write_text(cfg, encoding="utf-8")
    now = time.time()
    ts = lambda d: time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(now - d * 86400))
    ev = []
    for i, (ref, lang) in enumerate([("www.google.com", "ja"), ("chatgpt.com", "en"), ("t.co", "en"), ("hutsgo.com", "ja"),
                                     ("", "ja"), ("gemini.google.com", "en"), ("www.emospot.com", "ja")]):
        ev.append({"ev": "pageview", "lang": lang, "hut": "yarigatake_sanso", "trail": "", "page": "/huts/yarigatake_sanso/",
                   "ref": ref, "v": f"v{i}", "ts": ts(i % 5)})
    ev += [{"ev": "outbound_reservation", "lang": "en", "hut": "yarigatake_sanso", "trail": "", "page": "/", "ref": "", "v": "v1", "ts": ts(1)},
           {"ev": "view_3d", "lang": "ja", "hut": "", "trail": "omote_ginza", "page": "/", "ref": "", "v": "v0", "ts": ts(2)},
           {"ev": "view_3d", "lang": "ja", "hut": "", "trail": "omote_ginza", "page": "/", "ref": "", "v": "v0", "ts": ts(2)},
           {"ev": "agency_link", "lang": "en", "hut": "jonen_goya", "trail": "", "page": "/", "ref": "", "v": "v2", "ts": ts(0)}]
    (W / "data" / "events" / time.strftime("%Y-%m.jsonl")).write_text("\n".join(json.dumps(e) for e in ev) + "\n", encoding="utf-8")


def fetch(url, data=None):
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")


def run(with_curl):
    for f in (W / "data" / "gsc").glob("*") if (W / "data" / "gsc").exists() else []:
        f.unlink()
    exts = ["-d", "extension=openssl"] + (["-d", "extension=curl"] if with_curl else [])
    srv = subprocess.Popen([str(PHP), "-d", f"extension_dir={EXT_DIR}", *exts, "-S", f"127.0.0.1:{WEB}", "-t", str(W)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    tag = "curl" if with_curl else "stream"
    try:
        base = f"http://127.0.0.1:{WEB}/kpi.php"
        code, _ = fetch(base + "?token=wrong")
        ok(f"[{tag}] 合言葉違いは 403", code == 403)
        calls.clear()
        code, html = fetch(base + f"?token={TOKEN}&days=30")
        ok(f"[{tag}] 画面が出る", code == 200 and "HutsGo KPI" in html, str(code) + html[:300])
        jwt = [c for c in calls if c[0] == "JWT"]
        ok(f"[{tag}] JWT の署名が公開鍵で検証できる（scope・iss も正しい）",
           bool(jwt) and jwt[0][1] == "Verified OK" and jwt[0][2] == "https://www.googleapis.com/auth/webmasters"
           and jwt[0][3] == "kpi@test.iam.gserviceaccount.com", str(jwt))
        ok(f"[{tag}] 検索の表示回数 420 と前期比が出る", "420" in html and "+180%" in html)
        ok(f"[{tag}] 検索語が出る（日本語・英語）", "表銀座 山小屋 予約" in html and "yarigatake sanso booking" in html)
        ok(f"[{tag}] 国の表に USA が出る", "USA" in html)
        ok(f"[{tag}] サイトマップの状態が出る", "2026-09-30T05:00" in html)
        ok(f"[{tag}] インデックス未登録のページが要対応で出る", "Discovered - currently not indexed" in html and 'lv-wait">NEUTRAL' in html)
        ok(f"[{tag}] 流入元に検索・AI・SNS・Emospot が分かれて出る（サイト内は数えない）",
           all(s in html for s in ["検索", "AI（ChatGPT 等）", "SNS", "Emospot"]))
        code, js = fetch(base + f"?token={TOKEN}&days=30&format=json")
        rep = json.loads(js)
        g = rep["referrers"]["by_group"]
        ok(f"[{tag}] gemini は AI に数え、検索に入れない", g.get("ai") == 2 and g.get("search") == 1 and "self" not in g, str(g))
        ok(f"[{tag}] 機能テスト: 3D は 2 クリック・1 人", rep["features"]["view_3d"] == {"label": "立体で見る（地理院3D）", "clicks": 2, "visitors": 1})
        ok(f"[{tag}] 判定に検索が入る（420 回・良い）", rep["judgement"]["search"]["level"] == "good")
        ok(f"[{tag}] 3ヶ月判定の文に表示回数が入る", "28日 420 回" in rep["judgement"]["continue"]["why"])
        calls.clear()
        code, html = fetch(base + f"?token={TOKEN}&days=30", data=urllib.parse.urlencode({"token": TOKEN, "action": "submit_sitemap"}).encode())
        puts = [c for c in calls if c[0] == "PUT"]
        ok(f"[{tag}] サイトマップ送信が PUT で届き、長さ 0 が付く",
           bool(puts) and puts[0][1].endswith("/sitemaps/https%3A%2F%2Fhutsgo.com%2Fsitemap.xml") and puts[0][2] == "0", str(puts))
        ok(f"[{tag}] 送信結果が画面に出る", "サイトマップを送信しました" in html)
        code, _ = fetch(base + f"?token={TOKEN}", data=urllib.parse.urlencode({"token": "wrong", "action": "submit_sitemap"}).encode())
        ok(f"[{tag}] 本文の合言葉が違えば送信しない", code == 403)
    finally:
        srv.terminate()


setup()
mock = http.server.ThreadingHTTPServer(("127.0.0.1", MOCK), Mock)
threading.Thread(target=mock.serve_forever, daemon=True).start()
try:
    run(True)
    run(False)
    # 鍵が無いとき: 画面は落ちず「未接続」
    (W / "data" / "gsc-key.json").unlink()
    srv = subprocess.Popen([str(PHP), "-d", f"extension_dir={EXT_DIR}", "-d", "extension=openssl", "-S", f"127.0.0.1:{WEB}", "-t", str(W)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    code, html = fetch(f"http://127.0.0.1:{WEB}/kpi.php?token={TOKEN}")
    srv.terminate()
    ok("鍵が無ければ「未接続」と出して画面は落ちない", code == 200 and "Search Console 未接続" in html)
finally:
    mock.shutdown()
print(f"\n{sum(results)}/{len(results)} 件パス")
sys.exit(0 if all(results) else 1)
