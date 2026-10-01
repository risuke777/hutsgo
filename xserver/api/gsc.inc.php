<?php
// Search Console API の最小クライアント（kpi.php から読む。直接は開けない: .htaccess）。
// 外部ライブラリなし: サービスアカウントの JWT を openssl_sign で署名してアクセストークンに換える。
//
// 設定（config.php）:
//   'gsc_key_file' => __DIR__ . '/data/gsc-key.json',   // サービスアカウントの JSON 鍵。data/ は外から読めない
//   'gsc_site'     => 'sc-domain:hutsgo.com',            // ドメインプロパティ
//   'gsc_sitemap'  => 'https://hutsgo.com/sitemap.xml',
//   'gsc_inspect'  => [ ... インデックス状況を見る URL ... ],
// 鍵が無ければ何もしない（分析画面は「未接続」と出すだけ）。
// 結果は data/gsc/ にキャッシュする。Search Console の数字は 2〜3 日遅れなので、毎回取りに行く意味が無い。
declare(strict_types=1);

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters';
const GSC_API = 'https://searchconsole.googleapis.com';

function gsc_enabled(array $cfg): bool {
  $f = $cfg['gsc_key_file'] ?? '';
  return $f !== '' && is_file($f) && !empty($cfg['gsc_site']);
}

function gsc_b64url(string $s): string {
  return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
}

function gsc_http(string $method, string $url, ?array $body, array $headers): array {
  $payload = $body === null ? null : json_encode($body, JSON_UNESCAPED_SLASHES);
  if ($payload !== null) { $headers[] = 'Content-Type: application/json'; }
  if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true,
      CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 20]);
    // 本文なしの PUT/POST も長さ 0 を明示する（無いと 411 Length Required になることがある）
    if ($payload !== null || $method !== 'GET') { curl_setopt($ch, CURLOPT_POSTFIELDS, $payload ?? ''); }
    $res = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
  } else {
    if ($method !== 'GET') { $headers[] = 'Content-Length: ' . strlen($payload ?? ''); }
    $ctx = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $headers),
      'content' => $payload ?? '', 'timeout' => 20, 'ignore_errors' => true]]);
    $res = @file_get_contents($url, false, $ctx);
    $code = 0;
    foreach ($http_response_header ?? [] as $hl) {
      if (preg_match('#^HTTP/\S+\s+(\d{3})#', $hl, $m)) { $code = (int)$m[1]; }
    }
  }
  $data = is_string($res) && $res !== '' ? json_decode($res, true) : null;
  return [$code, is_array($data) ? $data : []];
}

function gsc_cache_dir(array $cfg): string {
  return hg_data_dir($cfg, 'gsc');
}

