/* 一覧の「探す」: トップ（ルート）と「山から探す」（山）で同じものを使う。
   - 名前で探す、よく使う組み合わせ（ワンタップ）、条件（日程・きつさ・道のようす・行き方・エリア・今行ける）
   - 並び順は「今の時期のおすすめ順」: 出典つきの季節（紅葉・開山・閉山）と、泊まる小屋が今日営業しているかで決める
   - 何も送らない。日付は見ている人の端末の今日 */
(function () {
  "use strict";
  var items = [].slice.call(document.querySelectorAll("[data-item]"));
  if (!items.length) return;
  var q = document.getElementById("route-q"), nOut = document.getElementById("route-n"), clearBtn = document.getElementById("finder-clear");
  var en = document.documentElement.lang === "en";
  var f = {};
  // 「山域から探す」などのリンク: ?range=… で開いたらその山域で絞っておく
  try { var sp0 = new URLSearchParams(location.search); if (sp0.get("range")) f.range = sp0.get("range"); } catch (e) {}

  // 槍ヶ岳／槍ケ岳、カタカナ／ひらがな、全角／半角、アクセント（Hütte／Hutte）、中黒・ハイフン（トレ・チーメ／トレチーメ）を同じに扱う
  function norm(s) {
    return String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").normalize("NFKC").toLowerCase().replace(/[ヶヵ]/g, "ケ")
      .replace(/[・･·'’.\-‐]/g, "")
      .replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); }).replace(/\s+/g, "");
  }
  function parse(s, d) { try { return JSON.parse(s || ""); } catch (e) { return d; } }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---- 今の時期: 例年の月日の幅に今日が入っている季節と、今日営業している小屋
  var now = new Date(), md = ("0" + (now.getMonth() + 1)).slice(-2) + "-" + ("0" + now.getDate()).slice(-2);
  var iso = now.getFullYear() + "-" + md;
  function inRange(s, e) { return s <= e ? (md >= s && md <= e) : (md >= s || md <= e); }
  items.forEach(function (c, i) {
    c._q = norm(c.dataset.q + " " + c.textContent);
    c._routes = parse(c.dataset.routes, []);   // [{n: 泊数, s: 体力度, t: 難易度, p: 電車バスで行けるか}]
    c._i = i;
    var ss = parse(c.dataset.season, []), stays = parse(c.dataset.stays, []);
    var act = ss.filter(function (s) { return inRange(s.s, s.e); });
    var closed = act.filter(function (s) { return s.k === "closed"; })[0];
    var hi = act.filter(function (s) { return s.k === "autumn" || s.k === "flowers"; })[0];
    var open = act.filter(function (s) { return s.k === "open"; })[0];
    // 泊まる小屋のうち、今日営業している軒数（日付の分かる小屋だけ数える）
    var known = stays.filter(function (h) { return h[0] === "year_round" || (h[0] === "open" && h[1] && h[2]); });
    var up = known.filter(function (h) { return h[0] === "year_round" || (iso >= h[1] && iso <= h[2]); });
    // 山のカードは、開いているルートが 1 本でもあれば閉山扱いにしない
    if (closed && ss.some(function (s) { return s.k !== "closed" && inRange(s.s, s.e); })) closed = null;
    c._closed = !!closed || (known.length > 0 && up.length === 0);
    c._best = closed ? null : (hi || open || null);
    c._score = (closed ? -100 : 0) + (hi && !closed ? 50 : 0) + (open && !closed ? 20 : 0) + (known.length ? (up.length ? 10 : -30) : 0)
      - (c.dataset.minor === "1" ? 40 : 0);   // 通過点の山（ルートの最高地点でない）は少し後ろへ
    var line = c.querySelector(".route-now"), txt = "";
    if (!line) return;
    if (closed) { txt = closed.l; line.classList.add("is-closed"); }
    else if (hi || open) txt = (hi || open).l;
    if (!closed && known.length) {
      if (!up.length) line.classList.add("is-closed");
      txt += (txt ? (en ? " · " : "・") : "") + (en ? up.length + " of " + known.length + " huts open today" : "今日営業の小屋 " + up.length + "/" + known.length + " 軒");
    }
    if (txt) { line.textContent = txt; line.hidden = false; }
  });
  // 今の時期のおすすめ順に並べ替える（同じ点なら元の順）
  var box = items[0].parentNode;
  if (box.hasAttribute("data-sort-now")) {
    items.slice().sort(function (a, b) { return b._score - a._score || a._i - b._i; }).forEach(function (c) { box.appendChild(c); });
    [].forEach.call(box.querySelectorAll("[data-after-items]"), function (x) { box.appendChild(x); });
  }

  // ---- トップの「今の時期」: 季節ごとにルートをまとめる
  var list = document.getElementById("now-list");
  if (list) {
    var groups = {}, order = [];
    items.forEach(function (c) {
      if (!c._best || c._best.k === "open") return;
      var key = c._best.l + "|" + c._best.u;
      if (!groups[key]) { groups[key] = { s: c._best, cards: [] }; order.push(key); }
      groups[key].cards.push(c);
    });
    order.forEach(function (key) {
      var g = groups[key], li = document.createElement("li");
      li.innerHTML = '<span class="now-label">' + esc(g.s.l) + ' <small>（<a href="' + esc(g.s.u) + '" rel="noopener">' + esc(g.s.src) + "</a>）</small></span>" +
        g.cards.map(function (c) {   // 長い名前は括弧の前まで
          var nm = c.querySelector("strong").textContent.replace(/\s*[（(].*$/, "");
          return '<a href="' + esc(c.getAttribute("href")) + '">' + esc(nm) + "</a>";
        }).join(en ? ", " : "・");
      list.appendChild(li);
    });
    if (order.length) {
      var h = document.getElementById("now-h");
      h.textContent = h.dataset.fmt.replace("{m}", en ? now.toLocaleString("en", { month: "long" }) : (now.getMonth() + 1) + "月");
      document.getElementById("route-now").hidden = false;
    }
  }

  // ---- 絞り込み。山のカードは「条件に合うルートが 1 本でもあれば」残す
  var LEVEL = { easy: [1, 3], mid: [4, 5], hard: [6, 10] };
  function routeOk(r) {
    if (f.days === "0" && r.n !== 0) return false;
    if (f.days === "1" && r.n !== 1) return false;
    if (f.days === "2" && !(r.n >= 2)) return false;
    if (f.level) { var b = LEVEL[f.level]; if (!r.s || r.s < b[0] || r.s > b[1]) return false; }
    if (f.path && (!r.t || f.path.indexOf(r.t) < 0)) return false;
    if (f.public === "1" && !r.p) return false;
    return true;
  }
  function match(c) {
    var words = q && norm(q.value).length ? String(q.value).split(/\s+/).map(norm).filter(Boolean) : [];
    if (words.some(function (w) { return c._q.indexOf(w) < 0; })) return false;
    if (f.range && c.dataset.range !== f.range) return false;
    if (f.meizan && c.dataset.meizan !== f.meizan) return false;
    if (f.now === "1" && c._closed) return false;
    if ((f.days || f.level || f.path || f.public) && !c._routes.some(routeOk)) return false;
    return true;
  }
  function render() {
    if (window.HG_stopPlayer) window.HG_stopPlayer();   // 絞り込みでカードが動くので、重ねている動画を外す
    var k = 0;
    items.forEach(function (c) { var ok = match(c); c.hidden = !ok; if (ok) k++; });
    if (nOut) nOut.textContent = k ? nOut.dataset.fmt.replace("{n}", k) : nOut.dataset.none;
    var any = Object.keys(f).some(function (x) { return f[x]; }) || (q && q.value);
    if (clearBtn) clearBtn.hidden = !any;
    [].forEach.call(document.querySelectorAll("[data-f]"), function (b) { b.setAttribute("aria-pressed", String(f[b.dataset.f] === b.dataset.v)); });
    [].forEach.call(document.querySelectorAll("[data-preset]"), function (b) {
      var p = parse(b.dataset.preset, {}), keys = Object.keys(f).filter(function (x) { return f[x]; });
      b.setAttribute("aria-pressed", String(keys.length === Object.keys(p).length && keys.every(function (x) { return p[x] === f[x]; })));
    });
    renderElse();
  }

  // ---- 行き先をまたぐ検索（docs/REGIONS.md「表示と検索」）: 一覧は今の行き先（地方）だけなので、
  //      名前で探したときは、ほかの行き先で当たったルート・小屋・山を下に出す。索引 /search.json は打ち始めてから読む
  var fin = document.querySelector(".finder[data-zone]"), elseBox = document.getElementById("finder-else"), idx = null, idxLoading = false;
  function renderElse() {
    if (!fin || !elseBox) return;
    var words = q && norm(q.value).length ? String(q.value).split(/\s+/).map(norm).filter(Boolean) : [];
    if (!words.length) { elseBox.hidden = true; elseBox.innerHTML = ""; return; }
    if (!idx) {
      if (!idxLoading) {
        idxLoading = true;
        fetch(fin.dataset.index).then(function (r) { return r.json(); }).then(function (j) {
          idx = j.map(function (e) { e._q = norm(e.n + " " + e.q + " " + e.w); return e; });
          renderElse();
        }).catch(function () { idxLoading = false; });
      }
      return;
    }
    var kinds = parse(fin.dataset.kinds, {}), zone = fin.dataset.zone;
    var hits = idx.filter(function (e) { return e.z !== zone && words.every(function (w) { return e._q.indexOf(w) >= 0; }); });
    hits.sort(function (a, b) { return "thm".indexOf(a.k) - "thm".indexOf(b.k); });   // ルート → 小屋 → 山
    if (!hits.length) { elseBox.hidden = true; elseBox.innerHTML = ""; return; }
    elseBox.innerHTML = '<p class="finder-else-h">' + esc(fin.dataset.elseH) + "</p><ul>" + hits.slice(0, 8).map(function (e) {
      return '<li><a href="' + esc(e.u) + '"><span class="finder-else-k">' + esc(kinds[e.k] || "") + "</span><b>" + esc(e.n) + "</b><small>" + esc(e.w) + "</small></a></li>";
    }).join("") + "</ul>";
    elseBox.hidden = false;
  }
  if (q) q.addEventListener("input", render);
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-f]");
    if (b) { f[b.dataset.f] = f[b.dataset.f] === b.dataset.v ? "" : b.dataset.v; render(); return; }
    var p = e.target.closest("[data-preset]");
    if (p) {   // よく使う組み合わせ: 押すとその条件だけにする。もう一度押すと外す
      var on = p.getAttribute("aria-pressed") === "true";
      f = on ? {} : parse(p.dataset.preset, {});
      render(); return;
    }
    if (e.target.closest("#finder-clear")) { f = {}; if (q) q.value = ""; render(); }
  });
  render();

  // ---- カードの 3D: スクロールが止まったとき、画面の真ん中のカードにだけ山ムービー（埋め込み）を重ねて流す。
  //      iframe は 1 つを使い回し、最初に止まったときに読む。動きを減らす設定・データ節約のときは流さない（絵だけ）
  var medias = [].slice.call(document.querySelectorAll(".route-media[data-play]"));
  var list0 = document.querySelector(".route-list[data-player]");
  var noAuto = (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) || (navigator.connection && navigator.connection.saveData);
  if (!medias.length || !list0 || noAuto || !("IntersectionObserver" in window)) return;
  var fr = null, ready = false, cur = null, timer = 0, vis = new Map(), shown = "";   // shown = 今 iframe が流しているルート
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
      shown = el.dataset.play;
      document.body.appendChild(fr);
      window.addEventListener("message", function (e) {
        if (e.origin !== location.origin || !e.data || e.data.type !== "ready") return;
        ready = true;
        // 読み終える前に別のカードで止まっていたら、そのルートに替えてから見せる（前のルートを別のカードに重ねない）
        if (cur && cur.dataset.play !== shown) { var c0 = cur; cur = null; start(c0); }
        else if (cur) setTimeout(function () { if (cur) fr.classList.add("is-on"); }, 300);
      });
      put(el);
      return;
    }
    put(el); fr.classList.remove("is-on");
    if (ready) {
      if (shown !== el.dataset.play) { shown = el.dataset.play; fr.contentWindow.postMessage({ type: "route", id: shown }, location.origin); }
      else fr.contentWindow.postMessage({ type: "play" }, location.origin);
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
      if ((vis.get(m) || 0) < 0.9 || m.closest("[data-item]").hidden) return;
      var r = m.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - mid);
      if (d < bd) { bd = d; best = m; }
    });
    if (best) start(best); else stop();
  }
  window.addEventListener("scroll", function () { clearTimeout(timer); timer = setTimeout(settle, 650); }, { passive: true });
  window.addEventListener("resize", function () { if (cur) put(cur); });
  timer = setTimeout(settle, 1200);   // 開いてすぐ止まっていれば、最初に見えているカードを流す
})();
