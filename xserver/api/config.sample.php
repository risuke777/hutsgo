<?php
// config.sample.php → config.php にコピーして値を入れる。config.php は git に入れない。
return [
  // 計測を受け付けるサイトのオリジン。ここ以外からの送信は捨てる
  'allowed_origins' => ['https://hutsgo.com', 'https://www.hutsgo.com', 'https://risuke777.github.io'],
  // kpi.php を開くための合言葉。長いランダム文字列にする（例: openssl rand -hex 24）
  'kpi_token'       => 'CHANGE-ME',
  // データ置き場（このディレクトリ配下。.htaccess で外部からは読めない）
  'data_dir'        => __DIR__ . '/data',
  // 投稿写真の上限（バイト）。受け取った後に下のサイズまで縮小する
  'max_photo_bytes' => 8 * 1024 * 1024,
  // 保存時の長辺ピクセルと JPEG 品質。再エンコードで EXIF（位置情報）も消える
  'max_photo_edge'  => 1600,
  'photo_quality'   => 78,
  // Search Console（任意）。鍵が無ければ分析画面は「未接続」と出すだけ。
  // サービスアカウントの JSON 鍵を data/ の下に置く（data/ は .htaccess で外から読めない）。
  // そのサービスアカウントのメールを Search Console の「ユーザーと権限」に「フル」で追加しておく。
  'gsc_key_file'    => __DIR__ . '/data/gsc-key.json',
  'gsc_site'        => 'sc-domain:hutsgo.com',
  'gsc_sitemap'     => 'https://hutsgo.com/sitemap.xml',
  // インデックス状況を見る URL（URL 検査 API は 1 日 2000 回まで。ここは 24 時間キャッシュ）
  'gsc_inspect'     => [
    'https://hutsgo.com/', 'https://hutsgo.com/en/', 'https://hutsgo.com/plan/', 'https://hutsgo.com/en/plan/',
    'https://hutsgo.com/booking/', 'https://hutsgo.com/en/booking/', 'https://hutsgo.com/trails/omote_ginza/',
    'https://hutsgo.com/en/trails/omote_ginza/', 'https://hutsgo.com/huts/yarigatake_sanso/',
    'https://hutsgo.com/en/huts/yarigatake_sanso/', 'https://hutsgo.com/api/',
  ],
];
