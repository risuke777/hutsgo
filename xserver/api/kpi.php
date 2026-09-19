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
  // 静的ホスティングでは JSON の取得数が測れない。MCP 経由の利用はここで数える。
  'mcp' => array_filter($counts, fn($k) => strpos($k, 'mcp_') === 0, ARRAY_FILTER_USE_KEY),
];

// ---- 判断 -------------------------------------------------------------
// 数字だけ見ても次に何をするか決まらないので、ルールで判断まで出す。
// level: wait = 母数不足で判断保留 / act = 手を打つ / ok = 妥当 / good = 良い
// しきい値を変えるときはここだけ直す（tools/kpi_report.py はこの結果を表示するだけ）。
const MIN_PAIRS = 30;                 // 率を見るのに必要な（人×小屋）
const LAUNCH = '2026-09-13';
const REVIEW_1 = '2026-12-13';        // 3ヶ月: Search Console のインプレッションで判定
const REVIEW_2 = '2027-03-13';        // 6ヶ月: 送客クリック 月100件で判定
const MONTHLY_SEND_TARGET = 100;
const DOLOMITI_GO = 20;

$J = [];
$say = function (string $key, string $level, string $head, string $why, string $todo = '') use (&$J) {
  $J[$key] = ['level' => $level, 'head' => $head, 'why' => $why, 'todo' => $todo];
};

if ($views < MIN_PAIRS) {
  $say('send_rate', 'wait', '母数不足（' . $views . '/' . MIN_PAIRS . '）',
       '小屋ページを見た（人×小屋）が ' . MIN_PAIRS . ' を超えるまで率は見ない。今の ' . $ctr . '% は偶然でも出る。',
       '流入を増やす側の作業（ルート追加・記事）を優先する');
} elseif ($ctr < 10) {
  $say('send_rate', 'act', '低い', '小屋ページに来ても予約へ進んでいない。',
       '予約ボタンの位置、受付開始日の見え方、料金の欠けを疑う');
} elseif ($ctr < 25) {
  $say('send_rate', 'ok', '妥当', '小屋別の差を見て、低い小屋の情報を埋めるのが効く段階。',
       '下の「小屋別」で閲覧が多く送客が少ない小屋から情報を足す');
} else {
  $say('send_rate', 'good', '高い', '役に立っている。この水準ならルートを増やす価値がある。',
       'ルートを増やす');
}

$ja = $lang_rows['ja']; $en = $lang_rows['en'];
if ($en['hut_viewers'] < MIN_PAIRS) {
  $say('language', 'wait', '英語版の母数不足（' . $en['hut_viewers'] . '/' . MIN_PAIRS . '）', '結論を出すのは早い。');
} elseif ($en['send_rate'] > $ja['send_rate']) {
  $say('language', 'good', '仮説どおり', '英語圏のほうが困っている裏づけ。', '英語の情報を増やす');
} else {
  $say('language', 'act', '仮説が立っていない', '英語版の送客率が日本語版以下。', '英語版の内容か流入元を見直す');
}

// 閲覧はあるのに送客ゼロの小屋 = 情報が足りないか、予約導線が見えていない
$cold = [];
foreach ($hut_rows as $hut => $v) {
  if (is_array($v) && $v['views'] >= 10 && $v['outbound'] === 0) { $cold[] = $hut; }
}
if ($cold) {
  $say('huts', 'act', '送客ゼロの小屋 ' . count($cold) . ' 軒', '閲覧 10 以上で公式クリック 0: ' . implode(', ', $cold),
       'その小屋ページの予約情報・受付開始日・料金を確認する');
}

if ($pending > 0) {
  $say('posts', 'act', '未承認 ' . $pending . ' 件', '放置すると投稿が止まる。', 'tools/import_posts.py で取り込み、設備を hut_facilities に反映');
} elseif (count($posts) === 0) {
  $say('posts', 'wait', 'まだ投稿なし', '投稿フォームは小屋ページ下部。宿泊シーズン後に期待する。');
} else {
  $say('posts', 'ok', '処理済み', '未承認はない。');
}

$mcpCalls = array_sum(array_filter($report['mcp'], fn($k) => $k !== 'mcp_initialize', ARRAY_FILTER_USE_KEY));
if ($mcpCalls > 0) {
  $say('mcp', 'good', $mcpCalls . ' 回呼ばれた', 'サイトに来なくてもデータが使われている。ゼロクリック時代の実質的な到達数。');
} else {
  $say('mcp', 'act', 'まだ呼ばれていない', 'AI から見つけられていない。', '/api/ の掲載と MCP レジストリへの登録を確認する');
}

