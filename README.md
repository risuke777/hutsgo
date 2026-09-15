# HutsGo

北アルプスの山小屋を「縦走の行程順」に並べるサイト。静的HTML生成。

## ローカルで見る
    python3 build.py
    cd dist && python3 -m http.server 8000

## 公開（Vercel、5分）
1. https://vercel.com/new → "Deploy without Git" は使わず、まず GitHub にこのフォルダを push
2. Vercel で Import → Framework: Other、Build Command: `pip install jinja2 && python3 build.py`、Output Directory: `dist`
3. Environment Variables に `SITE_URL=https://<あなたのドメイン>` を追加
4. Deploy。以後は git push で自動更新

Cloudflare Pages / Netlify も同じ設定で動く。
GitHub を使わない場合は `dist/` をそのまま Netlify Drop にドラッグしても公開できる。

## 独自ドメイン（hutsgo.com）で公開する
1. DNS: apex の A を GitHub Pages の 4 つ（185.199.108.153 / .109.153 / .110.153 / .111.153）に、www は CNAME で `risuke777.github.io` に向ける
2. GitHub のリポジトリ変数 `SITE_URL` に `https://hutsgo.com` を設定（build.py が `CNAME` ファイルを出力し、リンクのベースパスが `/` になる）
3. Settings → Pages → Custom domain に `hutsgo.com`、DNS チェック通過後に Enforce HTTPS を ON

## 言語
日本語を `/`、英語を `/en/` に出す。文言は `i18n.py`、データの英語は各テーブルの `_en` カラム。
英語版の狙いは訪日ハイカー（電話が使えず、受付開始を逃すと泊まれない層）なので、
`booking_opens_at_en`（受付がいつ開くか）が中核。小屋・登山口・山名は現地で指させるよう日本語を併記する。

## KPI
主 KPI は **送客率** = 小屋ページ閲覧 → 公式サイト / 予約ページ / 電話 のクリック（同一訪問者×小屋で 1 回）。
副 KPI は 投稿数（`post_submit`）、設備データ被覆率（`python demo.py`）、ドロミティ興味数（`interest_dolomiti`）。
登録ユーザー数は追わない（ログイン機能は作らない。投稿はログイン無し・承認制）。

計測はエックスサーバー上の自前 API。リポジトリ変数 `API_URL` を設定すると
`static/site.js` が `navigator.sendBeacon` でイベントを送り、小屋ページに「泊まった情報を送る」フォームが出る。
イベントには言語が乗るので、英語版と日本語版の送客率を並べて比較できる（英語版の仮説検証そのもの）。

確認と判断は 1 コマンド:

    python tools/kpi_report.py            # 送客率・言語別・小屋別・投稿・データ被覆率＋判断
    python tools/kpi_report.py --days 7
    python tools/kpi_report.py --save     # 生 JSON を tools/kpi/ に残して後で差分を見る

接続情報は `xserver/.kpi.env`（`.kpi.env.sample` をコピー、git 管理外）。
ブラウザで見るなら `https://api.hutsgo.com/kpi.php?token=<合言葉>`、JSON は `&format=json`。

## 写真
`static/img/` は運営者撮影のみ。`materials/` の元写真から PIL で 1600px / 800px に書き出し、EXIF（位置情報）は全て除去する。
掲載位置は `seed.sql` の `photos` テーブルで管理（hero / trail / hut / teaser / area）。背景には敷かない。

## 次の山域（ドロミティ）
Alta Via 1 は表銀座と同じ「線」のルートなので UI はそのまま使える。`hut_rates.currency` と `mountain_ranges.dolomites` は準備済み。
着手条件はトップの「ドロミティ版がほしい」の押下数。データは各リフージオの公式サイトで確認したものだけ載せる（日本と同じ基準）。

## データセット公開（/data/ と /api/）
サイト本体とは別に、確度メタデータを保ったまま JSON を公開している。

    dist/data/index.json   カタログ（版・ライセンス・被覆率・confidence の定義）
    dist/data/huts.json    21軒。営業・料金・設備・予約受付開始を、ブロックごとの provenance 付きで
    dist/data/trails.json  ルートを順序付きの地点列（標高・累積時間）で
    dist/api/index.html    項目の説明（英語）
    dist/llms.txt          AI 向けの入口

ライセンスは CC BY 4.0。`null` は「未確認」であって 0 ではない、という約束が中核。
2026 年の検索は 7 割近くがクリックを生まないので、人が来る前提の導線だけでは届かない。
AI が答える側に回ったときに引用される場所を取りにいくための布石。

## MCP サーバー
`xserver/api/mcp.php`。`https://api.hutsgo.com/mcp.php` で AI アシスタントにデータを渡す。

    claude mcp add --transport http hutsgo https://api.hutsgo.com/mcp.php

ツールは search_huts / get_hut / booking_windows / get_trail。
「null は未確認であって 0 ではない」をツール説明と応答の両方に書いてあり、
設備で絞ったときは「未確認ゆえに除外した数」を必ず返す。推測で埋めさせないため。
呼び出し数は KPI に乗る（ゼロクリック時代に、サイトに来ない利用を測る唯一の手段）。

## データの更新
- `seed.sql` が唯一の真実。編集して `python3 build.py`
- 公式サイトで確認したら `confidence` を `verified` に、`source_url` を公式 URL に、`last_verified_at` を当日に
- `huts.elevation_m` は公式サイト記載値のみ（`elevation_source='official'`）。稜線の小屋を地理院 API で埋めないこと（位置誤差が大きい）
- 設備 (`hut_facilities`) を埋めると小屋ページの「未確認」ブロックが自動でデータ表示に変わる

## 構成
    schema.sql   DBスキーマ（Postgres 移行可能）
    seed.sql     21軒のデータ
    build.py     SQLite → Jinja2 → dist/
    templates/   ページテンプレート
    static/      CSS / JS / favicon
    demo.py      スキーマ検証クエリ