function gsc_token(array $cfg): string {
  $cache = gsc_cache_dir($cfg) . '/token.json';
  $t = is_file($cache) ? json_decode((string)file_get_contents($cache), true) : null;
  if (is_array($t) && ($t['exp'] ?? 0) > time() + 60) { return (string)$t['token']; }

  $key = json_decode((string)file_get_contents($cfg['gsc_key_file']), true);
  if (!is_array($key) || empty($key['client_email']) || empty($key['private_key'])) {
    throw new RuntimeException('鍵ファイルの形式が違う（サービスアカウントの JSON 鍵を置く）');
  }
  $now = time();
  $head = gsc_b64url(json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
  $claim = gsc_b64url(json_encode(['iss' => $key['client_email'], 'scope' => GSC_SCOPE,
    'aud' => 'https://oauth2.googleapis.com/token', 'iat' => $now, 'exp' => $now + 3600]));
  $sig = '';
  if (!openssl_sign($head . '.' . $claim, $sig, $key['private_key'], OPENSSL_ALGO_SHA256)) {
    throw new RuntimeException('JWT の署名に失敗（openssl）');
  }
  $jwt = $head . '.' . $claim . '.' . gsc_b64url($sig);
  $ctx = stream_context_create(['http' => ['method' => 'POST', 'timeout' => 20, 'ignore_errors' => true,
    'header' => 'Content-Type: application/x-www-form-urlencoded',
    'content' => http_build_query(['grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'assertion' => $jwt])]]);
  // gsc_token_url / gsc_api_base は手元の試験用（偽のサーバーへ向ける）。本番の config.php には書かない
  $res = json_decode((string)@file_get_contents($cfg['gsc_token_url'] ?? 'https://oauth2.googleapis.com/token', false, $ctx), true);
  if (empty($res['access_token'])) {
    throw new RuntimeException('トークンを取れない: ' . ($res['error_description'] ?? $res['error'] ?? '応答なし'));
  }
  file_put_contents($cache, json_encode(['token' => $res['access_token'], 'exp' => $now + (int)($res['expires_in'] ?? 3600)]), LOCK_EX);
  return (string)$res['access_token'];
}

function gsc_call(array $cfg, string $method, string $path, ?array $body = null): array {
  [$code, $data] = gsc_http($method, ($cfg['gsc_api_base'] ?? GSC_API) . $path, $body, ['Authorization: Bearer ' . gsc_token($cfg)]);
  if ($code < 200 || $code >= 300) {
    $msg = $data['error']['message'] ?? ('HTTP ' . $code);
    if ($code === 403) { $msg .= '（サービスアカウントを Search Console のユーザーに追加したか確認）'; }
    throw new RuntimeException($msg);
  }
  return $data;
}

function gsc_site_path(array $cfg): string {
  return '/webmasters/v3/sites/' . rawurlencode((string)$cfg['gsc_site']);
}

// 検索パフォーマンス（期間内の合計と、指定の切り口ごとの上位）
function gsc_query(array $cfg, string $start, string $end, array $dims, int $limit): array {
  $body = ['startDate' => $start, 'endDate' => $end, 'rowLimit' => $limit, 'dataState' => 'all'];
  if ($dims) { $body['dimensions'] = $dims; }
  return gsc_call($cfg, 'POST', gsc_site_path($cfg) . '/searchAnalytics/query', $body)['rows'] ?? [];
}

function gsc_cached(array $cfg, string $name, int $ttl, callable $fn) {
  $f = gsc_cache_dir($cfg) . '/' . $name . '.json';
  if (is_file($f) && filemtime($f) > time() - $ttl) {
    return json_decode((string)file_get_contents($f), true);
  }
  $v = $fn();
  file_put_contents($f, json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
  return $v;
}

// 分析画面用にまとめて取る。失敗しても画面全体は落とさず、error に理由を入れて返す
function gsc_summary(array $cfg, bool $fresh = false): array {
  if (!gsc_enabled($cfg)) { return ['enabled' => false]; }
  $ttl = $fresh ? 0 : 6 * 3600;
  try {
    $perf = gsc_cached($cfg, 'performance', $ttl, function () use ($cfg) {
      $end = gmdate('Y-m-d');
      $start = gmdate('Y-m-d', time() - 27 * 86400);
      $pEnd = gmdate('Y-m-d', time() - 28 * 86400);
      $pStart = gmdate('Y-m-d', time() - 55 * 86400);
      $tot = fn(array $rows) => ['clicks' => (int)($rows[0]['clicks'] ?? 0), 'impressions' => (int)($rows[0]['impressions'] ?? 0),
                                 'ctr' => round((float)($rows[0]['ctr'] ?? 0) * 100, 1), 'position' => round((float)($rows[0]['position'] ?? 0), 1)];
      $rows = fn(array $r) => array_map(fn($x) => ['key' => $x['keys'][0] ?? '', 'clicks' => (int)$x['clicks'],
        'impressions' => (int)$x['impressions'], 'ctr' => round((float)$x['ctr'] * 100, 1), 'position' => round((float)$x['position'], 1)], $r);
      $daily = [];
      foreach (gsc_query($cfg, $start, $end, ['date'], 100) as $x) {
        $daily[$x['keys'][0]] = ['clicks' => (int)$x['clicks'], 'impressions' => (int)$x['impressions']];
      }
      ksort($daily);
      return [
        'range' => [$start, $end],
        'totals' => $tot(gsc_query($cfg, $start, $end, [], 1)),
        'prev' => $tot(gsc_query($cfg, $pStart, $pEnd, [], 1)),
        'daily' => $daily,
        'queries' => $rows(gsc_query($cfg, $start, $end, ['query'], 25)),
        'pages' => $rows(gsc_query($cfg, $start, $end, ['page'], 25)),
        'countries' => $rows(gsc_query($cfg, $start, $end, ['country'], 10)),
      ];
    });
    $sitemaps = gsc_cached($cfg, 'sitemaps', $fresh ? 0 : 3600, fn() => gsc_call($cfg, 'GET', gsc_site_path($cfg) . '/sitemaps')['sitemap'] ?? []);
    $inspect = gsc_cached($cfg, 'inspect', $fresh ? 0 : 24 * 3600, function () use ($cfg) {
      $out = [];
      foreach (array_slice($cfg['gsc_inspect'] ?? [], 0, 12) as $u) {
        try {
          $r = gsc_call($cfg, 'POST', '/v1/urlInspection/index:inspect',
                        ['inspectionUrl' => $u, 'siteUrl' => $cfg['gsc_site'], 'languageCode' => 'ja']);
          $s = $r['inspectionResult']['indexStatusResult'] ?? [];
          $out[$u] = ['verdict' => $s['verdict'] ?? '', 'coverage' => $s['coverageState'] ?? '',
                      'last_crawl' => $s['lastCrawlTime'] ?? '', 'canonical' => $s['googleCanonical'] ?? ''];
        } catch (Throwable $e) {
          $out[$u] = ['verdict' => 'ERROR', 'coverage' => $e->getMessage(), 'last_crawl' => '', 'canonical' => ''];
        }
      }
      return $out;
    });
    return ['enabled' => true, 'performance' => $perf, 'sitemaps' => $sitemaps, 'inspect' => $inspect];
  } catch (Throwable $e) {
    return ['enabled' => true, 'error' => $e->getMessage()];
  }
}

function gsc_submit_sitemap(array $cfg): string {
  $sm = (string)($cfg['gsc_sitemap'] ?? '');
  if ($sm === '') { throw new RuntimeException('gsc_sitemap が未設定'); }
  gsc_call($cfg, 'PUT', gsc_site_path($cfg) . '/sitemaps/' . rawurlencode($sm));
  @unlink(gsc_cache_dir($cfg) . '/sitemaps.json');   // 次の表示で状態を取り直す
  return $sm;
}