$dol = $report['interest_dolomiti'];
$say('dolomiti', $dol >= DOLOMITI_GO ? 'good' : 'wait',
     $dol >= DOLOMITI_GO ? '着手の目安に到達' : '目安まで ' . (DOLOMITI_GO - $dol),
     '「ドロミティ版がほしい」が ' . DOLOMITI_GO . ' 回で着手。', $dol >= DOLOMITI_GO ? 'Alta Via 1 のデータ確認に着手する' : '');

// 継続判定。送客は期間の長さに関わらず 30 日換算で見る
$monthly = (int)round($sends / $days * 30);
$today = gmdate('Y-m-d');
$daysTo = fn(string $d) => (int)ceil((strtotime($d) - strtotime($today)) / 86400);
if ($today < REVIEW_1) {
  $say('continue', 'wait', '3ヶ月判定まで ' . $daysTo(REVIEW_1) . ' 日（' . REVIEW_1 . '）',
       'その日に Search Console のインプレッションで判定。送客は 30 日換算で ' . $monthly . ' / ' . MONTHLY_SEND_TARGET . '（6ヶ月判定 ' . REVIEW_2 . ' の基準）。');
} elseif ($today < REVIEW_2) {
  $say('continue', $monthly >= MONTHLY_SEND_TARGET ? 'good' : 'act',
       '6ヶ月判定まで ' . $daysTo(REVIEW_2) . ' 日', '送客 30 日換算 ' . $monthly . ' / ' . MONTHLY_SEND_TARGET . '。',
       $monthly >= MONTHLY_SEND_TARGET ? '' : '3ヶ月判定の結果を STATUS.md に書き、伸ばす施策を 1 つに絞る');
} else {
  $say('continue', $monthly >= MONTHLY_SEND_TARGET ? 'good' : 'act',
       $monthly >= MONTHLY_SEND_TARGET ? '継続' : '判定: 基準未達',
       '送客 30 日換算 ' . $monthly . ' / ' . MONTHLY_SEND_TARGET . '。',
       $monthly >= MONTHLY_SEND_TARGET ? '山域を広げる' : '続けるか畳むかを決めて STATUS.md に残す');
}

// データ被覆率。公開データ（hutsgo.com/data/huts.json）から数える
$huts = hg_public_data($cfg, 'huts', getenv('HUTSGO_DATA_BASE') ?: 'https://hutsgo.com/data', 3600);
$known = fn($v) => $v !== null && $v !== '';
$checks = [
  '標高'         => fn($x) => $known($x['location']['elevation_m'] ?? null),
  '予約URL/電話' => fn($x) => $known($x['season_2026']['reservation']['url'] ?? null) || $known($x['season_2026']['reservation']['phone'] ?? null),
  '予約受付開始' => fn($x) => $known($x['season_2026']['reservation']['opens_at'] ?? null),
  'トイレ'       => fn($x) => $known($x['facilities']['toilet_type'] ?? null),
  '水'           => fn($x) => $known($x['facilities']['water_available'] ?? null),
  '充電'         => fn($x) => $known($x['facilities']['charging_service'] ?? null),
  '支払方法'     => fn($x) => $known($x['facilities']['credit_card'] ?? null) || $known($x['facilities']['qr_payment'] ?? null) || $known($x['facilities']['cash_only'] ?? null),
  '英語名'       => fn($x) => $known($x['name']['en'] ?? null),
];
$coverage = [];
foreach ($checks as $label => $fn) {
  $coverage[$label] = ['filled' => count(array_filter($huts, $fn)), 'total' => count($huts)];
}
$gaps = array_keys(array_filter($coverage, fn($c) => $c['total'] && $c['filled'] / $c['total'] < 0.5));
if (!$huts) {
  $say('coverage', 'wait', '取得できず', 'hutsgo.com/data/huts.json を読めなかった。');
} elseif ($gaps) {
  $say('coverage', 'act', '半分未満: ' . implode('・', $gaps), 'ここが埋まらないと他と差がつかない。',
       '公式サイトで確認して seed.sql を更新（推測で埋めない）');
} else {
  $say('coverage', 'ok', '主要項目は半分以上埋まっている', '');
}

