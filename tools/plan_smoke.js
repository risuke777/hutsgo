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
const mapJs = fs.readFileSync(path.join(DIST, "static/map.js"), "utf8");
const planJs = fs.readFileSync(path.join(DIST, "static/plan.js"), "utf8");
const planHtml = fs.readFileSync(path.join(DIST, "plan/index.html"), "utf8");

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
  [mapJs, planJs].forEach(function (code) {
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
  ok("選択盤が出る", a.d.querySelectorAll(".ridge-hut").length === 21,
     `${a.d.querySelectorAll(".ridge-hut").length}軒`);

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
  ok("地図に小屋が出る", pinCount > 0 && pinCount <= 21, `${pinCount}`);
  const tile = e.d.querySelector(".hgmap-tile");
  ok("タイルは地理院のURL", !!tile && /cyberjapandata[.]gsi[.]go[.]jp\/xyz\/std\/\d+\/\d+\/\d+[.]png$/.test(tile.src),
     tile && tile.src);
  ok("出典が出ている", /地理院タイル/.test(e.d.querySelector(".hgmap-attr").textContent));
  ok("拡大縮小と全体表示のボタン", e.d.querySelectorAll(".hgmap-btn").length === 3);
  e.d.querySelector(".hgmap-pin").click();
  ok("地図から行程に入る", e.d.querySelectorAll(".plan-card").length === 1,
     `${e.d.querySelectorAll(".plan-card").length}`);
  e.d.querySelector('.plan-tab[data-view="ridge"]').click();
  ok("稜線タブに切り替わる",
     !e.d.getElementById("plan-ridge-view").hidden && e.d.getElementById("plan-map-view").hidden);

    report([...a.errors, ...b.errors, ...c.errors, ...e.errors]);
  } catch (e) {
    results.push({ label: "テスト実行中に落ちた: " + e.message, pass: false });
    report([]);
  }
})();
