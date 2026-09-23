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
const planJs = fs.readFileSync(path.join(DIST, "static/plan.js"), "utf8");
const planHtml = fs.readFileSync(path.join(DIST, "plan/index.html"), "utf8");

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
      w.fetch = () => Promise.resolve({ json: () => Promise.resolve(JSON.parse(hutsJson)) });
      w.navigator.clipboard = { writeText: () => Promise.resolve() };
      const store = {};
      Object.defineProperty(w, "localStorage", {
        value: {
          getItem: (k) => (k in store ? store[k] : null),
          setItem: (k, v) => { store[k] = String(v); },
          removeItem: (k) => { delete store[k]; },
        },
      });
    },
  });
  [qrJs, mapJs, planJs].forEach(function (code) {
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

    report([...a.errors, ...b.errors, ...c.errors, ...e.errors, ...f.errors, ...g.errors, ...h.errors]);
  } catch (e) {
    results.push({ label: "テスト実行中に落ちた: " + e.message, pass: false });
    report([]);
  }
})();
