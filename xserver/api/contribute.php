<?php
// 山ムービーの「この道を HutsGo に提供する」の受け口。ログイン無し・承認制（A5）。IP は残さない（A6）。
// 受け取るのは、両端を切った道（時刻なし・ペースの比だけ）を圧縮したリンク文字列と、題・ひとこと・近いルートの id。
// 写真・動画は受け取らない。data/contrib/*.jsonl に溜め、運営者が tools/import_contrib.py で確かめてから載せる。
declare(strict_types=1);
require __DIR__ . '/common.php';
$cfg = hg_config();
hg_cors($cfg);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function fail(int $code, string $msg): void { http_response_code($code); echo json_encode(['ok' => false, 'error' => $msg], JSON_UNESCAPED_UNICODE); exit; }

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { fail(405, 'method'); }
if (!hg_rate_limit($cfg, 'contrib', 3)) { fail(429, '送信が多すぎます。少し待ってからもう一度お願いします。'); }
if (($_POST['website'] ?? '') !== '') { echo '{"ok":true}'; exit; }   // honeypot

$link = (string)($_POST['link'] ?? '');
if (!preg_match('/^v=z\.[A-Za-z0-9_-]{50,20000}$/', $link)) { fail(400, '道のデータを読めませんでした。'); }

// 題とひとこと: リンクは外して別枠に退避（公開しない。スパムの判定にだけ使う）
$links = [];
$clean = function (string $s, int $max) use (&$links): string {
  $s = preg_replace_callback('#(?:https?://|www\.)[^\s<>"\']{3,200}#iu', function ($m) use (&$links) { $links[] = $m[0]; return ''; }, $s);
  $s = trim(preg_replace('/\s{2,}/u', ' ', (string)$s));
  return mb_strlen($s) > $max ? mb_substr($s, 0, $max) : $s;
};
$title = $clean((string)($_POST['title'] ?? ''), 40);
$comment = $clean((string)($_POST['comment'] ?? ''), 200);
$trail = hg_slug($_POST['trail'] ?? '');
$region = in_array((string)($_POST['region'] ?? ''), ['jp', 'world'], true) ? (string)$_POST['region'] : '';
$km = max(0.0, min(500.0, (float)($_POST['km'] ?? 0)));
$up = max(0, min(20000, (int)($_POST['up'] ?? 0)));

hg_append($cfg, 'contrib', [
  'link'    => $link,
  'title'   => $title,
  'comment' => $comment,
  'links'   => array_slice($links, 0, 5),
  'trail'   => $trail,
  'region'  => $region,
  'km'      => round($km, 1),
  'up'      => $up,
  'v'       => hg_visitor_hash(),
  'status'  => 'pending',
]);
echo '{"ok":true}';
