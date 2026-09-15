<?php
// KPI ダッシュボード。
//   画面 : https://api.hutsgo.com/kpi.php?token=<kpi_token>&days=30
//   JSON : 同じ URL に &format=json   （tools/kpi_report.py が読む）
//
// 主KPI  = 送客率: 小屋ページを見た人のうち、公式サイト/予約ページ/電話を押した割合
//          （同一訪問者×小屋を 1 と数える。連打で膨らませない）
// 仮説検証 = 言語別の送客率。英語版は「電話が使えない層」なので、送客率が日本語版より
//          高ければ「英語で出す価値がある」の裏づけになる。
// 副KPI  = 投稿数 / ドロミティ興味 / 日付フィルタ利用
declare(strict_types=1);
require __DIR__ . '/common.php';
$cfg = hg_config();
header('Cache-Control: no-store');
if (($_GET['token'] ?? '') === '' || !hash_equals((string)$cfg['kpi_token'], (string)$_GET['token'])) {
  http_response_code(403);
  header('Content-Type: text/plain; charset=utf-8');
  exit('forbidden');
}

$days = max(1, min(365, (int)($_GET['days'] ?? 30)));
$since = gmdate('c', time() - $days * 86400);

function read_jsonl(string $dir, string $since): array {
  $out = [];
  foreach (glob($dir . '/*.jsonl') ?: [] as $f) {
    $h = fopen($f, 'r');
    if (!$h) { continue; }
    while (($line = fgets($h)) !== false) {
      $r = json_decode($line, true);
      if (is_array($r) && ($r['ts'] ?? '') >= $since) { $out[] = $r; }
    }
    fclose($h);
  }
  return $out;
}

$ev = read_jsonl(hg_data_dir($cfg, 'events'), $since);
$posts = read_jsonl(hg_data_dir($cfg, 'posts'), $since);

$counts = $pv = $pvHut = $outHut = $vis = [];
$hutPairs = $hutViewPairs = [];                 // 訪問者×小屋の集合
$byLang = ['ja' => ['pv' => 0, 'view' => [], 'out' => [], 'visitors' => []],
           'en' => ['pv' => 0, 'view' => [], 'out' => [], 'visitors' => []]];
$byDay = [];

foreach ($ev as $r) {
  $lang = in_array($r['lang'] ?? 'ja', ['ja', 'en'], true) ? $r['lang'] : 'ja';
  $hut = (string)($r['hut'] ?? '');
  $day = substr((string)$r['ts'], 0, 10);
  $counts[$r['ev']] = ($counts[$r['ev']] ?? 0) + 1;
  $vis[$r['v']] = true;
  $byLang[$lang]['visitors'][$r['v']] = true;
  $byDay[$day][$r['ev']] = ($byDay[$day][$r['ev']] ?? 0) + 1;

  if ($r['ev'] === 'pageview') {
    $pv[$r['page']] = ($pv[$r['page']] ?? 0) + 1;
    $byLang[$lang]['pv']++;
    if ($hut !== '') {
      $pvHut[$hut] = ($pvHut[$hut] ?? 0) + 1;
      $hutViewPairs[$hut . '|' . $r['v']] = true;
      $byLang[$lang]['view'][$hut . '|' . $r['v']] = true;
    }
  } elseif (strpos($r['ev'], 'outbound_') === 0 && $hut !== '') {
    $outHut[$hut] = ($outHut[$hut] ?? 0) + 1;
    $hutPairs[$hut . '|' . $r['v']] = true;
    $byLang[$lang]['out'][$hut . '|' . $r['v']] = true;
  }
}

$views = count($hutViewPairs);
$sends = count($hutPairs);
$ctr = $views ? round($sends / $views * 100, 1) : 0.0;

$lang_rows = [];
foreach ($byLang as $k => $v) {
  $vw = count($v['view']);
  $lang_rows[$k] = ['pageviews' => $v['pv'], 'visitors' => count($v['visitors']),
                    'hut_viewers' => $vw, 'senders' => count($v['out']),
                    'send_rate' => $vw ? round(count($v['out']) / $vw * 100, 1) : 0.0];
}

$hut_rows = [];
foreach ($pvHut as $hut => $n) {
  $hut_rows[$hut] = ['views' => $n, 'outbound' => $outHut[$hut] ?? 0,
                     'send_rate' => $n ? round(($outHut[$hut] ?? 0) / $n * 100, 1) : 0.0];
}
arsort($pvHut);
$hut_rows = array_replace(array_flip(array_keys($pvHut)), $hut_rows);
arsort($pv);
ksort($byDay);

$pending = count(array_filter($posts, fn($p) => ($p['status'] ?? '') === 'pending'));
$report = [
  'generated_at' => gmdate('c'),
  'window_days'  => $days,
  'primary'      => ['metric' => 'send_rate_percent', 'value' => $ctr,
                     'hut_viewers' => $views, 'senders' => $sends],
  'visitors'     => count($vis),
  'pageviews'    => $counts['pageview'] ?? 0,
  'by_language'  => $lang_rows,
  'by_hut'       => $hut_rows,
  'by_page'      => array_slice($pv, 0, 50, true),
  'by_day'       => $byDay,
  'events'       => $counts,
  'posts'        => ['total' => count($posts), 'pending' => $pending,
                     'by_lang' => array_count_values(array_map(fn($p) => $p['lang'] ?? 'ja', $posts))],
  'interest_dolomiti' => $counts['interest_dolomiti'] ?? 0,
];

