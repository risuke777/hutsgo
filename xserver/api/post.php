<?php
// 「泊まった情報を送る」フォームの受け口。ログイン無し・承認制。
// そのまま公開はしない。data/posts/*.jsonl と data/uploads/ に溜め、運営者が tools/import_posts.py で seed.sql に取り込む。
declare(strict_types=1);
require __DIR__ . '/common.php';
$cfg = hg_config();
hg_cors($cfg);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function fail(int $code, string $msg): void { http_response_code($code); echo json_encode(['ok' => false, 'error' => $msg], JSON_UNESCAPED_UNICODE); exit; }

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { fail(405, 'method'); }
if (!hg_rate_limit($cfg, 'post', 5)) { fail(429, '送信が多すぎます。少し待ってからもう一度お願いします。'); }
if (($_POST['website'] ?? '') !== '') { echo '{"ok":true}'; exit; }   // honeypot: bot は黙って受け取ったふり

$hut = hg_slug($_POST['hut'] ?? '');
if ($hut === '') { fail(400, '小屋が指定されていません。'); }

$enum = function (string $key, array $allowed): string {
  $v = (string)($_POST[$key] ?? '');
  return in_array($v, $allowed, true) ? $v : '';
};
$stayed = (string)($_POST['stayed_on'] ?? '');
if ($stayed !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $stayed)) { $stayed = ''; }
$body = trim((string)($_POST['body'] ?? ''));
if (mb_strlen($body) > 1000) { $body = mb_substr($body, 0, 1000); }
$contact = trim((string)($_POST['contact'] ?? ''));   // 任意。確認したい時にだけ使う。公開しない
if (mb_strlen($contact) > 200) { $contact = mb_substr($contact, 0, 200); }

$photo = '';
if (!empty($_FILES['photo']['tmp_name']) && is_uploaded_file($_FILES['photo']['tmp_name'])) {
  $f = $_FILES['photo'];
  if ($f['size'] > $cfg['max_photo_bytes']) { fail(413, '写真は5MBまでにしてください。'); }
  $info = @getimagesize($f['tmp_name']);
  $ext = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'][$info['mime'] ?? ''] ?? '';
  if ($ext === '') { fail(415, '写真は JPEG / PNG / WebP のみ受け付けます。'); }
  $dir = hg_data_dir($cfg, 'uploads');
  $photo = date('Ymd') . '-' . $hut . '-' . bin2hex(random_bytes(6)) . '.' . $ext;
  if (!move_uploaded_file($f['tmp_name'], $dir . '/' . $photo)) { fail(500, '写真の保存に失敗しました。'); }
  // 位置情報などの EXIF は取り込み時（tools/import_posts.py）に必ず除去してから公開する
}

hg_append($cfg, 'posts', [
  'hut'       => $hut,
  'stayed_on' => $stayed,
  'plan'      => $enum('plan', ['two_meals', 'one_meal', 'no_meal', 'tent', 'private_room']),
  'toilet'    => $enum('toilet', ['flush', 'vault', 'composting', 'portable', 'none']),
  'water'     => $enum('water', ['free', 'paid', 'none']),
  'charging'  => $enum('charging', ['yes', 'no']),
  'payment'   => $enum('payment', ['cash_only', 'card', 'qr']),
  'shower'    => $enum('shower', ['yes', 'no']),
  'body'      => $body,
  'photo'     => $photo,
  'contact'   => $contact,
  'v'         => hg_visitor_hash(),
  'status'    => 'pending',
]);
echo '{"ok":true}';
