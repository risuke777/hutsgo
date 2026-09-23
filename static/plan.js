/* 行程ボード（/plan/）。小屋を選んで日ごとに並べ、同じ日の候補を横に並べる。
   - 保存はブラウザの中だけ。サーバーには送らない（ログインもしない）
   - 共有は URL の #... に行程を埋める。短く持つため id と日数だけ
   - ドラッグは補助。並べ替えはボタンでも全部できる（スマホと支援技術のため） */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var el = function (tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  var meta = function (n) { var m = document.querySelector('meta[name="' + n + '"]'); return m ? m.content : ""; };
  var LANG = meta("hutsgo-lang") || "ja";
  var BASE = (meta("hutsgo-data") || "/data/huts.json").replace(/\/data\/huts\.json$/, "");
  var LB = BASE + (LANG === "en" ? "/en" : "");
  var T = window.HUTSGO_PLAN_STRINGS || {};
  var t = function (k) { return T[k] || k; };

  var KEY = "hutsgo-plan-v1";
  var huts = {};                       // id -> hut (data/huts.json)
  var state = { start: "", nights: 2, days: [] };   // days[i] = [hutId, ...] 同じ日の候補

  // ---- 保存と共有 ---------------------------------------------------
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* プライベートモード等 */ }
  }
  function load() {
    var fromHash = readHash();
    if (fromHash) { state = fromHash; return; }
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) { var s = JSON.parse(raw); if (s && s.days) state = s; }
    } catch (e) { /* 壊れていたら初期状態 */ }
  }
  function writeHash() {
    var parts = state.days.map(function (d) { return d.join(","); }).join("|");
    var h = "#p=" + encodeURIComponent(parts) + (state.start ? "&d=" + state.start : "");
    history.replaceState(null, "", location.pathname + h);
  }
  function readHash() {
    var m = /[#&]p=([^&]*)/.exec(location.hash);
    if (!m) return null;
    var days = decodeURIComponent(m[1]).split("|").map(function (d) {
      return d ? d.split(",").filter(Boolean) : [];
    });
    var dm = /[#&]d=([0-9-]{10})/.exec(location.hash);
    // days の長さがそのまま泊数。ここを 1 ずらすと ensureDays が最終日を前の日に畳んでしまい、
    // 共有した行程が全部横並びになる（2026-09-23 の事故）。
    return { start: dm ? dm[1] : "", nights: Math.max(1, days.length), days: days };
  }

  // ---- 日付と営業判定 -------------------------------------------------
  function dayDate(i) {
    if (!state.start) return null;
    // toISOString は UTC に直すので日本時間だと1日ずれる。現地日付のまま組み立てる
    var p = state.start.split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + i);
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }
  function openOn(h, date) {
    var se = h.season_2026;
    if (!se || !date) return null;                     // null = 未確認。閉まっているとは言わない
    if (se.status === "year_round") return true;
    if (se.status !== "open" || !se.open_date || !se.close_date) return null;
    return date >= se.open_date && date <= se.close_date;
  }
  function hutName(h) {
    var n = h.name || {};
    if (LANG === "en") return n.en ? n.en + " (" + (n.ja || "") + ")" : (n.ja || h.id);
    return n.ja || n.en || h.id;
  }
  function priceOf(h) {
    var r = (h.rates_2026 || []).filter(function (x) { return x.plan === "two_meals"; })[0];
    return r && r.price ? "¥" + r.price.toLocaleString() + (r.is_from_price ? "+" : "") : null;
  }

  // ---- 選択盤（稜線図）------------------------------------------------
  // 地図の代わりに、山域ごとに標高順で小屋を並べた図。
  // 「どれとどれが同じ高さ・同じ山域か」が読めれば選ぶには足りる。
  function drawRidge(box) {
    box.innerHTML = "";
    var byArea = {};
    Object.keys(huts).forEach(function (id) {
      var h = huts[id], a = (h.area && h.area.id) || "other";
      (byArea[a] = byArea[a] || []).push(h);
    });
    Object.keys(byArea).forEach(function (a) {
      var list = byArea[a].slice().sort(function (x, y) {
        return (y.location.elevation_m || 0) - (x.location.elevation_m || 0);
      });
      var sec = el("div", "ridge-area");
      var name = list[0].area ? (LANG === "en" ? (list[0].area.name.en || list[0].area.name.ja)
                                               : list[0].area.name.ja) : a;
      sec.appendChild(el("h3", null, name));
      var row = el("div", "ridge-row");
      list.forEach(function (h) {
        var b = el("button", "ridge-hut");
        b.type = "button";
        b.dataset.hut = h.id;
        b.appendChild(el("span", "ridge-name", hutName(h)));
        var e = h.location.elevation_m;
        b.appendChild(el("span", "ridge-elev", e ? e.toLocaleString() + "m" : t("elev_unknown")));
        b.title = t("add_to_plan");
        row.appendChild(b);
      });
      sec.appendChild(row);
      box.appendChild(sec);
    });
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-hut]");
      if (b) addHut(b.dataset.hut);
    });
  }

  function drawList(box) {
    box.innerHTML = "";
    var ul = el("ul", "plan-hutlist");
    Object.keys(huts).sort().forEach(function (id) {
      var h = huts[id];
      var li = el("li");
      var b = el("button", "btn btn-ghost", t("add") + " " + hutName(h));
      b.type = "button";
      b.dataset.hut = id;
      li.appendChild(b);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-hut]");
      if (b) addHut(b.dataset.hut);
    });
  }

  // ---- 行程ボード -----------------------------------------------------
  function ensureDays() {
    var want = Math.max(1, Number(state.nights) || 1);
    while (state.days.length < want) state.days.push([]);
    while (state.days.length > want) {
      var tail = state.days.pop();
      if (tail.length && state.days.length) state.days[state.days.length - 1] = state.days[state.days.length - 1].concat(tail);
    }
  }

  var toastTimer = null;
  function toast(text, undo) {
    var box = $("#plan-msg");
    box.innerHTML = "";
    box.appendChild(document.createTextNode(text));
    if (undo) {
      var b = el("button", "linklike", t("undo"));
      b.type = "button";
      b.addEventListener("click", function () { undo(); box.hidden = true; });
      box.appendChild(b);
    }
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.hidden = true; }, 6000);
  }

  function addHut(id) {
    if (!huts[id]) return;
    ensureDays();
    // 空いている最初の日に入れる。全部埋まっていれば最終日の候補として足す
    var target = state.days.findIndex(function (d) { return d.length === 0; });
    if (target < 0) target = state.days.length - 1;
    if (state.days[target].indexOf(id) < 0) {
      state.days[target].push(id);
      toast(t("added").replace("{name}", hutName(huts[id])).replace("{n}", target + 1),
            function () { removeHut(target, id); });
    } else {
      toast(t("already_in").replace("{name}", hutName(huts[id])));
    }
    render();
  }
  function removeHut(day, id) {
    state.days[day] = state.days[day].filter(function (x) { return x !== id; });
    render();
  }
  function moveHut(day, id, delta) {
    var to = day + delta;
    if (to < 0 || to >= state.days.length) return;
    state.days[day] = state.days[day].filter(function (x) { return x !== id; });
    if (state.days[to].indexOf(id) < 0) state.days[to].push(id);
    render();
  }
  function shiftWithin(day, id, delta) {
    var arr = state.days[day], i = arr.indexOf(id), j = i + delta;
    if (i < 0 || j < 0 || j >= arr.length) return;
    arr.splice(j, 0, arr.splice(i, 1)[0]);
    render();
  }

  function hutCard(h, day) {
    var card = el("div", "plan-card");
    card.draggable = true;
    card.dataset.hut = h.id;
    card.dataset.day = day;

    var head = el("div", "plan-card-head");
    var a = el("a", null, hutName(h));
    a.href = LB + "/huts/" + h.id + "/";
    head.appendChild(a);
    var p = priceOf(h);
    if (p) head.appendChild(el("span", "quiet", p));
    card.appendChild(head);

    var date = dayDate(day);
    var st = openOn(h, date);
    var badge = el("span", "plan-badge " + (st === true ? "is-open" : st === false ? "is-closed" : "is-unknown"),
                   st === true ? t("open_on") : st === false ? t("closed_on") : t("season_unknown"));
    card.appendChild(badge);

    var se = h.season_2026 || {};
    var res = se.reservation || {};
    var opens = res.opens_at && (LANG === "en" ? (res.opens_at.en || res.opens_at.ja) : res.opens_at.ja);
    if (opens) card.appendChild(el("p", "plan-opens", t("booking_opens") + " " + opens));

    var acts = el("div", "plan-card-actions");
    if (res.url) {
      var bu = el("a", "btn btn-primary", t("book"));
      bu.href = res.url; bu.target = "_blank"; bu.rel = "noopener";
      bu.dataset.track = "official_site"; bu.dataset.hut = h.id;
      acts.appendChild(bu);
    }
    if (res.phone) {
      var ph = el("a", "btn", res.phone);
      ph.href = "tel:" + res.phone.replace(/-/g, "");
      ph.dataset.track = "phone"; ph.dataset.hut = h.id;
      acts.appendChild(ph);
    }
    card.appendChild(acts);

    var nav = el("div", "plan-move");
    [["↑", function () { moveHut(day, h.id, -1); }, t("move_prev_day")],
     ["↓", function () { moveHut(day, h.id, 1); }, t("move_next_day")],
     ["←", function () { shiftWithin(day, h.id, -1); }, t("move_left")],
     ["→", function () { shiftWithin(day, h.id, 1); }, t("move_right")],
     ["×", function () { removeHut(day, h.id); }, t("remove")]].forEach(function (spec) {
      var b = el("button", "plan-move-btn", spec[0]);
      b.type = "button";
      b.title = spec[2];
      b.setAttribute("aria-label", spec[2] + "：" + hutName(h));
      b.addEventListener("click", spec[1]);
      nav.appendChild(b);
    });
    card.appendChild(nav);
    return card;
  }

  function render() {
    ensureDays();
    var box = $("#plan-days");
    box.innerHTML = "";
    state.days.forEach(function (ids, i) {
      var day = el("section", "plan-day");
      day.dataset.day = i;
      var date = dayDate(i);
      var h2 = el("h3", null, t("day_n").replace("{n}", i + 1) + (date ? "  " + date : ""));
      day.appendChild(h2);
      var row = el("div", "plan-day-row");
      if (!ids.length) row.appendChild(el("p", "plan-empty", t("drop_here")));
      ids.forEach(function (id) { if (huts[id]) row.appendChild(hutCard(huts[id], i)); });
      day.appendChild(row);
      box.appendChild(day);
    });
    save();
    writeHash();
    if (mapApi) mapApi.setChosen(chosenIds());
  }

  function chosenIds() {
    return state.days.reduce(function (acc, d) { return acc.concat(d); }, []);
  }

  // 地図を動かすたび、いま見えている小屋を押せる形で下に出す（YAMAP の「この範囲の山」に相当）
  function drawNearby() {
    if (!mapApi) return;
    var box = $("#plan-nearby-row"), wrap = $("#plan-nearby");
    var list = mapApi.visibleHuts();
    wrap.hidden = !list.length;
    box.innerHTML = "";
    var chosen = chosenIds();
    list.slice(0, 12).forEach(function (hut) {
      var b = el("button", "plan-chip" + (chosen.indexOf(hut.id) >= 0 ? " is-chosen" : ""));
      b.type = "button";
      b.dataset.hut = hut.id;
      b.appendChild(el("span", null, hutName(hut)));
      var e = hut.location.elevation_m;
      if (e) b.appendChild(el("span", "plan-chip-elev", e.toLocaleString() + "m"));
      b.addEventListener("click", function () { addHut(hut.id); });
      box.appendChild(b);
    });
  }

  // ---- ドラッグ（補助。ボタンで同じことができる）-------------------------
  function wireDrag(box) {
    var dragging = null;
    box.addEventListener("dragstart", function (e) {
      var c = e.target.closest(".plan-card");
      if (!c) return;
      dragging = { id: c.dataset.hut, from: Number(c.dataset.day) };
      c.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", c.dataset.hut); } catch (err) { /* 古いブラウザ */ }
    });
    box.addEventListener("dragend", function (e) {
      var c = e.target.closest(".plan-card");
      if (c) c.classList.remove("is-dragging");
      dragging = null;
    });
    box.addEventListener("dragover", function (e) {
      if (dragging && e.target.closest(".plan-day")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
    });
    box.addEventListener("drop", function (e) {
      var d = e.target.closest(".plan-day");
      if (!dragging || !d) return;
      e.preventDefault();
      var to = Number(d.dataset.day);
      if (to !== dragging.from) moveHut(dragging.from, dragging.id, to - dragging.from);
      dragging = null;
    });
  }

  // ---- 選択の見せ方（地図 / 稜線 / 一覧）--------------------------------
  // 人は「行きたい山の周り」から選ぶので、既定は地図。
  // 山域をまたぐロング縦走では縮小すれば全部入る。地図が重い端末のために他の2つも残す。
  var mapApi = null;
  function setupViews(data) {
    var tabs = document.querySelectorAll(".plan-tab");
    var views = {
      map: $("#plan-map-view"), ridge: $("#plan-ridge-view"), list: $("#plan-list-view")
    };
    function show(name) {
      Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
      tabs.forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.view === name)); });
      try { localStorage.setItem(KEY + "-view", name); } catch (e) { /* 保存できなくても動く */ }
      $("#plan-nearby").hidden = name !== "map";
      if (name === "map") {
        if (!mapApi && window.HutsGoMap) {
          mapApi = window.HutsGoMap.create($("#plan-map"), {
            huts: data,
            source: "gsi",
            strings: T,
            nameOf: hutName,
            onPick: addHut,
            onMove: drawNearby
          });
          mapApi.setChosen(chosenIds());
        } else if (mapApi) {
          mapApi.redraw();
        }
      }
    }
    tabs.forEach(function (b) { b.addEventListener("click", function () { show(b.dataset.view); }); });
    var saved = null;
    try { saved = localStorage.getItem(KEY + "-view"); } catch (e) { /* 読めなくても既定で動く */ }
    show(views[saved] ? saved : "map");
  }

  // ---- 起動 -----------------------------------------------------------
  function start(data) {
    data.forEach(function (h) { huts[h.id] = h; });
    // 小屋ページからの #add= は load/render より先に読む。
    // render() が hash を #p=... に書き換えるので、後から読むと消えている
    var addId = (/[#&]add=([a-z0-9_]+)/.exec(location.hash) || [])[1];
    load();
    var root = $("#plan");
    root.hidden = false;
    var sd = $("#plan-start"), nn = $("#plan-nights");
    if (state.start) sd.value = state.start;
    nn.value = String(Math.max(1, state.days.length || state.nights));
    sd.addEventListener("change", function () { state.start = sd.value; render(); });
    nn.addEventListener("change", function () { state.nights = Number(nn.value); render(); });
    $("#plan-clear").addEventListener("click", function () {
      state = { start: sd.value, nights: Number(nn.value), days: [] };
      render();
      toast(t("cleared"));
    });
    $("#plan-share").addEventListener("click", function () {
      writeHash();
      var url = location.href;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () { toast(t("copied")); },
                                                function () { toast(url); });
      } else {
        toast(url);
      }
    });
    drawRidge($("#plan-ridge"));
    drawList($("#plan-list"));
    setupViews(data);
    wireDrag($("#plan-days"));
    render();
    if (addId) {
      addHut(addId);
      if (mapApi) mapApi.focus(addId);   // どこの山かを地図で見せる
    }
  }

  var url = meta("hutsgo-data");
  if (!url) return;
  fetch(url).then(function (r) { return r.json(); }).then(start).catch(function () {
    var m = $("#plan-msg");
    if (m) { m.textContent = t("load_failed"); m.hidden = false; }
  });
})();
