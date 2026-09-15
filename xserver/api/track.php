<?php
// 計測イベント受け口。site.js から navigator.sendBeacon で JSON が来る。
// 保存するのは ev / lang / hut / trail / page / ref のホスト名 / 訪問者ハッシュ(日替わり) だけ。
// IP・UA の生値は残さない。Cookie も使わない。
declare(strict_types=1);
require __DIR__ . '/common.php';
$cfg = hg_config();
hg_cors($cfg);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { http_response_code(405); echo '{"ok":false}'; exit; }
$raw = file_get_contents('php://input', false, null, 0, 2048);
$in = json_decode((string)$raw, true);
if (!is_array($in)) { http_response_code(400); echo '{"ok":false}'; exit; }

$allowed_ev = ['pageview', 'outbound_official_site', 'outbound_reservation', 'outbound_phone', 'outbound_access',
               'change_date', 'interest_dolomiti', 'post_submit', 'profile_marker', 'route', 'lang_switch'];
$ev = (string)($in['ev'] ?? '');
if (!in_array($ev, $allowed_ev, true)) { http_response_code(400); echo '{"ok":false}'; exit; }
if (!hg_rate_limit($cfg, 'track', 120)) { http_response_code(429); echo '{"ok":false}'; exit; }

$lang = (string)($in['lang'] ?? '');
if (!in_array($lang, ['ja', 'en'], true)) { $lang = 'ja'; }

$page = (string)($in['page'] ?? '');
if (!preg_match('#^/[A-Za-z0-9_\-/]{0,120}$#', $page)) { $page = ''; }
$ref = (string)($in['ref'] ?? '');
$ref = preg_match('#^https?://[^\s"<>]{1,200}$#', $ref) ? (string)parse_url($ref, PHP_URL_HOST) : '';

hg_append($cfg, 'events', [
  'ev'    => $ev,
  'lang'  => $lang,
  'hut'   => hg_slug($in['hut'] ?? ''),
  'trail' => hg_slug($in['trail'] ?? ''),
  'page'  => $page,
  'ref'   => $ref,
  'v'     => hg_visitor_hash(),
]);
echo '{"ok":true}';
