<?php
// HutsGo API 共通: 設定読み込み、CORS、保存先。PHP 7.4+ / XServer 標準で動く。
declare(strict_types=1);

function hg_config(): array {
  $f = __DIR__ . '/config.php';
  if (!is_file($f)) { http_response_code(500); exit('config.php missing'); }
  return require $f;
}

function hg_cors(array $cfg): void {
  $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
  if ($origin !== '' && in_array($origin, $cfg['allowed_origins'], true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
  }
  if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
}

function hg_data_dir(array $cfg, string $sub): string {
  $d = rtrim($cfg['data_dir'], '/') . '/' . $sub;
  if (!is_dir($d)) { mkdir($d, 0750, true); }
  return $d;
}

// 1 行 1 JSON で追記。月ごとにファイルを分ける。
function hg_append(array $cfg, string $sub, array $row): void {
  $d = hg_data_dir($cfg, $sub);
  $f = $d . '/' . date('Y-m') . '.jsonl';
  $row['ts'] = gmdate('c');
  file_put_contents($f, json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
}

// 個人特定しない範囲での重複除去用。IP はそのまま保存しない。
function hg_visitor_hash(): string {
  $ip = $_SERVER['REMOTE_ADDR'] ?? '';
  $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
  return substr(hash('sha256', $ip . '|' . $ua . '|' . date('Y-m-d')), 0, 16);
}

// ごく簡単な流量制限: 同一 visitor は 1 分に N 回まで
function hg_rate_limit(array $cfg, string $bucket, int $limit): bool {
  $d = hg_data_dir($cfg, 'rl');
  $f = $d . '/' . $bucket . '-' . hg_visitor_hash() . '-' . date('YmdHi');
  $n = is_file($f) ? (int)file_get_contents($f) : 0;
  if ($n >= $limit) { return false; }
  file_put_contents($f, (string)($n + 1), LOCK_EX);
  // 古いカウンタを気まぐれに掃除
  if (random_int(1, 50) === 1) {
    foreach (glob($d . '/*') as $g) { if (filemtime($g) < time() - 600) { @unlink($g); } }
  }
  return true;
}

function hg_slug(?string $s, int $max = 64): string {
  $s = (string)$s;
  return preg_match('/^[a-z0-9_\-]{1,' . $max . '}$/', $s) ? $s : '';
}

// 投稿写真を保存する。GD があれば長辺 $edge の JPEG に再エンコードして保存し、
// 同時に EXIF（位置情報・端末名）を落とす。GD が無いサーバーでは原本を移すだけにする。
function hg_store_image(string $tmp, string $dest, string $ext, int $edge = 1600, int $quality = 78): bool {
  if (!function_exists('imagecreatetruecolor')) {
    return move_uploaded_file($tmp, $dest);   // GD 無し: 原本のまま（取り込み時に縮小する）
  }
  $load = ['jpg' => 'imagecreatefromjpeg', 'png' => 'imagecreatefrompng', 'webp' => 'imagecreatefromwebp'][$ext] ?? '';
  if ($load === '' || !function_exists($load)) { return move_uploaded_file($tmp, $dest); }
  $src = @$load($tmp);
  if (!$src) { return move_uploaded_file($tmp, $dest); }
  $w = imagesx($src); $h = imagesy($src);
  $scale = min(1.0, $edge / max($w, $h));
  $nw = max(1, (int)round($w * $scale)); $nh = max(1, (int)round($h * $scale));
  $dst = imagecreatetruecolor($nw, $nh);
  imagefill($dst, 0, 0, imagecolorallocate($dst, 255, 255, 255));   // 透過 PNG を白背景に
  imagecopyresampled($dst, $src, 0, 0, 0, 0, $nw, $nh, $w, $h);
  $ok = imagejpeg($dst, $dest, $quality);                            // JPEG 再エンコード = EXIF が消える
  imagedestroy($src); imagedestroy($dst);
  if ($ok) { @unlink($tmp); }
  return (bool)$ok;
}

// 公開データ（hutsgo.com/data/<name>.json）を取得してキャッシュする。mcp.php と kpi.php が使う。
// 取得に失敗したら期限切れのキャッシュで凌ぐ。どちらも無ければ空配列。
function hg_public_data(array $cfg, string $name, string $base, int $ttl): array {
  $f = hg_data_dir($cfg, 'cache') . '/' . $name . '.json';
  if (is_file($f) && (time() - filemtime($f)) < $ttl) {
    $d = json_decode((string)file_get_contents($f), true);
    if (is_array($d)) { return $d; }
  }
  $body = null;
  if (function_exists('curl_init')) {
    $ch = curl_init($base . '/' . $name . '.json');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
                            CURLOPT_FOLLOWLOCATION => true, CURLOPT_USERAGENT => 'hutsgo-api/1.0']);
    $body = curl_exec($ch);
    curl_close($ch);
  }
  if (!is_string($body) || $body === '') { $body = @file_get_contents($base . '/' . $name . '.json'); }
  $d = is_string($body) ? json_decode($body, true) : null;
  if (is_array($d)) { file_put_contents($f, $body, LOCK_EX); return $d; }
  if (is_file($f)) {
    $d = json_decode((string)file_get_contents($f), true);
    if (is_array($d)) { return $d; }
  }
  return [];
}