if (($_GET['format'] ?? '') === 'json') {
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($report, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
  exit;
}

header('Content-Type: text/html; charset=utf-8');
$h = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
$tok = $h($_GET['token']);
?>
<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HutsGo KPI</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#17251F}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}
.tiles{display:flex;gap:1rem;flex-wrap:wrap}.tile{border:1px solid #D5DBD6;border-radius:6px;padding:.8rem 1rem;min-width:150px;flex:1 1 150px}
.tile b{display:block;font-size:1.6rem;line-height:1.2}.tile.main{border-color:#2E6B4A;background:#E3EEE7}
table{border-collapse:collapse;width:100%;margin:.5rem 0}td,th{border-bottom:1px solid #D5DBD6;padding:.35rem .5rem;text-align:left}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}small{color:#6F7B74}code{background:#F4F6F3;padding:.1rem .3rem;border-radius:3px}</style>
<h1>HutsGo KPI <small>直近 <?= $days ?> 日 ／
  <a href="?token=<?= $tok ?>&days=7">7</a> ·
  <a href="?token=<?= $tok ?>&days=30">30</a> ·
  <a href="?token=<?= $tok ?>&days=90">90</a> ·
  <a href="?token=<?= $tok ?>&days=<?= $days ?>&format=json">JSON</a></small></h1>

<div class="tiles">
  <div class="tile main"><small>送客率（主KPI）</small><b><?= $ctr ?>%</b>
    <small>小屋ページを見た <?= $views ?>（人×小屋）のうち <?= $sends ?> が公式/予約/電話へ</small></div>
  <div class="tile"><small>訪問者</small><b><?= count($vis) ?></b><small>日替わりハッシュ。PV <?= $counts['pageview'] ?? 0 ?></small></div>
  <div class="tile"><small>投稿</small><b><?= count($posts) ?></b><small>未承認 <?= $pending ?> 件</small></div>
  <div class="tile"><small>ドロミティ興味</small><b><?= $counts['interest_dolomiti'] ?? 0 ?></b><small>作る前に需要を測る</small></div>
</div>

<h2>言語別（英語版の仮説検証）</h2>
<p><small>英語版は電話が使えない層。送客率が日本語版より高ければ「英語で出す価値がある」の裏づけになる。</small></p>
<table><tr><th>言語</th><th class="n">PV</th><th class="n">訪問者</th><th class="n">小屋を見た</th><th class="n">送客</th><th class="n">送客率</th></tr>
<?php foreach ($lang_rows as $k => $v): ?>
<tr><td><?= $k === 'ja' ? '日本語' : 'English' ?></td><td class="n"><?= $v['pageviews'] ?></td><td class="n"><?= $v['visitors'] ?></td>
<td class="n"><?= $v['hut_viewers'] ?></td><td class="n"><?= $v['senders'] ?></td><td class="n"><b><?= $v['send_rate'] ?>%</b></td></tr>
<?php endforeach; ?></table>

<h2>小屋別</h2>
<table><tr><th>小屋</th><th class="n">閲覧</th><th class="n">公式クリック</th><th class="n">送客率</th></tr>
<?php foreach ($hut_rows as $hut => $v): if (!is_array($v)) continue; ?>
<tr><td><?= $h($hut) ?></td><td class="n"><?= $v['views'] ?></td><td class="n"><?= $v['outbound'] ?></td><td class="n"><?= $v['send_rate'] ?>%</td></tr>
<?php endforeach; ?></table>

<h2>ページ別閲覧</h2>
<table><tr><th>ページ</th><th class="n">閲覧</th></tr>
<?php foreach (array_slice($pv, 0, 40, true) as $p => $n): ?><tr><td><?= $h($p) ?></td><td class="n"><?= $n ?></td></tr><?php endforeach; ?></table>

<h2>最近の投稿</h2>
<table><tr><th>日時</th><th>言語</th><th>小屋</th><th>宿泊日</th><th>設備</th><th>本文</th><th>写真</th></tr>
<?php foreach (array_reverse(array_slice($posts, -30)) as $p): ?>
<tr><td><?= $h(substr((string)$p['ts'], 0, 16)) ?></td><td><?= $h($p['lang'] ?? 'ja') ?></td><td><?= $h($p['hut']) ?></td>
<td><?= $h($p['stayed_on'] ?? '') ?></td>
<td><small><?= $h(implode(' / ', array_filter([$p['toilet'] ?? '', $p['water'] ?? '', $p['charging'] ?? '', $p['payment'] ?? '', $p['shower'] ?? '']))) ?></small></td>
<td><?= nl2br($h(mb_substr((string)($p['body'] ?? ''), 0, 200))) ?></td><td><?= !empty($p['photo']) ? '有' : '' ?></td></tr>
<?php endforeach; ?></table>

<p><small>手元から読むには <code>python tools/kpi_report.py</code>。イベントは <?= $h($cfg['data_dir']) ?>/events/、投稿は posts/。IP・UA の生値は保存していません。</small></p>