$report['judgement'] = $J;
$report['coverage'] = $coverage;
$report['monthly_sends'] = $monthly;

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
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}small{color:#6F7B74}code{background:#F4F6F3;padding:.1rem .3rem;border-radius:3px}
.v{display:block;margin-top:.4rem;font-size:.85rem;line-height:1.45}.v b{display:inline;font-size:inherit}
.lv{display:inline-block;font-size:.72rem;padding:0 .4rem;border-radius:3px;margin-right:.3rem;vertical-align:1px}
.lv-wait{background:#ECEEEB;color:#55615A}.lv-act{background:#F6E7C8;color:#7A4B00}.lv-ok{background:#E3EEE7;color:#2E6B4A}.lv-good{background:#2E6B4A;color:#fff}
.todo{border:1px solid #E6CF9C;background:#FFF9EC;border-radius:6px;padding:.6rem 1rem;margin:1rem 0}.todo ol{margin:.3rem 0 0;padding-left:1.3rem}
.bar{display:inline-block;height:.55rem;background:#2E6B4A;border-radius:2px;vertical-align:middle}.bar.lo{background:#C98A1B}</style>
<?php
$LV = ['wait' => '保留', 'act' => '要対応', 'ok' => '妥当', 'good' => '良い'];
$verdict = function (string $key) use ($J, $LV, $h) {
  if (!isset($J[$key])) { return ''; }
  $j = $J[$key];
  return '<span class="v"><span class="lv lv-' . $j['level'] . '">' . $LV[$j['level']] . '</span><b>' . $h($j['head']) . '</b>'
       . ($j['why'] !== '' ? '<br><small>' . $h($j['why']) . '</small>' : '') . '</span>';
};
$todo = array_filter($J, fn($j) => $j['level'] === 'act' && $j['todo'] !== '');
?>
<h1>HutsGo KPI <small>直近 <?= $days ?> 日 ／
  <a href="?token=<?= $tok ?>&days=7">7</a> ·
  <a href="?token=<?= $tok ?>&days=30">30</a> ·
  <a href="?token=<?= $tok ?>&days=90">90</a> ·
  <a href="?token=<?= $tok ?>&days=<?= $days ?>&format=json">JSON</a></small></h1>

<div class="todo"><b>今やること</b>
<?php if ($todo): ?><ol><?php foreach ($todo as $j): ?><li><?= $h($j['todo']) ?> <small>— <?= $h($j['head']) ?></small></li><?php endforeach; ?></ol>
<?php else: ?><br><small>要対応なし。<?= $views < MIN_PAIRS ? 'いまは母数を増やす（ルート追加・記事）のが最優先。' : '' ?></small><?php endif; ?>
<br><small><?= $h($J['continue']['head']) ?> — <?= $h($J['continue']['why']) ?></small></div>

<div class="tiles">
  <div class="tile main"><small>送客率（主KPI）</small><b><?= $ctr ?>%</b>
    <small>小屋ページを見た <?= $views ?>（人×小屋）のうち <?= $sends ?> が公式/予約/電話へ</small><?= $verdict('send_rate') ?></div>
  <div class="tile"><small>訪問者</small><b><?= count($vis) ?></b><small>日替わりハッシュ。PV <?= $counts['pageview'] ?? 0 ?>。自分の確認アクセスも含む</small></div>
  <div class="tile"><small>投稿</small><b><?= count($posts) ?></b><small>未承認 <?= $pending ?> 件</small><?= $verdict('posts') ?></div>
  <div class="tile"><small>ドロミティ興味</small><b><?= $dol ?></b><small>作る前に需要を測る</small><?= $verdict('dolomiti') ?></div>
  <div class="tile"><small>MCP ツール呼び出し</small><b><?= $mcpCalls ?></b>
    <small>AI 経由の利用。接続 <?= $counts['mcp_initialize'] ?? 0 ?> 回</small><?= $verdict('mcp') ?></div>
  <div class="tile"><small>日付フィルタ利用</small><b><?= $counts['change_date'] ?? 0 ?></b><small>断面図マーカー <?= $counts['profile_marker'] ?? 0 ?></small></div>
</div>

<h2>データ被覆率</h2>
<p><small>公開データ（hutsgo.com/data/huts.json）から集計。ここが差別化の実体。</small><?= $verdict('coverage') ?></p>
<table><tr><th>項目</th><th></th><th class="n">埋まっている</th></tr>
<?php foreach ($coverage as $label => $c): $r = $c['total'] ? $c['filled'] / $c['total'] : 0; ?>
<tr><td><?= $h($label) ?></td><td><span class="bar<?= $r < .5 ? ' lo' : '' ?>" style="width:<?= round($r * 160) ?>px"></span></td>
<td class="n"><?= $c['filled'] ?>/<?= $c['total'] ?></td></tr>
<?php endforeach; ?></table>

<?php if (isset($J['huts'])): ?><p><?= $verdict('huts') ?></p><?php endif; ?>

<?php if ($report['mcp']): ?>
<h2>MCP（AI から）</h2>
<p><small>サイトに人が来なくても、データが使われていればここに出る。ゼロクリック時代の実質的な到達数。</small></p>
<table><tr><th>ツール</th><th class="n">呼び出し</th></tr>
<?php foreach ($report['mcp'] as $k => $n): ?>
<tr><td><code><?= $h(substr($k, 4)) ?></code></td><td class="n"><?= $n ?></td></tr>
<?php endforeach; ?></table>
<?php endif; ?>

<h2>言語別（英語版の仮説検証）</h2>
<p><small>英語版は電話が使えない層。送客率が日本語版より高ければ「英語で出す価値がある」の裏づけになる。</small><?= $verdict('language') ?></p>
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
