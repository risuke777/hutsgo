<?php
// config.sample.php → config.php にコピーして値を入れる。config.php は git に入れない。
return [
  // 計測を受け付けるサイトのオリジン。ここ以外からの送信は捨てる
  'allowed_origins' => ['https://hutsgo.com', 'https://www.hutsgo.com', 'https://risuke777.github.io'],
  // kpi.php を開くための合言葉。長いランダム文字列にする（例: openssl rand -hex 24）
  'kpi_token'       => 'CHANGE-ME',
  // データ置き場（このディレクトリ配下。.htaccess で外部からは読めない）
  'data_dir'        => __DIR__ . '/data',
  // 投稿写真の上限（バイト）
  'max_photo_bytes' => 5 * 1024 * 1024,
];
