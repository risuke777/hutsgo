<?php
// HutsGo MCP サーバー（Streamable HTTP / JSON-RPC 2.0、ステートレス）
//
//   エンドポイント: https://api.hutsgo.com/mcp.php
//   データ: https://hutsgo.com/data/*.json を取得して 1 時間キャッシュ
//
// 設計方針
//   - 状態を持たない。セッションも SSE も使わない。POST 1 回で 1 応答。
//     山小屋データは読み取り専用なので、これで足りる。
//   - 「null は未確認であって 0 ではない」をツール説明と応答の両方に書く。
//     モデルが欠損値を推測で埋めると、山では危険につながる。
//   - 設備で絞り込むと「まだ確認していない小屋」まで消える。消した数を必ず返す。
//   - 呼び出しを events に記録する。静的ホスティングでは測れない利用状況が、
//     これで KPI に乗る（tools/kpi_report.py が読む）。
declare(strict_types=1);
require __DIR__ . '/common.php';

$cfg = hg_config();
const MCP_PROTOCOL = '2025-06-18';
const MCP_NAME = 'hutsgo';
const MCP_VERSION = '1.0.0';
// 既定は本番。ローカル検証では HUTSGO_DATA_BASE で差し替える
define('DATA_BASE', getenv('HUTSGO_DATA_BASE') ?: 'https://hutsgo.com/data');
const CACHE_TTL = 3600;

