/* ルートを選ぶ縦フィード（/lab/feed/）
   - 条件（日数・行き方・体力度）で絞り、ルートを縦に流す。中央のカードのルートだけ 3D を流す
   - 3D は 1 つの iframe（山ムービーの埋め込み表示）をカードの後ろに置き、ルートを切り替える。動画ファイルは持たない
   - 保存はこの端末の中だけ（localStorage）。計測は track.php にイベント名だけ送る（個人は追わない） */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var BASE = location.pathname.replace(/\/lab\/feed\/.*$/, "");
  var API = (document.querySelector('meta[name="hutsgo-api"]') || {}).content || "";
  var data = null, items = [], cur = null, ready = false, pending = null, filt = { nights: "", access: "", stamina: "" };

  // ---- 保存（端末の中だけ。読めない環境でも動く）
  var saved = [];
  try { saved = JSON.parse(localStorage.getItem("hg_feed_saved") || "[]"); } catch (e) { saved = []; }
  function keep() { try { localStorage.setItem("hg_feed_saved", JSON.stringify(saved)); } catch (e) { /* 保存できない環境 */ } $("fd-saved-n").textContent = String(saved.length); }

  function track(ev, trail) {
    if (!API || !navigator.sendBeacon) return;
    navigator.sendBeacon(API + "/track.php", new Blob([JSON.stringify({ ev: ev, lang: "ja", hut: "", trail: trail || "", page: location.pathname, ref: "" })], { type: "text/plain" }));
  }

  // ---- 表示用の文字
  function days(n) { return n == null ? null : n === 0 ? "日帰り" : n + "泊" + (n + 1) + "日"; }
  function ct(min) { if (!min) return null; var h = Math.floor(min / 60), m = min % 60; return "CT " + h + "h" + (m ? String(m).padStart(2, "0") : ""); }
  var MODE = { bus: "バス", train: "電車", taxi: "タクシー", car: "車", shuttle: "シャトル", ropeway: "ロープウェイ", ferry: "船" };
  function accessText(a) {
    if (!a) return null;
    var m = a.modes.map(function (x) { return MODE[x] || x; }).join("・");
    return a.name + (m ? "（" + m + (a.from.length ? ": " + a.from.join("・") : "") + "）" : "") + (a.car_restricted ? "・マイカー規制" : "");
  }
  function canPublic(r) { var a = r.start; return !!(a && a.modes.some(function (x) { return x === "bus" || x === "train" || x === "ropeway" || x === "shuttle"; })); }
  function canCar(r) { var a = r.start; return !!(a && a.parking > 0 && !a.car_restricted); }

  // ---- 道の形（再生していないカードの絵）
  function routeSvg(line) {
    if (!line || line.length < 2) return "";
    var la = line.map(function (p) { return p[0]; }), lo = line.map(function (p) { return p[1]; });
    var k = Math.cos((Math.min.apply(null, la) + Math.max.apply(null, la)) / 2 * Math.PI / 180);
    var x0 = Math.min.apply(null, lo) * k, x1 = Math.max.apply(null, lo) * k, y0 = Math.min.apply(null, la), y1 = Math.max.apply(null, la);
    var sc = Math.min(100 / ((x1 - x0) || 1e-6), 100 / ((y1 - y0) || 1e-6)), ox = (100 - (x1 - x0) * sc) / 2, oy = (100 - (y1 - y0) * sc) / 2;
    var pts = line.map(function (p) { return (ox + (p[1] * k - x0) * sc).toFixed(1) + "," + (oy + (y1 - p[0]) * sc).toFixed(1); }).join(" ");
    return '<svg viewBox="-4 -4 108 108" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><polyline points="' + pts +
      '" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/><polyline points="' + pts +
      '" fill="none" stroke="#E4572E" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function card(it) {
    var r = it.route, el = document.createElement("article"), facts = [], g = r && r.grading;
    el.className = "fd-card"; el.dataset.key = it.key;
    if (r) {
      if (days(r.nights)) facts.push("<li>" + days(r.nights) + "</li>");
      if (ct(r.course_min)) facts.push("<li>" + ct(r.course_min) + "</li>");
      if (g) facts.push('<li class="' + (g.confidence === "verified" ? "" : "is-unv") + '" title="' + esc(g.source + " No." + g.no + " " + g.route + (g.note ? "（" + g.note + "）" : "")) + '">体力 ' + g.stamina + " · 技術 " + g.technical + (g.match === "near" ? "（近いルート）" : "") + (g.confidence === "verified" ? "" : "・確認中") + "</li>");
    }
    if (it.contrib) facts.unshift("<li>" + esc(it.contrib.km) + " km</li>", "<li>↑" + esc(it.contrib.up) + "m</li>");
    var huts = r && r.huts.length ? '<p class="fd-line">山小屋 <b>' + r.huts.map(esc).join(" → ") + "</b></p>" : "";
    var acc = r && accessText(r.start) ? '<p class="fd-line">登山口 <b>' + esc(accessText(r.start)) + "</b>" + (r.end && r.end.id !== r.start.id ? "／下山 " + esc(r.end.name) : "") + "</p>" : "";
    var isSaved = saved.indexOf(it.key) >= 0;
    el.innerHTML = '<div class="fd-poster">' + routeSvg(it.line) + '</div><div class="fd-shade"></div>' +
      '<div class="fd-info">' + (it.contrib ? '<span class="fd-kind">みんなの道・投稿（未確認）</span>' : "") +
      '<h2 class="fd-name">' + esc(it.contrib ? (it.contrib.title || "投稿された道") : r.name) + "</h2>" +
      (facts.length ? '<ul class="fd-facts">' + facts.join("") + "</ul>" : "") + huts + acc +
      (it.contrib && it.contrib.comment ? '<p class="fd-line">' + esc(it.contrib.comment) + "</p>" : "") + "</div>" +
      '<div class="fd-acts"><button type="button" class="fd-act" data-save="' + esc(it.key) + '" aria-pressed="' + isSaved + '"><span class="ic" aria-hidden="true">★</span>保存</button>' +
      '<button type="button" class="fd-act" data-share="' + esc(it.key) + '"><span class="ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>シェア</button>' +
      (r ? '<a class="fd-act" href="' + esc(r.url) + '" data-detail="' + esc(r.id) + '"><span class="ic" aria-hidden="true">↑</span>詳しく</a>' : "") + "</div>";
    return el;
  }

  // ---- 絞り込み
  function match(it) {
    var r = it.route;
    if (filt.nights) { if (!r || r.nights == null) return false; var n = Number(filt.nights); if (n === 3 ? r.nights < 3 : r.nights !== n) return false; }
    if (filt.access === "public" && !(r && canPublic(r))) return false;
    if (filt.access === "car" && !(r && canCar(r))) return false;
    if (filt.stamina) {
      var s = r && r.grading && r.grading.stamina, hi = Number(filt.stamina), lo = hi === 6 ? 1 : hi === 8 ? 7 : 9;
      if (!s || s < lo || s > hi) return false;
    }
    return true;
  }
  function render() {
    var feed = $("fd-feed"); feed.innerHTML = "";
    var list = items.filter(match);
    list.forEach(function (it) { feed.appendChild(card(it)); });
    $("fd-none").hidden = list.length > 0;
    $("fd-count").textContent = String(list.length);
    // ボタンの文字に、選んでいる条件をそのまま出す（何も選んでいなければ「絞り込み」）
    var on = ["nights", "access", "stamina"].filter(function (k) { return filt[k]; }).map(function (k) {
      var b = document.querySelector('[data-group="' + k + '"] [data-v="' + filt[k] + '"]'); return b ? (k === "stamina" ? "体力" : "") + b.textContent : "";
    });
    $("fd-filter-label").textContent = on.length ? on.join("・") : "絞り込み";
    $("fd-filter-open").classList.toggle("is-on", on.length > 0);
    feed.scrollTop = 0; cur = null;
    observe();
  }

  // ---- 中央のカードを見つけて、そのルートを 3D で流す
  var io = null, watch = { key: null, since: 0, sent: {} };
  function observe() {
    if (io) io.disconnect();
    io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting && e.intersectionRatio >= 0.6) activate(e.target); });
    }, { root: $("fd-feed"), threshold: [0.6] });
    document.querySelectorAll(".fd-card").forEach(function (c) { io.observe(c); });
  }
  function activate(el) {
    if (cur === el) return;
    if (cur) cur.classList.remove("is-active");
    cur = el; el.classList.add("is-active");
    var it = items.filter(function (x) { return x.key === el.dataset.key; })[0];
    if (!it) return;
    watch = { key: it.key, trail: it.route ? it.route.id : "", sec: 0, sent: {} };
    var msg = it.contrib ? { type: "link", link: it.contrib.link, title: it.contrib.title } : { type: "route", id: it.route.id };
    if (ready) $("fd-player").contentWindow.postMessage(msg, location.origin); else pending = msg;
  }
  // 見ている秒数（画面に出ている間だけ数える。2・5・15・30 秒を超えたら 1 回ずつ送る）
  setInterval(function () {
    if (!watch.key || document.hidden) return;
    watch.sec = (watch.sec || 0) + 1;
    [2, 5, 15, 30].forEach(function (s2) {
      if (watch.sec >= s2 && !watch.sent[s2]) { watch.sent[s2] = true; track(s2 === 2 ? "feed_view" : "feed_w" + s2, watch.trail); }
    });
  }, 1000);
  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === "ready") { ready = true; if (pending) { $("fd-player").contentWindow.postMessage(pending, location.origin); pending = null; } }
  });

  // ---- 詳しく: ルートのページをシートで開く。サイトの見出しと足もとは隠し、後ろの 3D は止める
  var lastFocus = null;
  function player(msg) { try { $("fd-player").contentWindow.postMessage(msg, location.origin); } catch (e) { /* まだ無い */ } }
  function openDetail(url, id) {
    var it = items.filter(function (x) { return x.route && x.route.id === id; })[0];
    $("fd-detail-h").textContent = it ? it.route.name : "ルート";
    $("fd-detail-page").href = url;
    var body = document.querySelector(".fd-detail-body"), old = body.querySelector("iframe");
    if (old) old.remove();
    $("fd-detail-loading").hidden = false;
    var fr = document.createElement("iframe"); fr.title = "ルートの詳しい情報"; fr.src = url;
    fr.addEventListener("load", function () {
      $("fd-detail-loading").hidden = true;
      try {   // 同じサイトなので中に手が届く。見出し・足もと・言語切り替えは隠す
        var st = fr.contentDocument.createElement("style");
        st.textContent = ".site-head,.site-foot,.skip-link{display:none!important}body{padding-top:0!important}";
        fr.contentDocument.head.appendChild(st);
      } catch (e) { /* 隠せなくても読める */ }
    });
    body.appendChild(fr);
    $("fd-compare").hidden = true;
    $("fd-detail").hidden = false;
    lastFocus = document.activeElement; $("fd-detail-close").focus();
    player({ type: "pause" });
  }
  function closeDetail() {
    $("fd-detail").hidden = true;
    var fr = document.querySelector(".fd-detail-body iframe"); if (fr) fr.remove();
    player({ type: "play" });
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $("fd-detail-close").addEventListener("click", closeDetail);
  $("fd-detail").addEventListener("click", function (e) { if (e.target === $("fd-detail")) closeDetail(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("fd-detail").hidden) closeDetail(); });

  // ---- シェア: 端末の共有シートを開く（無い環境ではリンクをコピー）。リンクを開くとそのルートのカードから始まる
  var toastT = null;
  function toast(msg) {
    var t = $("fd-toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function share(key) {
    var it = items.filter(function (x) { return x.key === key; })[0];
    if (!it) return;
    var r = it.route, url = location.origin + BASE + "/lab/feed/#r=" + encodeURIComponent(key);
    var name = it.contrib ? (it.contrib.title || "投稿された道") : r.name;
    var bits = r ? [days(r.nights), ct(r.course_min)].filter(Boolean).join("・") : "";
    var text = name + (bits ? "｜" + bits : "") + "｜3D で見る";
    track("feed_share", r ? r.id : "");
    if (navigator.share) {
      navigator.share({ title: name + " | HutsGo", text: text, url: url }).catch(function () { /* 閉じただけ */ });
      return;
    }
    var done = function () { toast("リンクをコピーしました"); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { toast(url); });
    else toast(url);
  }

  // ---- 比べる
  function compare() {
    var rows = items.filter(function (it) { return saved.indexOf(it.key) >= 0; });
    var t = $("fd-table");
    $("fd-compare-empty").hidden = rows.length > 0; t.hidden = !rows.length;
    t.innerHTML = "<thead><tr><th>ルート</th><th>日数</th><th>CT</th><th>体力・技術</th><th>山小屋</th><th>登山口</th></tr></thead><tbody>" +
      rows.map(function (it) {
        var r = it.route, g = r && r.grading;
        return "<tr><td>" + (r ? '<a href="' + esc(r.url) + '" data-detail="' + esc(r.id) + '">' + esc(r.name) + "</a>" : esc(it.contrib.title || "投稿された道") + "（投稿）") + "</td><td>" + esc(r ? days(r.nights) || "—" : "—") +
          "</td><td>" + esc(r ? ct(r.course_min) || "—" : "—") + "</td><td>" + (g ? g.stamina + "・" + g.technical + (g.confidence === "verified" ? "" : "（確認中）") : "—") +
          "</td><td>" + esc(r ? r.huts.join("、") || "—" : "—") + "</td><td>" + esc(r && r.start ? r.start.name : "—") + "</td></tr>";
      }).join("") + "</tbody>";
    $("fd-compare").hidden = false;
    track("feed_compare");
  }

  // ---- 起動
  document.addEventListener("click", function (e) {
    var sv = e.target.closest("[data-save]");
    if (sv) {
      var k = sv.dataset.save, i = saved.indexOf(k);
      if (i >= 0) saved.splice(i, 1); else { saved.push(k); track("feed_save", (items.filter(function (x) { return x.key === k; })[0] || {}).route ? k : ""); }
      sv.setAttribute("aria-pressed", String(i < 0)); keep(); return;
    }
    var sh = e.target.closest("[data-share]");
    if (sh) { share(sh.dataset.share); return; }
    var dt = e.target.closest("[data-detail]");
    if (dt) {
      track("feed_detail", dt.dataset.detail);
      // 新しいタブ・別ウインドウで開く操作はそのまま。ふつうに押したらシートで開く
      if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) { e.preventDefault(); openDetail(dt.getAttribute("href"), dt.dataset.detail); }
      return;
    }
    var ch = e.target.closest(".fd-chips button");
    if (ch) {
      var grp = ch.parentNode.dataset.group; filt[grp] = ch.dataset.v;
      ch.parentNode.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-checked", String(b === ch)); });
      render();
    }
  });
  $("fd-compare-open").addEventListener("click", compare);
  $("fd-compare-close").addEventListener("click", function () { $("fd-compare").hidden = true; });
  document.querySelectorAll(".fd-chips").forEach(function (g) { g.querySelector("button").setAttribute("aria-checked", "true"); });
  keep();
  // 条件のパネル: 「条件」で開き、選ぶとその場で絞り、「◯ ルートを見る」で閉じる
  function setPanel(open) { $("fd-filters").hidden = !open; $("fd-filter-open").setAttribute("aria-expanded", String(open)); }
  $("fd-filter-open").addEventListener("click", function () { setPanel($("fd-filters").hidden); });
  $("fd-filter-done").addEventListener("click", function () { setPanel(false); });

  fetch(BASE + "/lab/feed/feed.json").then(function (r) { return r.json(); }).then(function (d) {
    data = d;
    var byId = {};
    d.routes.forEach(function (r) { byId[r.id] = r; items.push({ key: r.id, route: r, line: r.line }); });
    // 提供された道: 近いルートがあればその直後に、無ければ最後に
    (d.contrib || []).forEach(function (c) {
      var it = { key: "c:" + c.id, contrib: c, route: null, line: null }, at = -1;
      if (c.trail && byId[c.trail]) { it.route = null; for (var i = 0; i < items.length; i++) if (items[i].key === c.trail) at = i; }
      if (at >= 0) items.splice(at + 1, 0, it); else items.push(it);
    });
    render();
    var m = /[#&]r=([^&]+)/.exec(location.hash), key = m ? decodeURIComponent(m[1]) : "";
    var el = key && [].filter.call(document.querySelectorAll(".fd-card"), function (c) { return c.dataset.key === key; })[0];
    if (el) $("fd-feed").scrollTop = el.offsetTop;
  });
})();
