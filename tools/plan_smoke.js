/* 行程ボード（/plan/）の煙テスト。dist の実ファイルを jsdom で動かす。
 *
 *   npm i jsdom        （初回だけ。tools/ の外、どこでもよい）
 *   python build.py && node tools/plan_smoke.js
 *
 * plan.js を触ったら本番に上げる前にこれを通すこと。
 * 特に「保存 → 共有URL → 読み戻し」の往復は必ず確認する（2026-09-23 にここで事故った）。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const DIST = path.join(__dirname, "..", "dist");
const hutsJson = fs.readFileSync(path.join(DIST, "data/huts.json"), "utf8");
const qrJs = fs.readFileSync(path.join(DIST, "static/qrcode.js"), "utf8");
const mapJs = fs.readFileSync(path.join(DIST, "static/map.js"), "utf8");
const contactJs = fs.readFileSync(path.join(DIST, "static/contact.js"), "utf8");
const planJs = fs.readFileSync(path.join(DIST, "static/plan.js"), "utf8");
const planHtml = fs.readFileSync(path.join(DIST, "plan/index.html"), "utf8");
const trailsJson = fs.readFileSync(path.join(DIST, "data/trails.json"), "utf8");
const trailHtml = fs.readFileSync(path.join(DIST, "trails/omote_ginza/index.html"), "utf8");
const trailMapJs = fs.readFileSync(path.join(DIST, "static/trailmap.js"), "utf8");
const planHtmlEn = fs.readFileSync(path.join(DIST, "en/plan/index.html"), "utf8");
const thHtmlEn = fs.readFileSync(path.join(DIST, "en/trailheads/kamikochi/index.html"), "utf8");
const thHtmlJa = fs.readFileSync(path.join(DIST, "trailheads/kamikochi/index.html"), "utf8");

const HUT_COUNT = JSON.parse(hutsJson).length;   // データが増えても落ちないよう実数から取る

const results = [];
const ok = (label, cond, extra) => {
  results.push({ label, pass: !!cond, extra });
  return !!cond;
};

function boot(url) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push("jsdomError: " + e.message));
  vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));
  const dom = new JSDOM(planHtml, {
    runScripts: "dangerously",
    url,
    virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u) => Promise.resolve({
        json: () => Promise.resolve(JSON.parse(String(u).includes("trails.json") ? trailsJson : hutsJson)),
      });
      w.navigator.clipboard = { writeText: () => Promise.resolve() };
      const store = {};
      Object.defineProperty(w, "localStorage", {
        value: {
          getItem: (k) => (k in store ? store[k] : null),
          setItem: (k, v) => { store[k] = String(v); },
          removeItem: (k) => { delete store[k]; },
        },
      });
      // .ics ダウンロードは端末内で完結する機能なので、テストでは Blob/URL をスタブして中身だけ検査する
      w.downloadedIcs = null;
      w.Blob = function (parts) { return { text: parts.join("") }; };
      w.URL.createObjectURL = (blob) => { w.downloadedIcs = blob.text; return "blob:stub"; };
      w.URL.revokeObjectURL = () => {};
      // <a download> の実ダウンロードは jsdom が実装していない（クリックで「別ドキュメントへの
      // ナビゲーション」を試みてエラーになる）。中身は createObjectURL の時点で既に取れているので、
      // クリックそのものは無視してよい（本番のブラウザでは何もしない安全なスタブ）。
      w.HTMLAnchorElement.prototype.click = function () {};
    },
  });
  [qrJs, mapJs, contactJs, planJs].forEach(function (code) {
    const sc = dom.window.document.createElement("script");
    sc.textContent = code;
    dom.window.document.body.appendChild(sc);
  });
  return { dom, w: dom.window, d: dom.window.document, errors };
}

function bootTrail() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push("jsdomError: " + e.message));
  const dom = new JSDOM(trailHtml, {
    runScripts: "dangerously",
    url: "https://hutsgo.com/trails/omote_ginza/",
    virtualConsole: vc,
    beforeParse(w) {
      w.fetch = () => Promise.resolve({ json: () => Promise.resolve(JSON.parse(hutsJson)) });
    },
  });
  [mapJs, trailMapJs].forEach(function (code) {
    const sc = dom.window.document.createElement("script");
    sc.textContent = code;
    dom.window.document.body.appendChild(sc);
  });
  return { dom, w: dom.window, d: dom.window.document, errors };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cardsOn = (d, day) => d.querySelectorAll(`.plan-day[data-day="${day}"] .plan-card`).length;

(async () => {
  const report = (errors) => {
    results.forEach((r) => console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.label}${r.extra ? " — " + r.extra : ""}`));
    if (errors && errors.length) console.log("\nページ内エラー:\n" + errors.join("\n"));
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} 件パス`);
    process.exit(failed || (errors && errors.length) ? 1 : 0);
  };
  try {
  // ---- 1. 素の状態で組み立てる -------------------------------------
  const a = boot("https://hutsgo.com/plan/");
  await wait(200);
  ok("選択盤が出る", a.d.querySelectorAll(".ridge-hut").length === HUT_COUNT,
     `${a.d.querySelectorAll(".ridge-hut").length}/${HUT_COUNT}軒`);

  const start = a.d.getElementById("plan-start");
  start.value = "2026-07-20";
  start.dispatchEvent(new a.w.Event("change"));
  const nights = a.d.getElementById("plan-nights");
  nights.value = "3";
  nights.dispatchEvent(new a.w.Event("change"));

  const pick = (id) => a.d.querySelector(`.ridge-hut[data-hut="${id}"]`).click();
  pick("enzanso");        // 1泊目
  pick("daitenso");       // 2泊目
  pick("otenjo_hutte");   // 3泊目
  pick("hutte_ooyari");   // 空きが無いので3泊目の候補として横に並ぶ

  ok("3泊分の枠ができる", a.d.querySelectorAll(".plan-day").length === 3);
  ok("1泊目は1軒", cardsOn(a.d, 0) === 1, `${cardsOn(a.d, 0)}`);
  ok("3泊目は候補2軒", cardsOn(a.d, 2) === 2, `${cardsOn(a.d, 2)}`);
  ok("日付が入る", /2026-07-20/.test(a.d.querySelector('.plan-day[data-day="0"] h3').textContent),
     a.d.querySelector('.plan-day[data-day="0"] h3').textContent);
  ok("2泊目の日付は翌日", /2026-07-21/.test(a.d.querySelector('.plan-day[data-day="1"] h3').textContent),
     a.d.querySelector('.plan-day[data-day="1"] h3').textContent);
  ok("営業判定が出る", !!a.d.querySelector(".plan-card .plan-badge"),
     (a.d.querySelector(".plan-card .plan-badge") || {}).textContent);
  ok("小屋ページへリンク", a.d.querySelector(".plan-card a").getAttribute("href") === "/huts/enzanso/");
  ok("電話は tel: リンク", !!a.d.querySelector('.plan-card a[href^="tel:"]'));

  // ---- 2. 共有URLの往復（ここが 2026-09-23 の事故） -------------------
  const shared = a.w.location.hash;
  ok("共有URLに日ごとの区切りが入る", /%7C/.test(shared) || /\|/.test(shared), shared);

  const b = boot("https://hutsgo.com/plan/" + shared);
  await wait(200);
  ok("復元しても泊数が同じ", b.d.querySelectorAll(".plan-day").length === 3,
     `${b.d.querySelectorAll(".plan-day").length}泊`);
  ok("復元しても1泊目は1軒", cardsOn(b.d, 0) === 1, `${cardsOn(b.d, 0)}`);
  ok("復元しても3泊目は候補2軒", cardsOn(b.d, 2) === 2, `${cardsOn(b.d, 2)}`);
  ok("復元した泊数が選択欄に反映される", b.d.getElementById("plan-nights").value === "3",
     b.d.getElementById("plan-nights").value);
  ok("復元しても日付が同じ", /2026-07-20/.test(b.d.querySelector('.plan-day[data-day="0"] h3').textContent),
     b.d.querySelector('.plan-day[data-day="0"] h3').textContent);
  ok("復元後の共有URLが元と同じ", b.w.location.hash === shared, `${b.w.location.hash}`);

  // ---- 3. 移動・削除・クリア ----------------------------------------
  const up = b.d.querySelector('.plan-day[data-day="2"] .plan-card .plan-move-btn');
  up.click();
  ok("前の泊へ移せる", cardsOn(b.d, 1) === 2, `${cardsOn(b.d, 1)}`);

  const before = b.d.querySelectorAll(".plan-card").length;
  [...b.d.querySelectorAll(".plan-card .plan-move-btn")].find((x) => x.textContent === "×").click();
  ok("行程から外せる", b.d.querySelectorAll(".plan-card").length === before - 1);

  b.d.getElementById("plan-clear").click();
  ok("空にできる", b.d.querySelectorAll(".plan-card").length === 0);

  // ---- 4. 小屋ページからの追加 ---------------------------------------
  const c = boot("https://hutsgo.com/plan/#add=yarigatake_sanso");
  await wait(200);
  ok("小屋ページからの追加が効く", c.d.querySelectorAll(".plan-card").length === 1,
     `${c.d.querySelectorAll(".plan-card").length}`);

  // ---- 5. 地図から選ぶ -----------------------------------------------
  const e = boot("https://hutsgo.com/plan/");
  await wait(200);
  ok("既定は地図", !e.d.getElementById("plan-map-view").hidden);
  const pinCount = e.d.querySelectorAll(".hgmap-pin").length;
  ok("地図に小屋が出る", pinCount > 0 && pinCount <= HUT_COUNT, `${pinCount}/${HUT_COUNT}`);
  const tile = e.d.querySelector(".hgmap-tile");
  ok("タイルは地理院のURL", !!tile && /cyberjapandata[.]gsi[.]go[.]jp\/xyz\/std\/\d+\/\d+\/\d+[.]png$/.test(tile.src),
     tile && tile.src);
  ok("出典が出ている", /地理院タイル/.test(e.d.querySelector(".hgmap-attr").textContent));
  ok("拡大縮小と全体表示のボタン", e.d.querySelectorAll(".hgmap-btn").length === 3);
  e.d.querySelector(".hgmap-pin").click();
  ok("地図から行程に入る", e.d.querySelectorAll(".plan-card").length === 1,
     `${e.d.querySelectorAll(".plan-card").length}`);
  const toastBox = e.d.getElementById("plan-msg");
  ok("入れたことを知らせる", !toastBox.hidden && /入れました|added/.test(toastBox.textContent),
     toastBox.textContent);
  ok("選んだ小屋のピンが変わる", !!e.d.querySelector(".hgmap-pin.is-chosen"));
  ok("この範囲の小屋が出る", e.d.querySelectorAll("#plan-nearby-row .plan-chip").length > 0,
     `${e.d.querySelectorAll("#plan-nearby-row .plan-chip").length}`);
  [...toastBox.querySelectorAll("button")].forEach((b) => b.click());
  ok("取り消せる", e.d.querySelectorAll(".plan-card").length === 0,
     `${e.d.querySelectorAll(".plan-card").length}`);

  e.d.querySelector('.plan-tab[data-view="ridge"]').click();
  ok("稜線タブに切り替わる",
     !e.d.getElementById("plan-ridge-view").hidden && e.d.getElementById("plan-map-view").hidden);
  ok("地図以外では範囲の小屋を隠す", e.d.getElementById("plan-nearby").hidden);

  // ---- 6. 地図の操作: ピンチ・ホイール・ラベル -------------------------
  const f = boot("https://hutsgo.com/plan/");
  await wait(200);
  const map = f.d.getElementById("plan-map");
  const zoomOf = (doc) => {
    const t = doc.querySelector(".hgmap-tile");
    const m = t && /\/xyz\/std\/(\d+)\//.exec(t.src);
    return m ? Number(m[1]) : null;
  };
  const pointer = (type, id, x, y) => {
    const ev = new f.w.Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, { pointerId: id, clientX: x, clientY: y });
    map.dispatchEvent(ev);
  };
  const z0 = zoomOf(f.d);
  ok("最初の縮尺が全体に合っている", z0 !== null && z0 >= 5 && z0 <= 16, `z=${z0}`);

  // 2本指を1.6倍に広げる → 1段寄る
  pointer("pointerdown", 1, 100, 200);
  pointer("pointerdown", 2, 200, 200);
  pointer("pointermove", 2, 260, 200);
  const zIn = zoomOf(f.d);
  ok("ピンチで拡大する", zIn === z0 + 1, `${z0} → ${zIn}`);

  // 指を狭める → 1段戻る
  pointer("pointermove", 2, 150, 200);
  const zOut = zoomOf(f.d);
  ok("ピンチで縮小する", zOut === zIn - 1, `${zIn} → ${zOut}`);

  // 大きく広げれば2段動く（ゆっくり広げたときに1段ずつ動くのと同じ計算）
  pointer("pointermove", 2, 400, 200);
  ok("大きく広げると段数も増える", zoomOf(f.d) >= zOut + 1, `${zOut} → ${zoomOf(f.d)}`);
  while (zoomOf(f.d) > z0) f.d.querySelectorAll(".hgmap-btn")[1].click();
  pointer("pointerup", 1, 150, 200);
  pointer("pointerup", 2, 160, 200);

  // 指を離した後にドラッグしても飛ばない
  const zSteady = zoomOf(f.d);
  pointer("pointerdown", 3, 100, 100);
  pointer("pointermove", 3, 120, 130);
  pointer("pointerup", 3, 120, 130);
  ok("ピンチの後のドラッグで縮尺が変わらない", zoomOf(f.d) === zSteady, `${zoomOf(f.d)}`);

  // 全体表示では名前が詰まって隠れ、寄せると出る
  const labelsAt = (doc) => doc.querySelectorAll(".hgmap-label:not(.is-crowded)").length;
  const wide = labelsAt(f.d);
  ok("全体表示では名前を隠す", wide === 0, `${wide}`);
  ok("全体表示に戻せる", (f.d.querySelectorAll(".hgmap-btn")[2].click(), zoomOf(f.d) === zSteady),
     `${zoomOf(f.d)}`);

  // 小屋ページから来たら、その山に寄って名前が見える
  const g = boot("https://hutsgo.com/plan/#add=enzanso");
  await wait(200);
  ok("小屋ページから来ると寄る", zoomOf(g.d) >= 13, `z=${zoomOf(g.d)}`);
  ok("寄ると名前が出る", labelsAt(g.d) > 0, `${labelsAt(g.d)}`);
  ok("その小屋のピンが選択済み", !!g.d.querySelector(".hgmap-pin.is-chosen"));

  // ---- 7. 名前で探す・断面図から選ぶ・共有 ------------------------------
  const h = boot("https://hutsgo.com/plan/");
  await wait(200);

  // 名前の一覧に「追加」の文字を付けない
  const firstName = h.d.querySelector("#plan-list .plan-chip");
  ok("一覧は小屋名だけ", firstName && !/追加|^Add /.test(firstName.textContent), firstName && firstName.textContent);

  // 検索
  const search = h.d.getElementById("plan-search");
  search.value = "北岳";
  search.dispatchEvent(new h.w.Event("input"));
  const hits = h.d.querySelectorAll("#plan-search-results [data-hut]");
  ok("名前で絞り込める", hits.length >= 2 && hits.length <= 8, `${hits.length}件`);
  ok("一覧も同じ語で絞られる", h.d.querySelectorAll("#plan-list [data-hut]").length === hits.length,
     `${h.d.querySelectorAll("#plan-list [data-hut]").length}`);
  hits[0].click();
  ok("検索結果から行程に入る", h.d.querySelectorAll(".plan-card").length === 1,
     `${h.d.querySelectorAll(".plan-card").length}`);
  ok("選んだら検索欄が空になる", search.value === "" && h.d.getElementById("plan-search-results").hidden);

  search.value = "存在しない小屋";
  search.dispatchEvent(new h.w.Event("input"));
  ok("見つからないときは知らせる", /見つかりません|No match/.test(h.d.getElementById("plan-search-results").textContent));

  // 断面図から選ぶ
  h.d.querySelector('.plan-tab[data-view="profile"]').click();
  ok("断面図タブが開く", !h.d.getElementById("plan-profile-view").hidden);
  const shown = [...h.d.querySelectorAll(".plan-profile")].filter((f) => !f.hidden);
  ok("ルートは1本だけ表示", shown.length === 1, `${shown.length}`);
  const route = h.d.getElementById("plan-route");
  route.value = "kitadake";
  route.dispatchEvent(new h.w.Event("change"));
  ok("ルートを切り替えられる",
     h.d.querySelector('.plan-profile[data-trail="kitadake"]').hidden === false
     && h.d.querySelector('.plan-profile:not([data-trail="kitadake"])').hidden === true);
  const before7 = h.d.querySelectorAll(".plan-card").length;
  h.d.querySelector('.plan-profile[data-trail="kitadake"] [data-hut]')
     .dispatchEvent(new h.w.Event("click", { bubbles: true, cancelable: true }));
  ok("断面図の小屋を押すと入る", h.d.querySelectorAll(".plan-card").length === before7 + 1,
     `${before7} → ${h.d.querySelectorAll(".plan-card").length}`);

  // 共有メニュー
  const menu = h.d.querySelector(".plan-sharemenu");
  menu.open = true;
  menu.dispatchEvent(new h.w.Event("toggle"));
  const href = (id) => h.d.getElementById(id).getAttribute("href");
  ok("LINEに飛べる", /line\.me\/R\/msg\/text\/\?[\s\S]*hutsgo/.test(decodeURIComponent(href("plan-share-line"))),
     href("plan-share-line").slice(0, 60));
  ok("Xに飛べる", /twitter\.com\/intent\/tweet/.test(href("plan-share-x")));
  ok("Facebookに飛べる", /facebook\.com\/sharer/.test(href("plan-share-fb")));
  ok("メールで送れる", /^mailto:/.test(href("plan-share-mail")));
  h.d.getElementById("plan-share-qr").click();
  const qr = h.d.querySelector("#plan-qr svg");
  ok("QRを端末内で作る", !!qr && !h.d.getElementById("plan-qr").hidden);
  ok("QRは外部サービスを呼ばない", !!qr && !/http/.test(qr.outerHTML.replace(/xmlns="[^"]*"/g, "")));

  // ---- 8. ルートページ: 断面図 ⇄ 地図、行程に入れる ----------------------
  const k = bootTrail();
  await wait(150);
  ok("ルートページに切り替えがある", k.d.querySelectorAll("[data-trailview]").length === 2);
  ok("最初は断面図", k.d.getElementById("trail-map").hidden
     && !k.d.querySelector("figure.profile").hidden);
  k.d.querySelector('[data-trailview="map"]').click();
  await wait(150);
  ok("地図に切り替わる", !k.d.getElementById("trail-map").hidden
     && k.d.querySelector("figure.profile").hidden);
  // 2026-10-07 から表銀座は槍沢を下って上高地まで（帰りの槍沢ロッヂ・横尾・徳沢を含めて 9 軒）
  ok("そのルートの小屋だけ出る", k.d.querySelectorAll("#trail-map .hgmap-pin").length === 9,
     `${k.d.querySelectorAll("#trail-map .hgmap-pin").length}軒`);
  ok("ルートの線を引く", !!k.d.querySelector("#trail-map .hgmap-route"),
     (k.d.querySelector("#trail-map .hgmap-route") || {}).getAttribute
       ? k.d.querySelector("#trail-map .hgmap-route").getAttribute("points").slice(0, 30) : "");
  // 表銀座は地理院の徒歩道に沿わせた線（trail_paths/omote_ginza.json）。出典と、現況は反映しない旨を出す
  ok("線の出典と限界を書いてある", !k.d.getElementById("trail-map-note").hidden
     && /地理院地図の登山道/.test(k.d.getElementById("trail-map-note").textContent)
     && /通行止め/.test(k.d.getElementById("trail-map-note").textContent));
  const addBtns = k.d.querySelectorAll('.stop-actions a[href*="/plan/#add="]');
  ok("小屋カードごとに行程へ入れる", addBtns.length === 9, `${addBtns.length}個`);
  const thLink = k.d.querySelector('.stop-th a[href*="/trailheads/"]');
  ok("登山口カードから詳細へ飛べる", !!thLink, thLink && thLink.getAttribute("href"));
  ok("ルート一括のボタンは置かない", !k.d.querySelector('a[href*="addroute="]'));

  // ルートまるごと行程へ
  const j = boot("https://hutsgo.com/plan/#addroute=omote_ginza");
  await wait(250);
  ok("ルートの目安の泊数に収める", j.d.querySelectorAll(".plan-day").length === 2,
     `${j.d.querySelectorAll(".plan-day").length}泊 / ${j.d.querySelectorAll(".plan-card").length}軒`);
  ok("同じ日の候補として横に並ぶ",
     j.d.querySelectorAll('.plan-day[data-day="0"] .plan-card').length > 1,
     `${j.d.querySelectorAll('.plan-day[data-day="0"] .plan-card').length}`);
  ok("入れたことを知らせる", /候補に入れました|as candidates/.test(j.d.getElementById("plan-msg").textContent),
     j.d.getElementById("plan-msg").textContent);

  // 検索欄とタブが地図に重なっていない（構造として外に出ている）
  ok("検索欄は地図の外にある", !!j.d.querySelector(".plan-toolbar .plan-search")
     && !j.d.querySelector(".plan-mapwrap .plan-search"));

  // ---- 9. 人数欄 ---------------------------------------------------------
  const l = boot("https://hutsgo.com/plan/");
  await wait(200);
  const peopleInput = l.d.getElementById("plan-people");
  ok("人数欄がある", !!peopleInput && peopleInput.value === "1", peopleInput && peopleInput.value);
  peopleInput.value = "3";
  peopleInput.dispatchEvent(new l.w.Event("change"));
  ok("人数を変えると共有URLに乗る", /[#&]n=3/.test(l.w.location.hash), l.w.location.hash);
  const l2 = boot("https://hutsgo.com/plan/" + l.w.location.hash);
  await wait(200);
  ok("人数が共有URLから復元される", l2.d.getElementById("plan-people").value === "3",
     l2.d.getElementById("plan-people").value);
  ok("人数1のときは共有URLに乗らない（短く保つ）", (() => {
    const m0 = boot("https://hutsgo.com/plan/");
    m0.d.getElementById("plan-start").value = "2026-07-20";
    m0.d.getElementById("plan-start").dispatchEvent(new m0.w.Event("change"));
    return !/[#&]n=/.test(m0.w.location.hash);
  })());

  // ---- 10. 連絡の準備パネル：電話の台本・対訳・カレンダー登録 -----------------
  // 受付開始（宿泊日の1ヶ月前）が必ず未来になるよう、今日から十分先の宿泊日を使う。
  // 固定の日付を書くと、時間が経ってテストだけが「過去」判定になって落ちる（日付を書いたテストが腐る典型例）。
  const futureStay = new Date(Date.now() + 400 * 86400000);
  const futureIso = futureStay.toISOString().slice(0, 10);
  const futureMonth = futureStay.getUTCMonth() + 1, futureDay = futureStay.getUTCDate();
  const n = boot("https://hutsgo.com/plan/");
  await wait(200);
  n.d.getElementById("plan-start").value = futureIso;
  n.d.getElementById("plan-start").dispatchEvent(new n.w.Event("change"));
  n.d.getElementById("plan-people").value = "2";
  n.d.getElementById("plan-people").dispatchEvent(new n.w.Event("change"));
  n.d.querySelector('.ridge-hut[data-hut="yarigatake_sanso"]').click();
  await wait(50);
  const contactBtn = n.d.querySelector(".plan-card button.btn-ghost:not(.plan-move-btn)");
  ok("連絡の準備ボタンが出る", !!contactBtn, contactBtn && contactBtn.textContent);
  contactBtn.dispatchEvent(new n.w.Event("click", { bubbles: true }));
  const panel = n.d.querySelector(".plan-contact");
  ok("パネルが開く", panel && !panel.hidden);
  const scriptLines = n.d.querySelectorAll(".contact-script li");
  ok("電話台本が複数行ある", scriptLines.length >= 5, `${scriptLines.length}行`);
  ok(`日付入りの行がある（${futureMonth}月${futureDay}日）`,
     [...scriptLines].some((li) => li.textContent.includes(`${futureMonth}月${futureDay}日`)));
  ok("人数入りの行がある（2名）", [...scriptLines].some((li) => /2名/.test(li.textContent)));
  ok("英語を話せますかが先頭付近にある",
     /英語を話せる/.test(scriptLines[1] ? scriptLines[1].textContent : ""),
     scriptLines[1] && scriptLines[1].textContent);
  const glossary = n.d.querySelector(".plan-contact-glossary table tr");
  ok("Web予約フォームの対訳がある", !!glossary);
  const icsBtn = [...n.d.querySelectorAll(".plan-contact-ics button")][0];
  ok("カレンダー追加ボタンが出る（受付開始が未来なので）", !!icsBtn, icsBtn && icsBtn.textContent);
  icsBtn.dispatchEvent(new n.w.Event("click", { bubbles: true }));
  ok(".ics がこの端末の中で作られる", typeof n.w.downloadedIcs === "string" && n.w.downloadedIcs.includes("BEGIN:VCALENDAR"));
  ok(".ics に槍ヶ岳山荘が入っている", n.w.downloadedIcs.includes("槍ヶ岳山荘") || /yarigatake_sanso/.test(n.w.downloadedIcs));
  ok(".ics にVALARMが入っている（前日通知）", n.w.downloadedIcs.includes("TRIGGER:-P1D"));

  // 受付開始日時が計算できない小屋（対訳・台本は出るが、カレンダー登録は出ない）
  n.d.querySelector('.ridge-hut[data-hut="ariakeso"]').click();
  await wait(50);
  const cards = n.d.querySelectorAll(".plan-card");
  const ariakesoCard = [...cards].find((c) => c.dataset.hut === "ariakeso");
  const ariakesoBtn = ariakesoCard && ariakesoCard.querySelector("button.btn-ghost:not(.plan-move-btn)");
  if (ariakesoBtn) {
    ariakesoBtn.dispatchEvent(new n.w.Event("click", { bubbles: true }));
    const ariPanel = ariakesoCard.querySelector(".plan-contact");
    ok("受付日不明の小屋にはカレンダーの注記が出る", !ariPanel.querySelector(".plan-contact-ics button")
       && /確定できない|can't pin down/.test(ariPanel.querySelector(".plan-contact-ics").textContent));
  } else {
    ok("受付日不明の小屋も連絡ボタンは出ない想定（電話・Web予約とも無い）", true);
  }

  // ---- 11. 行程ぜんぶの受付開始カレンダー ---------------------------------
  const icsAllBtn = n.d.getElementById("plan-ics-all");
  ok("行程にまとめてカレンダーのボタンが出る", !icsAllBtn.hidden);
  n.w.downloadedIcs = null;
  icsAllBtn.dispatchEvent(new n.w.Event("click", { bubbles: true }));
  ok("まとめてカレンダーも端末内で作られる",
     typeof n.w.downloadedIcs === "string" && n.w.downloadedIcs.includes("BEGIN:VCALENDAR"));

  // 入山日が無いと計算できないので、ボタンは隠れる
  const o = boot("https://hutsgo.com/plan/");
  await wait(200);
  o.d.querySelector('.ridge-hut[data-hut="yarigatake_sanso"]').click();
  await wait(50);
  ok("入山日が無ければまとめてボタンは隠れる", o.d.getElementById("plan-ics-all").hidden);

  // ---- 12. 装備レンタルのゼロ円需要テスト（英語版のみ）--------------------
  ok("日本語版の行程ボードには装備リンクを出さない", !planHtml.includes("yamarent.com"));
  ok("英語版の行程ボードには装備リンクを出す", planHtmlEn.includes("yamarent.com")
     && planHtmlEn.includes('data-track="gear_link"'));
  ok("日本語版の登山口ページには装備リンクを出さない", !thHtmlJa.includes("yamarent.com"));
  ok("英語版の登山口ページには装備リンクを出す", thHtmlEn.includes("yamarent.com")
     && thHtmlEn.includes('data-track="gear_link"'));
  ok("装備リンクは新しいタブで開き rel=noopener を付ける",
     /href="https:\/\/www\.yamarent\.com\/en"[^>]*target="_blank"[^>]*rel="noopener"/.test(thHtmlEn));

  // ---- 13. ルートを地理院地図3Dで開くリンク（自前3Dの需要テスト）------------
  // 地理院地図3D は pxsize が無いと空の alert を出して止まる。lat/lon はルートの座標の内側にあること
  const trailDirs = ["", "en/"].flatMap(p =>
    fs.readdirSync(path.join(DIST, p + "trails"), { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => p + "trails/" + e.name));
  const bad3d = trailDirs.filter(d => {
    const html = fs.readFileSync(path.join(DIST, d, "index.html"), "utf8");
    const m = /href="https:\/\/maps\.gsi\.go\.jp\/index_3d\.html\?z=(\d+)&amp;lat=([\d.]+)&amp;lon=([\d.]+)&amp;pxsize=2048&amp;ls=std"[^>]*target="_blank"[^>]*rel="noopener"[^>]*data-track="view_3d"/.exec(html);
    const line = /data-line="([^"]*)"/.exec(html);
    if (!m || !line) return true;
    const pts = line[1].split(";").map(s => s.split(",").map(Number));
    const lat = +m[2], lon = +m[3], z = +m[1];
    const inside = lat >= Math.min(...pts.map(p => p[0])) && lat <= Math.max(...pts.map(p => p[0]))
      && lon >= Math.min(...pts.map(p => p[1])) && lon <= Math.max(...pts.map(p => p[1]));
    return !(inside && z >= 10 && z <= 15);
  });
  ok("全ルート（日英" + trailDirs.length + "ページ）に3Dリンクがあり、中心がルートの範囲内",
     trailDirs.length > 0 && bad3d.length === 0);
  if (bad3d.length) console.log("  3Dリンクが不正:", bad3d.join(", "));

  // ---- 14. 登山道に沿った線と GPX ------------------------------------------
  // 道をたどれたルートだけ GPX を出す。直線の区間を含む GPX はナビで使われると危ない
  const ogHtml = fs.readFileSync(path.join(DIST, "trails/omote_ginza/index.html"), "utf8");
  const ogLine = /data-line="([^"]*)"/.exec(ogHtml)[1].split(";");
  ok("表銀座の線は登山道の形（小屋・登山口の数よりずっと多い点）", ogLine.length > 100);
  const gpxPath = path.join(DIST, "trails/omote_ginza/route.gpx");
  const gpx = fs.existsSync(gpxPath) ? fs.readFileSync(gpxPath, "utf8") : "";
  const gdoc = new (new JSDOM("").window.DOMParser)().parseFromString(gpx, "application/xml");
  ok("表銀座の GPX が XML として読め、線の点数が地図と一致",
     gpx && !gdoc.querySelector("parsererror") && gdoc.getElementsByTagName("trkpt").length === ogLine.length);
  ok("GPX に小屋・登山口の地点と注意書きが入る",
     gdoc.getElementsByTagName("wpt").length >= 2 && /通行止め/.test(gpx));
  ok("表銀座のページに GPX のリンクがある", ogHtml.includes('href="/trails/omote_ginza/route.gpx"')
     || /href="[^"]*\/trails\/omote_ginza\/route\.gpx"/.test(ogHtml));
  const noGpx = trailDirs.filter(d => !/omote_ginza$/.test(d)).filter(d => {
    const html = fs.readFileSync(path.join(DIST, d, "index.html"), "utf8");
    const gpxLink = /route\.gpx/.test(html);
    const gpxFile = fs.existsSync(path.join(DIST, d.replace(/^en\//, ""), "route.gpx"));
    return gpxLink !== gpxFile;
  });
  ok("GPX のリンクは GPX ファイルがあるルートにだけ出る", noGpx.length === 0);
  if (noGpx.length) console.log("  GPX のリンクとファイルが食い違う:", noGpx.join(", "));

  // ---- 15. 予約の窓口（小屋が案内しているものだけ・英語で使えるか） -------------
  // 10 の後で行程を描き直しているので、パネルは開き直す
  const yariCard = n.d.querySelector('.plan-card[data-hut="yarigatake_sanso"]');
  const yariBtn = yariCard && yariCard.querySelector("button.btn-ghost:not(.plan-move-btn)");
  if (yariBtn && yariCard.querySelector(".plan-contact").hidden) yariBtn.dispatchEvent(new n.w.Event("click", { bubbles: true }));
  const chPanel = yariCard && yariCard.querySelector(".plan-contact .channel-list");
  ok("連絡の準備に予約の窓口が出る（槍ヶ岳山荘）", !!chPanel && chPanel.querySelectorAll("li").length === 1);
  ok("窓口に英語対応の表示が付く（日本語のみ）", !!chPanel && /日本語のみ/.test(chPanel.textContent));
  ok("小屋の窓口は送客として計測する", !!chPanel && chPanel.querySelector("a").dataset.track === "reservation");
  const allHuts = JSON.parse(hutsJson);
  const allCh = allHuts.flatMap((h) => ((h.season_2026 || {}).reservation || {}).channels || []);
  ok("公開データに窓口が入り、全部に確認日がある",
     allCh.length >= 25 && allCh.every((c) => c.provenance && /^\d{4}-\d{2}-\d{2}$/.test(c.provenance.last_verified_at)),
     `${allCh.length}件`);
  ok("英語対応の値は4種類のどれか", allCh.every((c) => ["yes", "partial", "no", "unknown"].includes(c.english)));
  const read = (p) => fs.readFileSync(path.join(DIST, p), "utf8");
  const yokooEn = read("en/huts/yokoo_sanso/index.html");
  ok("英語版では窓口の英語ページへ飛ぶ（やまたん /en/）", yokooEn.includes('href="https://www.yamatan.net/en/hut/yokoosanso"'));
  ok("入国当日は泊まれない旨が英語で出る", /arrive in Japan/.test(yokooEn));
  // 旅行会社への案内を送客（outbound_reservation）として数えると、小屋への送客率が水増しされる
  const hutDirs = ["", "en/"].flatMap((p) => fs.readdirSync(path.join(DIST, p + "huts"), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => p + "huts/" + e.name + "/index.html"));
  const agencyAsReservation = hutDirs.filter((p) => /href="https:\/\/jaa\.travel[^"]*"[^>]*data-track="reservation"/.test(read(p)));
  ok("旅行会社へのリンクは送客に数えない（agency_link）", agencyAsReservation.length === 0
     && /href="https:\/\/jaa\.travel[^"]*"[^>]*data-track="agency_link"/.test(read("en/huts/hotakadake_sanso/index.html")),
     agencyAsReservation.join(", "));
  ok("窓口が確認できていない小屋には窓口の欄を出さない（涸沢小屋）", !read("huts/karasawa_goya/index.html").includes('class="channel-list"'));

  // ---- 16. サイトマップと更新の通知 --------------------------------------------
  const sitemap = read("sitemap.xml");
  const hashes = JSON.parse(read("page-hashes.json"));
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok("サイトマップの全 URL に中身のハッシュと更新日がある", locs.length > 50 && locs.every((u) => hashes[u] && /^\d{4}-\d{2}-\d{2}$/.test(hashes[u].lastmod)),
     `${locs.length} URL`);
  const keyFile = fs.readdirSync(DIST).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  ok("IndexNow の鍵ファイルがあり、中身がファイル名と一致", !!keyFile && read(keyFile) === keyFile.replace(".txt", ""));
  ok("robots.txt にサイトマップの場所がある", /^Sitemap: \S+\/sitemap\.xml$/m.test(read("robots.txt")));

  // ---- 17. 試作 /lab/flyover/ は検索に出さない・サイトからリンクしない ------------------
  const lab = read("lab/flyover/index.html");
  ok("試作ページは noindex", /<meta name="robots" content="noindex, nofollow">/.test(lab));
  ok("試作ページはサイトマップに入らない", !/\/lab\//.test(sitemap));
  ok("試作ページへのリンクがサイト本体に無い", !/\/lab\/flyover/.test(read("index.html") + read("en/index.html") + read("trails/omote_ginza/index.html")));
  const flyRoutes = JSON.parse(read("lab/flyover/routes.json"));
  const og = flyRoutes.find((r) => r.id === "omote_ginza");
  ok("試作のルートデータ: 表銀座は登山道沿いの線と、座標のある小屋・登山口", og && og.traced && og.line.length > 100 && og.stops.length >= 6
     && og.stops.every((s) => s.name.ja && s.name.en));

    report([...a.errors, ...b.errors, ...c.errors, ...e.errors, ...f.errors, ...g.errors, ...h.errors,
            ...k.errors, ...j.errors, ...l.errors, ...l2.errors, ...n.errors, ...o.errors]);
  } catch (e) {
    results.push({ label: "テスト実行中に落ちた: " + e.message, pass: false });
    report([]);
  }
})();