// ---- transport ------------------------------------------------------
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '') {
  // MCP クライアントはブラウザ外からも来る。Origin があるときだけ検証する。
  header('Access-Control-Allow-Origin: ' . $origin);
  header('Access-Control-Allow-Headers: Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Authorization');
  header('Access-Control-Allow-Methods: POST, OPTIONS');
  header('Vary: Origin');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
  // SSE ストリームは提供しない。ステートレスなのでクライアントは POST だけで足りる。
  http_response_code(405);
  header('Allow: POST, OPTIONS');
  echo json_encode(['jsonrpc' => '2.0', 'error' => ['code' => -32000,
    'message' => 'This server is stateless. POST JSON-RPC requests to this same URL.']]);
  exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { http_response_code(405); exit; }

function rpc_result($id, array $result): void {
  echo json_encode(['jsonrpc' => '2.0', 'id' => $id, 'result' => $result],
                   JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}
function rpc_error($id, int $code, string $message): void {
  echo json_encode(['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => $code, 'message' => $message]],
                   JSON_UNESCAPED_UNICODE);
  exit;
}

$raw = file_get_contents('php://input', false, null, 0, 256 * 1024);
$req = json_decode((string)$raw, true);
if (!is_array($req)) { rpc_error(null, -32700, 'Parse error'); }
if (isset($req[0])) { rpc_error(null, -32600, 'Batch requests are not supported.'); }

$id = $req['id'] ?? null;
$method = (string)($req['method'] ?? '');
$params = is_array($req['params'] ?? null) ? $req['params'] : [];

// 通知（id 無し）は 202 を返して終わり
if ($id === null && strpos($method, 'notifications/') === 0) { http_response_code(202); exit; }

if (!hg_rate_limit($cfg, 'mcp', 240)) { rpc_error($id, -32000, 'Too many requests. Try again shortly.'); }

// ---- data -----------------------------------------------------------
function load(string $name): array {
  global $cfg;
  $dir = hg_data_dir($cfg, 'cache');
  $f = $dir . '/' . $name . '.json';
  if (is_file($f) && (time() - filemtime($f)) < CACHE_TTL) {
    $d = json_decode((string)file_get_contents($f), true);
    if (is_array($d)) { return $d; }
  }
  $body = null;
  if (function_exists('curl_init')) {
    $ch = curl_init(DATA_BASE . '/' . $name . '.json');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
                            CURLOPT_FOLLOWLOCATION => true, CURLOPT_USERAGENT => 'hutsgo-mcp/1.0']);
    $body = curl_exec($ch);
    curl_close($ch);
  }
  if (!is_string($body) || $body === '') { $body = @file_get_contents(DATA_BASE . '/' . $name . '.json'); }
  $d = is_string($body) ? json_decode($body, true) : null;
  if (is_array($d)) { file_put_contents($f, $body, LOCK_EX); return $d; }
  if (is_file($f)) {                       // 取得に失敗したら期限切れキャッシュで凌ぐ
    $d = json_decode((string)file_get_contents($f), true);
    if (is_array($d)) { return $d; }
  }
  return [];
}

// ---- tools ----------------------------------------------------------
const NULL_CONTRACT = 'Any field that is null or missing means HutsGo has not confirmed it. '
  . 'It does not mean zero, none, or unavailable. Never infer a missing value: mountain information '
  . 'is safety-relevant. When you quote a value, also give its provenance.confidence and '
  . 'provenance.last_verified_at, and link the hut official_url so the reader can check before travelling.';

function tool_defs(): array {
  return [
    [
      'name' => 'search_huts',
      'description' =>
        "Find mountain huts in the Northern Japan Alps that match a plan: a date they are open, a "
        . "price ceiling, an area, or a facility you need. Returns a compact list; call get_hut for "
        . "the full record.\n\n"
        . "Filtering on a facility only matches huts where that facility is CONFIRMED. Huts we have "
        . "not checked are excluded, and the response reports how many were excluded that way, so you "
        . "can tell the user the list may be incomplete rather than implying those huts lack the facility.\n\n"
        . NULL_CONTRACT,
      'inputSchema' => [
        'type' => 'object',
        'properties' => [
          'date' => ['type' => 'string', 'description' => 'YYYY-MM-DD. Keep only huts open on this date in the 2026 season.'],
          'area_id' => ['type' => 'string', 'enum' => ['omote_ginza', 'yari_hotaka', 'kamikochi'],
                        'description' => 'omote_ginza = Omote-Ginza and Jonen ridges; yari_hotaka = Yari and Hotaka; kamikochi = the Kamikochi valley.'],
          'plan' => ['type' => 'string', 'enum' => ['two_meals', 'one_meal', 'no_meal', 'tent', 'private_room'],
                     'description' => 'Which rate to compare on. Default two_meals (dinner and breakfast).'],
          'max_price_jpy' => ['type' => 'integer', 'description' => 'Ceiling for the chosen plan, in yen.'],
          'requires' => [
            'type' => 'array',
            'items' => ['type' => 'string', 'enum' => ['tent_site', 'toilet', 'water_free', 'charging', 'shower', 'bath', 'card_payment']],
            'description' => 'Facilities that must be CONFIRMED present. Use sparingly: facility data is only filled in for some huts.',
          ],
          'limit' => ['type' => 'integer', 'description' => 'Max results, default 25.'],
        ],
      ],
    ],
    [
      'name' => 'get_hut',
      'description' =>
        "Full record for one hut: 2026 season dates, prices per plan, facilities, mobile signal, "
        . "capacity, how to book, and the booking window. Every block carries its own provenance.\n\n"
        . NULL_CONTRACT,
      'inputSchema' => [
        'type' => 'object',
        'properties' => ['hut_id' => ['type' => 'string', 'description' => 'Hut id, e.g. enzanso. Use search_huts or list_trails to find ids.']],
        'required' => ['hut_id'],
      ],
    ],
    [
      'name' => 'booking_windows',
      'description' =>
        "When each hut starts taking reservations, plus the phone number and booking URL.\n\n"
        . "This is the thing that actually stops visitors from abroad. Japanese huts take bookings by "
        . "phone, in Japanese, and the popular ones fill within minutes of the window opening. Each hut "
        . "publishes its window on its own site in Japanese prose and nowhere else in structured form. "
        . "All times are Japan Standard Time (UTC+9).\n\n"
        . NULL_CONTRACT,
      'inputSchema' => [
        'type' => 'object',
        'properties' => [
          'hut_ids' => ['type' => 'array', 'items' => ['type' => 'string'],
                        'description' => 'Limit to these huts. Omit for all of them.'],
          'trail_id' => ['type' => 'string', 'description' => 'Limit to the huts on one route, in walking order.'],
        ],
      ],
    ],
    [
      'name' => 'get_trail',
      'description' =>
        "A traverse as an ordered list of stops: trailheads, huts you can sleep at, and peaks you pass, "
        . "each with elevation and cumulative walking time from the start. Use this to lay out an "
        . "itinerary night by night.\n\n"
        . "Walking times are standard snow-free course times and exclude breaks. Do not propose a day "
        . "that a reader has not told you they can manage; state the hours and ascent and let them "
        . "decide.\n\n" . NULL_CONTRACT,
      'inputSchema' => [
        'type' => 'object',
        'properties' => ['trail_id' => ['type' => 'string', 'description' => 'Omit to list every route with its id and summary.']],
      ],
    ],
  ];
}

function open_on(array $se, string $date): bool {
  $st = $se['status'] ?? '';
  if ($st === 'year_round') { return true; }
  if ($st === 'open' && !empty($se['open_date']) && !empty($se['close_date'])) {
    return $date >= $se['open_date'] && $date <= $se['close_date'];
  }
  return false;
}

// 設備の要求 → [判定関数, 何を見ているか]
function facility_ok(array $h, string $need): ?bool {
  $f = $h['facilities'] ?? null;
  $se = $h['season_2026'] ?? null;
  switch ($need) {
    case 'tent_site':    $v = $se['capacity']['tents'] ?? null; return $v === null ? null : $v > 0;
    case 'toilet':       $v = $f['toilet_type'] ?? null; return $v === null ? null : $v !== 'none';
    case 'water_free':   $v = $f['water_available'] ?? null; return $v === null ? null : $v === 'free';
    case 'charging':     $v = $f['charging_service'] ?? null;
                         if ($v === null) { $v = $f['power_outlet'] ?? null; }
                         return $v === null ? null : (bool)$v;
    case 'shower':       $v = $f['shower'] ?? null; return $v === null ? null : (bool)$v;
    case 'bath':         $v = $f['bath'] ?? null; return $v === null ? null : (bool)$v;
    case 'card_payment': $v = $f['credit_card'] ?? null; return $v === null ? null : (bool)$v;
  }
  return null;
}

function brief(array $h, string $plan): array {
  $se = $h['season_2026'] ?? [];
  $rate = null;
  foreach ($h['rates_2026'] ?? [] as $r) { if ($r['plan'] === $plan) { $rate = $r; break; } }
  return [
    'hut_id' => $h['id'],
    'name_en' => $h['name']['en'] ?? null,
    'name_ja' => $h['name']['ja'] ?? null,
    'area' => $h['area']['id'] ?? null,
    'elevation_m' => $h['location']['elevation_m'] ?? null,
    'open_date' => $se['open_date'] ?? null,
    'close_date' => $se['close_date'] ?? null,
    'status' => $se['status'] ?? null,
    'price_jpy' => $rate['price_jpy'] ?? ($rate['price'] ?? null),
    'price_plan' => $plan,
    'price_is_from' => $rate['is_from_price'] ?? null,
    'tent_capacity' => $se['capacity']['tents'] ?? null,
    'booking_opens_at_en' => $se['reservation']['opens_at']['en'] ?? null,
    'confidence' => $se['provenance']['confidence'] ?? null,
    'last_verified_at' => $se['provenance']['last_verified_at'] ?? null,
    'page_en' => 'https://hutsgo.com/en/huts/' . $h['id'] . '/',
    'official_url' => $h['official_url'] ?? null,
  ];
}

function call_tool(string $name, array $args): array {
  $huts = load('huts');
  if (!$huts) { return ['error' => 'The dataset could not be loaded right now. Try again shortly.']; }

  if ($name === 'search_huts') {
    $plan = $args['plan'] ?? 'two_meals';
    $limit = max(1, min(50, (int)($args['limit'] ?? 25)));
    $requires = is_array($args['requires'] ?? null) ? $args['requires'] : [];
    $out = []; $excluded_unconfirmed = []; $closed = 0;
    foreach ($huts as $h) {
      $se = $h['season_2026'] ?? null;
      if (!empty($args['area_id']) && ($h['area']['id'] ?? '') !== $args['area_id']) { continue; }
      if (!empty($args['date'])) {
        if (!$se || !open_on($se, (string)$args['date'])) { $closed++; continue; }
      }
      if (!empty($args['max_price_jpy'])) {
        $price = null;
        foreach ($h['rates_2026'] ?? [] as $r) { if ($r['plan'] === $plan) { $price = $r['price'] ?? null; } }
        if ($price === null || $price > (int)$args['max_price_jpy']) { continue; }
      }
      $skip = false;
      foreach ($requires as $need) {
        $ok = facility_ok($h, (string)$need);
        if ($ok === null) { $excluded_unconfirmed[$need][] = $h['id']; $skip = true; break; }
        if ($ok !== true) { $skip = true; break; }
      }
      if ($skip) { continue; }
      $out[] = brief($h, $plan);
    }
    usort($out, fn($a, $b) => ($a['price_jpy'] ?? PHP_INT_MAX) <=> ($b['price_jpy'] ?? PHP_INT_MAX));
    $res = ['matches' => count($out), 'huts' => array_slice($out, 0, $limit), 'note' => NULL_CONTRACT];
    if ($excluded_unconfirmed) {
      $res['excluded_because_unconfirmed'] = $excluded_unconfirmed;
      $res['warning'] = 'Some huts were left out only because that facility has not been checked yet, '
        . 'not because they lack it. Say so rather than presenting this list as complete.';
    }
    if (!empty($args['date'])) { $res['excluded_not_open_on_date'] = $closed; }
    return $res;
  }

  if ($name === 'get_hut') {
    $wanted = (string)($args['hut_id'] ?? '');
    foreach ($huts as $h) {
      if ($h['id'] === $wanted) {
        $h['page_en'] = 'https://hutsgo.com/en/huts/' . $h['id'] . '/';
        $h['page_ja'] = 'https://hutsgo.com/huts/' . $h['id'] . '/';
        $h['note'] = NULL_CONTRACT;
        return $h;
      }
    }
    return ['error' => 'No hut with id ' . $wanted . '. Call search_huts or get_trail to find valid ids.'];
  }

  if ($name === 'booking_windows') {
    $ids = null;
    if (!empty($args['trail_id'])) {
      $ids = [];
      foreach (load('trails') as $t) {
        if ($t['id'] === $args['trail_id']) {
          foreach ($t['stops'] as $st) { if (!empty($st['hut_id'])) { $ids[] = $st['hut_id']; } }
        }
      }
    } elseif (is_array($args['hut_ids'] ?? null)) {
      $ids = $args['hut_ids'];
    }
    $out = []; $missing = [];
    foreach ($huts as $h) {
      if ($ids !== null && !in_array($h['id'], $ids, true)) { continue; }
      $r = $h['season_2026']['reservation'] ?? [];
      $row = [
        'hut_id' => $h['id'],
        'name_en' => $h['name']['en'] ?? null,
        'name_ja' => $h['name']['ja'] ?? null,
        'opens_at_en' => $r['opens_at']['en'] ?? null,
        'opens_at_ja' => $r['opens_at']['ja'] ?? null,
        'reservation_required' => $r['required'] ?? null,
        'booking_url' => $r['url'] ?? null,
        'phone' => $r['phone'] ?? null,
        'confidence' => $h['season_2026']['provenance']['confidence'] ?? null,
        'last_verified_at' => $h['season_2026']['provenance']['last_verified_at'] ?? null,
        'official_url' => $h['official_url'] ?? null,
      ];
      if ($row['opens_at_en'] === null) { $missing[] = $h['id']; }
      $out[] = $row;
    }
    if ($ids !== null) {
      $order = array_flip($ids);
      usort($out, fn($a, $b) => ($order[$a['hut_id']] ?? 99) <=> ($order[$b['hut_id']] ?? 99));
    }
    return [
      'timezone' => 'Asia/Tokyo (JST, UTC+9)',
      'huts' => $out,
      'not_confirmed_for' => $missing,
      'how_to_use' => 'Popular huts fill within minutes of the window opening. Tell the reader the exact '
        . 'opening moment in their own timezone, and that most huts answer the phone in Japanese only. '
        . 'Where booking_url is present it is usually the easier route for a non-Japanese speaker.',
      'note' => NULL_CONTRACT,
    ];
  }

  if ($name === 'get_trail') {
    $trails = load('trails');
    if (empty($args['trail_id'])) {
      return ['trails' => array_map(fn($t) => [
        'trail_id' => $t['id'], 'name_en' => $t['name']['en'] ?? null, 'name_ja' => $t['name']['ja'] ?? null,
        'summary_en' => $t['summary']['en'] ?? null, 'nights_typical' => $t['nights_typical'],
        'difficulty' => $t['difficulty'],
        'page_en' => 'https://hutsgo.com/en/trails/' . $t['id'] . '/',
      ], $trails)];
    }
    foreach ($trails as $t) {
      if ($t['id'] === $args['trail_id']) {
        $t['page_en'] = 'https://hutsgo.com/en/trails/' . $t['id'] . '/';
        $t['walking_times'] = 'cumulative_time_min is standard snow-free course time from the start, excluding breaks.';
        $t['note'] = NULL_CONTRACT;
        return $t;
      }
    }
    return ['error' => 'No trail with id ' . $args['trail_id'] . '. Call get_trail with no arguments to list them.'];
  }
  return ['error' => 'Unknown tool ' . $name];
}

// ---- dispatch -------------------------------------------------------
switch ($method) {
  case 'initialize':
    $client = (string)($params['protocolVersion'] ?? MCP_PROTOCOL);
    hg_append($cfg, 'events', ['ev' => 'mcp_initialize', 'lang' => '', 'hut' => '', 'trail' => '',
                               'page' => '/mcp', 'ref' => '', 'v' => hg_visitor_hash()]);
    rpc_result($id, [
      'protocolVersion' => in_array($client, ['2025-03-26', '2025-06-18'], true) ? $client : MCP_PROTOCOL,
      'capabilities' => ['tools' => ['listChanged' => false]],
      'serverInfo' => ['name' => MCP_NAME, 'version' => MCP_VERSION,
                       'title' => 'HutsGo — Japan Alps mountain huts'],
      'instructions' =>
        "Verified data on mountain huts in the Northern Japan Alps (2026 season): opening dates, "
        . "prices, facilities, capacity, and above all when each hut starts taking bookings.\n\n"
        . NULL_CONTRACT . "\n\nSource: https://hutsgo.com/ . Data licensed CC BY 4.0; please credit HutsGo.",
    ]);

  case 'ping':
    rpc_result($id, []);

  case 'tools/list':
    rpc_result($id, ['tools' => tool_defs()]);

  case 'tools/call':
    $name = (string)($params['name'] ?? '');
    $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
    $known = array_column(tool_defs(), 'name');
    if (!in_array($name, $known, true)) { rpc_error($id, -32602, 'Unknown tool: ' . $name); }
    $result = call_tool($name, $args);
    // 静的ホスティングでは測れない利用状況を、ここで KPI に乗せる
    hg_append($cfg, 'events', [
      'ev' => 'mcp_' . $name, 'lang' => '',
      'hut' => hg_slug($args['hut_id'] ?? ''), 'trail' => hg_slug($args['trail_id'] ?? ''),
      'page' => '/mcp', 'ref' => '', 'v' => hg_visitor_hash(),
    ]);
    rpc_result($id, [
      'content' => [['type' => 'text',
                     'text' => json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT)]],
      'structuredContent' => $result,
      'isError' => isset($result['error']),
    ]);

  default:
    rpc_error($id, -32601, 'Method not found: ' . $method);
}
