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

## KPI 計測の有効化
`ANALYTICS_SNIPPET` 環境変数に Plausible / Umami / GA4 のスクリプトタグを入れて build。
公式サイトへのクリックは自動で `outbound_official_site` / `outbound_phone` イベントとして送られる（hut ID 付き）。
見るべき数字は 3 つ:
- オーガニック検索セッション（週次）
- `/huts/<id>/` の閲覧数 → outbound クリック率
- 日付フィルタの利用率（`change_date`）

## データの更新
- `seed.sql` が唯一の真実。編集して `python3 build.py`
- 公式サイトで確認したら `confidence` を `verified` に、`last_verified_at` を当日に
- 設備 (`hut_facilities`) を埋めると小屋ページの「未確認」ブロックが自動でデータ表示に変わる

## 構成
    schema.sql   DBスキーマ（Postgres 移行可能）
    seed.sql     21軒のデータ
    build.py     SQLite → Jinja2 → dist/
    templates/   ページテンプレート
    static/      CSS / JS / favicon
    demo.py      スキーマ検証クエリ
