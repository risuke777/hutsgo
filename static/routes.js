/* トップのルート一覧: 名前で探す・日程／行き方／体力で絞る・「今の時期」。
   季節は各カードの data-season（出典つきの「例年」の月日）と、見ている人の今日の日付で決める。何も送らない。 */
(function () {
  "use strict";
  var cards = [].slice.call(document.querySelectorAll(".route-card[data-q]"));
  if (!cards.length) return;
  var q = document.getElementById("route-q"), nOut = document.getElementById("route-n");
  var en = document.documentElement.lang === "en";
  var f = { days: "", public: "", stamina: "", range: "", tech: "" };

  // 槍ヶ岳／槍ケ岳、カタカナ／ひらがな、全角／半角を同じに扱う
  function norm(s) {
    return String(s || "").normalize("NFKC").toLowerCase().replace(/[ヶヵ]/g, "ケ")
      .replace(/[\u30a1-\u30f6]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); }).replace(/\s+/g, "");
  }
  cards.forEach(function (c) { c._q = norm(c.dataset.q + c.textContent); });

  function match(c) {
    var words = norm(q.value).length ? String(q.value).split(/\s+/).map(norm).filter(Boolean) : [];
    if (words.some(function (w) { return c._q.indexOf(w) < 0; })) return false;
    var n = +c.dataset.nights;
    if (f.days === "0" && n !== 0) return false;
    if (f.days === "1" && n !== 1) return false;
    if (f.days === "2" && n < 2) return false;
    if (f.public === "1" && c.dataset.public !== "1") return false;
    if (f.range && c.dataset.range !== f.range) return false;
    if (f.tech && (!c.dataset.tech || f.tech.indexOf(c.dataset.tech) < 0)) return false;
    if (f.stamina) {
      var s = +c.dataset.stamina, hi = +f.stamina, lo = hi === 3 ? 1 : hi === 5 ? 4 : 6;
      if (!s || s < lo || s > hi) return false;
    }
    return true;
  }
  function render() {
    if (window.HG_stopPlayer) window.HG_stopPlayer();   // 絞り込みでカードが動くので、重ねている動画を外す
    var k = 0;
    cards.forEach(function (c) { var ok = match(c); c.hidden = !ok; if (ok) k++; });
    nOut.textContent = k ? nOut.dataset.fmt.replace("{n}", k) : nOut.dataset.none;
  }
  q.addEventListener("input", render);
  document.querySelectorAll(".finder-row button").forEach(function (b) {
    b.addEventListener("click", function () {
      var on = b.getAttribute("aria-pressed") !== "true";
      document.querySelectorAll('.finder-row button[data-f="' + b.dataset.f + '"]').forEach(function (x) { x.setAttribute("aria-pressed", "false"); });
      b.setAttribute("aria-pressed", String(on));
      f[b.dataset.f] = on ? b.dataset.v : "";
      render();
    });
  });

  // ---- 今の時期: 例年の月日の幅に今日が入っている季節。閉山中はカードにだけ出す
  var now = new Date(), md = ("0" + (now.getMonth() + 1)).slice(-2) + "-" + ("0" + now.getDate()).slice(-2);
  var iso = now.getFullYear() + "-" + md;
  function inRange(s, e) { return s <= e ? (md >= s && md <= e) : (md >= s || md <= e); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  var list = document.getElementById("now-list"), items = 0, groups = {}, order = [];
  cards.forEach(function (c) {
    var ss = [], stays = [];
    try { ss = JSON.parse(c.dataset.season || "[]"); stays = JSON.parse(c.dataset.stays || "[]"); } catch (e) { return; }
    var act = ss.filter(function (s) { return inRange(s.s, s.e); });
    var closed = act.filter(function (s) { return s.k === "closed"; })[0];
    var best = act.filter(function (s) { return s.k === "autumn" || s.k === "flowers" || s.k === "open"; })[0];
    // 泊まる小屋のうち、今日営業している軒数（日付の分かる小屋だけ数える）
    var known = stays.filter(function (h) { return h[0] === "year_round" || (h[0] === "open" && h[1] && h[2]); });
    var open = known.filter(function (h) { return h[0] === "year_round" || (iso >= h[1] && iso <= h[2]); });
    var line = c.querySelector(".route-now"), txt = "";
    if (closed) { txt = closed.l; line.classList.add("is-closed"); }
    else if (best) txt = best.l;
    if (!closed && known.length) txt += (txt ? (en ? " · " : "・") : "") + (en ? open.length + " of " + known.length + " huts open today" : "今日営業の小屋 " + open.length + "/" + known.length + " 軒");
    if (txt) { line.textContent = txt; line.hidden = false; }
    if (best && !closed) {
      var key = best.l + "|" + best.u;
      if (!groups[key]) { groups[key] = { s: best, cards: [] }; order.push(key); }
      groups[key].cards.push(c);
    }
  });
  order.forEach(function (key) {
    var g = groups[key], li = document.createElement("li");
    li.innerHTML = '<span class="now-label">' + esc(g.s.l) + ' <small>（<a href="' + esc(g.s.u) + '" rel="noopener">' + esc(g.s.src) + "</a>）</small></span>" +
      g.cards.map(function (c) {   // 長い名前は括弧の前まで
        var nm = c.querySelector("strong").textContent.replace(/\s*[（(].*$/, "");
        return '<a href="' + esc(c.getAttribute("href")) + '">' + esc(nm) + "</a>";
      }).join(en ? ", " : "・");
    list.appendChild(li); items++;
  });
  if (items) {
    var h = document.getElementById("now-h");
    h.textContent = h.dataset.fmt.replace("{m}", en ? now.toLocaleString("en", { month: "long" }) : (now.getMonth() + 1) + "月");
    document.getElementById("route-now").hidden = false;
  }
  render();

  // ---- カードの 3D: スクロールが止まったとき、画面の真ん中のカードにだけ山ムービー（埋め込み）を重ねて流す。
  //      iframe は 1 つを使い回し、最初に止まったときに読む。動きを減らす設定・データ節約のときは流さない（絵だけ）
  var medias = [].slice.call(document.querySelectorAll(".route-media[data-play]"));
  var list0 = document.querySelector(".route-list[data-player]");
  var noAuto = (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) || (navigator.connection && navigator.connection.saveData);
  if (!medias.length || !list0 || noAuto || !("IntersectionObserver" in window)) return;
  var fr = null, ready = false, cur = null, timer = 0, vis = new Map();
  function put(el) {
    var r = el.getBoundingClientRect();
    fr.style.top = (r.top + window.scrollY) + "px"; fr.style.left = (r.left + window.scrollX) + "px";
    fr.style.width = r.width + "px"; fr.style.height = r.height + "px";
  }
  function start(el) {
    if (cur === el) return;
    cur = el;
    if (!fr) {
      fr = document.createElement("iframe");
      fr.className = "route-player"; fr.title = list0.dataset.playerTitle; fr.setAttribute("allow", "autoplay"); fr.tabIndex = -1;
      fr.src = list0.dataset.player + "&route=" + encodeURIComponent(el.dataset.play);
      document.body.appendChild(fr);
      window.addEventListener("message", function (e) {
        if (e.origin !== location.origin || !e.data || e.data.type !== "ready") return;
        ready = true; if (cur) setTimeout(function () { if (cur) fr.classList.add("is-on"); }, 300);
      });
      put(el);
      return;
    }
    put(el); fr.classList.remove("is-on");
    if (ready) {
      fr.contentWindow.postMessage({ type: "route", id: el.dataset.play }, location.origin);
      setTimeout(function () { if (cur === el) fr.classList.add("is-on"); }, 1400);   // 新しいルートを読み終えるまで絵を見せておく
    }
  }
  function stop() {
    if (!cur) return;
    cur = null;
    if (fr) { fr.classList.remove("is-on"); if (ready) fr.contentWindow.postMessage({ type: "pause" }, location.origin); }
  }
  window.HG_stopPlayer = stop;
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { vis.set(e.target, e.intersectionRatio); });
    if (cur && (vis.get(cur) || 0) < 0.5) stop();
  }, { threshold: [0, 0.5, 0.9, 1] });
  medias.forEach(function (m) { io.observe(m); });
  function settle() {
    var best = null, bd = 1e9, mid = window.innerHeight / 2;
    medias.forEach(function (m) {
      if ((vis.get(m) || 0) < 0.9 || m.closest(".route-card").hidden) return;
      var r = m.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - mid);
      if (d < bd) { bd = d; best = m; }
    });
    if (best) start(best); else stop();
  }
  window.addEventListener("scroll", function () { clearTimeout(timer); timer = setTimeout(settle, 650); }, { passive: true });
  window.addEventListener("resize", function () { if (cur) put(cur); });
  timer = setTimeout(settle, 1200);   // 開いてすぐ止まっていれば、最初に見えているカードを流す
})();
