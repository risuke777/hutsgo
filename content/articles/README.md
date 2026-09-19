# 記事の書き方

1 記事 = 1 ファイル。このフォルダに置いて push すれば公開される（`python build.py` がページを作る）。

| ファイル名 | 公開 URL |
|---|---|
| `<slug>.md` | `/articles/<slug>/`（日本語） |
| `<slug>.en.md` | `/en/articles/<slug>/`（英語） |

slug は英小文字・数字・ハイフン（例 `enzanso-2026-07`）。日英で同じ slug にすると言語切替で行き来できる。

## 先頭のメタ情報

```markdown
---
title: 燕山荘に泊まって表銀座を歩いた（2026年7月）
date: 2026-09-20
visited: 2026-07-18
summary: 一覧と検索結果に出る 1〜2 行の要約
huts: enzanso, daitenso
trails: omote_ginza
author: HutsGo 編集部
---

ここから本文（Markdown）。
```

| キー | 必須 | 中身 |
|---|---|---|
| `title` | ○ | 記事タイトル |
| `date` | ○ | 公開日 `YYYY-MM-DD`。新しい順に並ぶ |
| `visited` | | 実際に行った日。実地レポなら必ず書く |
| `summary` | | 要約。meta description にも使う |
| `huts` | | 関係する小屋の id（カンマ区切り）。その小屋ページに記事へのリンクが自動で出る |
| `trails` | | 関係するルートの id。同上 |
| `author` | | 書き手 |
| `draft` | | `true` にすると公開しない |

id は `seed.sql` の `huts.id` / `trails.id`。存在しない id を書くとビルドが止まる（リンク切れを出さないため）。

## 決まりごと

- **このリポジトリは public。** 下書きは `../docs/drafts/`（リポジトリの外）で書き、完成したらここへ移す。`draft: true` でも中身は GitHub から読める
- 写真は `static/img/` に置いて `![説明](/static/img/xxx.jpg)`。EXIF（位置情報）を消してから入れる
- 営業期間・料金など**小屋のデータは記事に書き写さない**。書くと古くなる。小屋ページへリンクする（`huts:` に書けば自動で出る）
- 設備など事実を見てきたら、記事とは別に `seed.sql` を更新する（`confidence='reported'`、公式で確認できたら `verified`）
