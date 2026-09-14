#!/usr/bin/env python3
"""xserver/api/ の PHP をエックスサーバーへ FTPS でアップロードする。

    python tools/deploy_api.py                  # 差分だけ送る（既定）
    python tools/deploy_api.py --init-config    # config.php が無ければ合言葉を自動生成して一緒に送る
    python tools/deploy_api.py --clean          # 初期設置の index.html / default_page.png を消す
    python tools/deploy_api.py --dry-run        # 送らずに何をするかだけ表示

接続情報は xserver/.ftp.env（git 管理外）か環境変数から読む。書式:

    FTP_HOST=svXXXX.xserver.jp
    FTP_USER=サーバーID
    FTP_PASS=FTPパスワード
    FTP_DIR=/hutsgo.com/public_html/api.hutsgo.com

パスワードは引数に書かない（履歴に残るため）。FTPS（明示的TLS）で接続し、平文FTPには落とさない。
"""
import argparse, ftplib, hashlib, os, pathlib, secrets, ssl, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "api" if (ROOT / "api").is_dir() else ROOT / "xserver" / "api"
ENV_FILE = ROOT / "xserver" / ".ftp.env"
FILES = [".htaccess", "common.php", "config.sample.php", "kpi.php", "post.php", "track.php"]
DEFAULTS = ["index.html", "default_page.png"]


def load_env() -> dict:
    env = {}
    if ENV_FILE.is_file():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("FTP_HOST", "FTP_USER", "FTP_PASS", "FTP_DIR"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    missing = [k for k in ("FTP_HOST", "FTP_USER", "FTP_PASS", "FTP_DIR") if not env.get(k)]
    if missing:
        sys.exit(f"接続情報が足りません: {', '.join(missing)}\n{ENV_FILE} を作るか環境変数で渡してください。\n{__doc__}")
    return env


def make_config() -> pathlib.Path:
    """config.php が無ければ sample から作り、kpi_token をランダムに置き換える。"""
    dst = SRC / "config.php"
    if dst.is_file():
        print("config.php: すでにあるのでそのまま使います")
        return dst
    token = secrets.token_hex(24)
    body = (SRC / "config.sample.php").read_text(encoding="utf-8").replace("CHANGE-ME", token)
    dst.write_text(body, encoding="utf-8")
    print(f"config.php: 作成しました。KPI の URL は\n  https://api.hutsgo.com/kpi.php?token={token}\nこの合言葉は config.php にだけあります。控えておいてください。")
    return dst


def connect(env: dict) -> ftplib.FTP_TLS:
    ctx = ssl.create_default_context()
    ftp = ftplib.FTP_TLS(context=ctx)
    ftp.connect(env["FTP_HOST"], int(env.get("FTP_PORT", 21)), timeout=30)
    ftp.login(env["FTP_USER"], env["FTP_PASS"])
    ftp.prot_p()          # データ接続も TLS にする
    ftp.set_pasv(True)
    return ftp


def remote_size(ftp: ftplib.FTP_TLS, name: str):
    try:
        return ftp.size(name)
    except ftplib.error_perm:
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--init-config", action="store_true", help="config.php を無ければ生成して送る")
    ap.add_argument("--clean", action="store_true", help="初期設置の index.html / default_page.png を削除する")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    env = load_env()
    send = list(FILES)
    if a.init_config:
        if a.dry_run:
            print("config.php: --dry-run なので生成しません（本番実行時に合言葉を作ります）")
        else:
            make_config()
        send.append("config.php")
    if a.dry_run and "config.php" in send and not (SRC / "config.php").is_file():
        send.remove("config.php")
    for f in send:
        if not (SRC / f).is_file():
            sys.exit(f"{SRC / f} がありません")

    print(f"{env['FTP_USER']}@{env['FTP_HOST']}:{env['FTP_DIR']} へ {len(send)} ファイル")
    if a.dry_run:
        for f in send:
            print("  送る:", f, (SRC / f).stat().st_size, "bytes")
        if a.clean:
            print("  消す:", ", ".join(DEFAULTS))
        return

    ftp = connect(env)
    try:
        ftp.cwd(env["FTP_DIR"])
        for f in send:
            local = SRC / f
            size = local.stat().st_size
            if remote_size(ftp, f) == size:
                print(f"  = {f}（変更なし）")
                continue
            with local.open("rb") as fh:
                ftp.storbinary("STOR " + f, fh)
            print(f"  → {f} ({size} bytes)")
        if a.clean:
            for f in DEFAULTS:
                try:
                    ftp.delete(f)
                    print(f"  × {f} を削除")
                except ftplib.error_perm:
                    pass
        names = ftp.nlst()
    finally:
        ftp.quit()
    print("サーバー上のファイル:", ", ".join(sorted(n.split("/")[-1] for n in names if not n.endswith(("/.", "/..")))))
    print("確認: https://api.hutsgo.com/kpi.php?token=<config.php の kpi_token>")


if __name__ == "__main__":
    main()
