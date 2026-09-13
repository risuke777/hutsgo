<?php
// KPI ダッシュボード。 https://api.hutsgo.com/kpi.php?token=<config の kpi_token>&days=30
// 主 KPI = 小屋ページ閲覧 → 公式サイト/予約/電話クリックの率（送客率）。副 KPI = 投稿数、ドロミティ興味数。
declare(strict_types=1);
require __DIR__ . '/common.php';
$cfg = hg_config();
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
if (($_GET['token'] ?? '') === '' || !hash_equals((string)$cfg['kpi_token'], (string)$_GET['token'])) { http_response_code(403); exit('forbidden'); }

$days = max(1, min(365, (int)($_GET['days'] ?? 30)));
$since = gmdate('c', time() - $days * 86400);

function read_jsonl(string $dir, string $since): array {
  $out = [];
  foreach (glob($dir . '/*.jsonl') ?: [] as $f) {
    $h = fopen($f, 'r');
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

$pv = $pvHut = $out = $outHut = $vis = $visHut = [];
$counts = [];
foreach ($ev as $r) {
  $counts[$r['ev']] = ($counts[$r['ev']] ?? 0) + 1;
  $vis[$r['v']] = true;
  $hut = $r['hut'] ?? '';
  if ($r['ev'] === 'pageview') {
    $pv[$r['page']] = ($pv[$r['page']] ?? 0) + 1;
    if ($hut !== '') { $pvHut[$hut] = ($pvHut[$hut] ?? 0) + 1; $visHut[$hut][$r['v']] = true; }
  } elseif (strpos($r['ev'], 'outbound_') === 0 && $hut !== '') {
    $outHut[$hut] = ($outHut[$hut] ?? 0) + 1;
    $out[$hut . '|' . $r['v']] = true;   // 同じ人の連打は 1 回に
  }
}
$hutPv = array_sum($pvHut);
$hutOut = count($out);
$ctr = $hutPv ? round($hutOut / $hutPv * 100, 1) : 0;
arsort($pvHut); arsort($pv);
$pending = count(array_filter($posts, fn($p) => ($p['status'] ?? '') === 'pending'));
$h = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
?>
<!doctype html><meta charset="utf-8"><title>HutsGo KPI</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#17251F}
h1{font-size:1.4rem}.tiles{display:flex;gap:1rem;flex-wrap:wrap}.tile{border:1px solid #D5DBD6;border-radius:6px;padding:.8rem 1rem;min-width:160px}
.tile b{display:block;font-size:1.6rem}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border-bottom:1px solid #D5DBD6;padding:.35rem .5rem;text-align:left}
td.n{text-align:right;font-variant-numeric:tabular-nums}small{color:#6F7B74}</style>
<h1>HutsGo KPI <small>直近 <?= $days ?> 日 ／ <a href="?token=<?= $h($_GET['token']) ?>&days=7">7</a> · <a href="?token=<?= $h($_GET['token']) ?>&days=30">30</a> · <a href="?token=<?= $h($_GET['token']) ?>&days=90">90</a></small></h1>
<div class="tiles">
  <div class="tile"><small>送客率（主KPI）</small><b><?= $ctr ?>%</b><small>小屋ページ閲覧 <?= $hutPv ?> → 公式/予約/電話 <?= $hutOut ?>（人×小屋）</small></div>
  <div class="tile"><small>訪問者</small><b><?= count($vis) ?></b><small>日替わりハッシュ。ページビュー <?= $counts['pageview'] ?? 0 ?></small></div>
  <div class="tile"><small>投稿</small><b><?= count($posts) ?></b><small>未承認 <?= $pending ?> 件（tools/import_posts.py で取り込む）</small></div>
  <div class="tile"><small>ドロミティ 興味</small><b><?= $counts['interest_dolomiti'] ?? 0 ?></b><small>作る前に需要を測る</small></div>
  <div class="tile"><small>日付フィルタ利用</small><b><?= $counts['change_date'] ?? 0 ?></b><small>断面図マーカー <?= $counts['profile_marker'] ?? 0 ?></small></div>
</div>
<h2>小屋別</h2>
<table><tr><th>小屋</th><th class="n">閲覧</th><th class="n">閲覧者</th><th class="n">公式クリック</th><th class="n">送客率</th></tr>
<?php foreach ($pvHut as $hut => $n): $o = $outHut[$hut] ?? 0; ?>
<tr><td><?= $h($hut) ?></td><td class="n"><?= $n ?></td><td class="n"><?= count($visHut[$hut] ?? []) ?></td><td class="n"><?= $o ?></td><td class="n"><?= $n ? round($o / $n * 100) : 0 ?>%</td></tr>
<?php endforeach; ?></table>
<h2>ページ別閲覧</h2>
<table><tr><th>ページ</th><th class="n">閲覧</th></tr>
<?php foreach (array_slice($pv, 0, 40, true) as $p => $n): ?><tr><td><?= $h($p) ?></td><td class="n"><?= $n ?></td></tr><?php endforeach; ?></table>
<h2>最近の投稿</h2>
<table><tr><th>日時</th><th>小屋</th><th>宿泊日</th><th>設備</th><th>本文</th><th>写真</th></tr>
<?php foreach (array_reverse(array_slice($posts, -30)) as $p): ?>
<tr><td><?= $h(substr($p['ts'], 0, 16)) ?></td><td><?= $h($p['hut']) ?></td><td><?= $h($p['stayed_on']) ?></td>
<td><small><?= $h(implode(' / ', array_filter([$p['toilet'], $p['water'], $p['charging'] ? '充電' . $p['charging'] : '', $p['payment'], $p['shower'] ? 'シャワー' . $p['shower'] : '']))) ?></small></td>
<td><?= nl2br($h(mb_substr($p['body'], 0, 200))) ?></td><td><?= $p['photo'] ? '有' : '' ?></td></tr>
<?php endforeach; ?></table>
<p><small>イベントは <?= $h($cfg['data_dir']) ?>/events/*.jsonl、投稿は posts/*.jsonl と uploads/。IP・UA の生値は保存していません。</small></p>
