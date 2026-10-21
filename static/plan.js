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
  var state = { start: "", nights: 2, people: 1, days: [] };   // days[i] = [hutId, ...] 同じ日の候補
  // 行き先（地方）。地図・稜線・名前の一覧は 1 つの地方ずつ（docs/REGIONS.md）。[{id, name, source}]
  var ZONES = window.HUTSGO_PLAN_ZONES || [{ id: "japan", name: "", source: "gsi" }];
  var zone = ZONES[0].id;
  // 予約の状況（小屋ごと）。この端末の中だけに持ち、共有のリンクには入れない（A6）
  //   { hutId: { s: "asked" | "held" | "full" | "cancel", d: "YYYY-MM-DD" } }  未連絡は持たない
  var contact = {};
  var CKEY = KEY + "-contact";

  // ---- 保存と共有 ---------------------------------------------------
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* プライベートモード等 */ }
  }
  function saveContact() {
    try { localStorage.setItem(CKEY, JSON.stringify(contact)); } catch (e) { /* 保存できなくても画面では動く */ }
  }
  function loadContact() {
    try { contact = JSON.parse(localStorage.getItem(CKEY) || "{}") || {}; } catch (e) { contact = {}; }
  }
  function zoneOf(h) { return (h && h.zone) || "japan"; }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function load() {
    var fromHash = readHash();
    if (fromHash) { state = fromHash; }
    else {
      try {
        var raw = localStorage.getItem(KEY);
        if (raw) { var s = JSON.parse(raw); if (s && s.days) state = s; }
      } catch (e) { /* 壊れていたら初期状態 */ }
    }
    if (!state.people) state.people = 1;   // people 欄より前に保存された行程との互換
  }
  function writeHash() {
    var parts = state.days.map(function (d) { return d.join(","); }).join("|");
    var h = "#p=" + encodeURIComponent(parts) + (state.start ? "&d=" + state.start : "")
          + (state.people && state.people !== 1 ? "&n=" + state.people : "");
    history.replaceState(null, "", location.pathname + h);
  }
  function readHash() {
    var m = /[#&]p=([^&]*)/.exec(location.hash);
    if (!m) return null;
    var days = decodeURIComponent(m[1]).split("|").map(function (d) {
      return d ? d.split(",").filter(Boolean) : [];
    });
    var dm = /[#&]d=([0-9-]{10})/.exec(location.hash);
    var nm = /[#&]n=([0-9]{1,2})/.exec(location.hash);
    // days の長さがそのまま泊数。ここを 1 ずらすと ensureDays が最終日を前の日に畳んでしまい、
    // 共有した行程が全部横並びになる（2026-09-23 の事故）。
    return { start: dm ? dm[1] : "", nights: Math.max(1, days.length),
             people: nm ? Math.max(1, Number(nm[1])) : 1, days: days };
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
    if (!date) return null;
    // その年の営業期間（2026・2027）。泊まる日の年の行だけを使う
    var se = h["season_" + date.slice(0, 4)];
    if (!se) return null;                              // null = 未確認。閉まっているとは言わない
    if (se.status === "year_round") return true;
    if (se.status !== "open" || !se.open_date || !se.close_date) return null;
    // 2026 年の日付は 2026 年の泊まりにだけ当てる（ほかの年に流用しない: A1）
    if (date.slice(0, 4) !== se.open_date.slice(0, 4)) return null;
    return date >= se.open_date && date <= se.close_date;
  }
  // 年の日付が無いとき、公式の「例年の営業期間」（月の単位）で目安を出す。
  // "in" = 例年は営業の月 / "edge" = 始まり・終わりの月（その月のどこからかは分からない）/ "out" = 例年は休みの月 / null = 分からない
  var PART = { early: "上旬", mid: "中旬", late: "下旬" }, PART_EN = { early: "early ", mid: "mid-", late: "late " };
  function usualLabel(u) {
    function one(m, p) {
      if (!m) return "?";
      return LANG === "en" ? (PART_EN[p] || "") + MONTH_EN[m - 1] : m + "月" + (PART[p] || "");
    }
    return one(u.from_month, u.from_part) + (LANG === "en" ? " to " : "〜") + one(u.to_month, u.to_part);
  }
  function usualOn(h, date) {
    var u = h.usual_season;
    if (!u || !date || !u.from_month || !u.to_month) return null;
    var m = Number(date.slice(5, 7));
    if (m > u.from_month && m < u.to_month) return "in";
    if (m === u.from_month || m === u.to_month) return "edge";
    return u.winter === 1 ? null : "out";               // 冬も開ける小屋は、夏の外の月を「休み」と言わない
  }
  function hutName(h) {
    var n = h.name || {};
    // 英語版で日本語名を括弧で残すのは日本の小屋だけ（現地で見せるため）。外国は現地の名前だけ
    if (LANG === "en") return n.en ? n.en + ((h.country || "JP") === "JP" && n.ja ? " (" + n.ja + ")" : "") : (n.ja || h.id);
    return n.ja || n.en || h.id;
  }
  function money(v, cur) {
    if (v == null) return null;
    if (!cur || cur === "JPY") return "¥" + Number(v).toLocaleString();
    var sym = cur === "EUR" ? "€" : cur + " ";
    return sym + (Number(v) % 1 ? Number(v).toFixed(2) : String(Number(v)));
  }
  function priceOf(h) {
    var r = (h.rates_2026 || []).filter(function (x) { return x.plan === "two_meals"; })[0];
    if (!r || !r.price) return null;
    var label = (h.country || "JP") === "JP" ? "" : t("half_board") + " ";
    return label + money(r.price, r.currency) + (r.is_from_price ? "+" : "");
  }

  // ---- 選択盤（稜線図）------------------------------------------------
  // 地図の代わりに、山域ごとに標高順で小屋を並べた図。
  // 「どれとどれが同じ高さ・同じ山域か」が読めれば選ぶには足りる。
  function drawRidge(box) {
    box.innerHTML = "";
    var byArea = {};
    Object.keys(huts).forEach(function (id) {
      var h = huts[id], a = (h.area && h.area.id) || "other";
      if (zoneOf(h) !== zone) return;                   // 今の行き先の小屋だけ
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
    if (!box.dataset.wired) {
      box.dataset.wired = "1";
      box.addEventListener("click", function (ev) {
        var b = ev.target.closest("[data-hut]");
        if (b) addHut(b.dataset.hut);
      });
    }
  }

  function hutButton(h, cls) {
    var b = el("button", cls || "plan-chip");
    b.type = "button";
    b.dataset.hut = h.id;
    b.appendChild(el("span", null, hutName(h)));
    var e = h.location && h.location.elevation_m;
    if (e) b.appendChild(el("span", "plan-chip-elev", e.toLocaleString() + "m"));
    return b;
  }

  function drawList(box, filter) {
    box.innerHTML = "";
    var q = (filter || "").trim().toLowerCase();
    var ul = el("ul", "plan-hutlist");
    var hits = Object.keys(huts).map(function (id) { return huts[id]; }).filter(function (h) {
      if (zoneOf(h) !== zone) return false;              // 今の行き先の小屋だけ
      if (!q) return true;
      var n = h.name || {};
      return ((n.ja || "") + " " + (n.en || "") + " " + h.id).toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) { return hutName(a).localeCompare(hutName(b), LANG); });
    hits.forEach(function (h) {
      var li = el("li");
      li.appendChild(hutButton(h));
      ul.appendChild(li);
    });
    if (!hits.length) ul.appendChild(el("li", "quiet", t("search_none")));
    box.appendChild(ul);
    if (!box.dataset.wired) {
      box.dataset.wired = "1";
      box.addEventListener("click", function (ev) {
        var b = ev.target.closest("[data-hut]");
        if (b) addHut(b.dataset.hut);
      });
    }
  }

  // ---- 名前で探す -------------------------------------------------------
  function setupSearch() {
    var input = $("#plan-search"), out = $("#plan-search-results");
    if (!input) return;
    // アクセント（Hütte／Hutte）と大文字小文字をそろえて比べる
    function fold(x) { return String(x || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
    function results() {
      var q = fold(input.value.trim());
      out.innerHTML = "";
      if (!q) { out.hidden = true; return; }
      // 名前で探すときは行き先をまたぐ。今の行き先の小屋を先に、ほかの行き先は名前の後ろに行き先を出す
      var hits = Object.keys(huts).map(function (id) { return huts[id]; }).filter(function (h) {
        var n = h.name || {};
        return fold((n.ja || "") + " " + (n.en || "") + " " + h.id).indexOf(q) >= 0;
      }).sort(function (a, b) { return (zoneOf(a) === zone ? 0 : 1) - (zoneOf(b) === zone ? 0 : 1); }).slice(0, 8);
      hits.forEach(function (h) {
        var b = hutButton(h, "plan-chip plan-search-hit");
        if (zoneOf(h) !== zone) b.appendChild(el("span", "plan-chip-zone", zoneName(zoneOf(h))));
        out.appendChild(b);
      });
      if (!hits.length) out.appendChild(el("p", "quiet", t("search_none")));
      out.hidden = false;
      drawList($("#plan-list"), input.value);
    }
    input.addEventListener("input", results);
    input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      var first = out.querySelector("[data-hut]");
      if (first) first.click();
    });
    out.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-hut]");
      if (!b) return;
      if (huts[b.dataset.hut] && zoneOf(huts[b.dataset.hut]) !== zone) switchZone(zoneOf(huts[b.dataset.hut]));
      addHut(b.dataset.hut);
      focusHut(b.dataset.hut);   // 押した小屋が地図のどこかを見せる
      input.value = "";
      out.hidden = true;
      drawList($("#plan-list"), "");
    });
  }

  // ---- 断面図から選ぶ ---------------------------------------------------
  function setupProfile() {
    var view = $("#plan-profile-view");
    if (!view) return;
    var sel = $("#plan-route");
    function show(id) {
      view.querySelectorAll(".plan-profile").forEach(function (f) { f.hidden = f.dataset.trail !== id; });
    }
    if (sel) sel.addEventListener("change", function () { show(sel.value); });
    view.addEventListener("click", function (ev) {
      var a = ev.target.closest("[data-hut]");
      if (!a) return;
      ev.preventDefault();          // 断面図のマーカーは小屋ページ用のリンク。ここでは行程に入れる
      addHut(a.dataset.hut);
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

  // quiet: 地図のカードから入れたとき。カードに「行程の n 泊目」と出るので、下のお知らせは出さない（カードのボタンに重なる）
  function addHut(id, quiet) {
    if (!huts[id]) return;
    ensureDays();
    // 空いている最初の日に入れる。全部埋まっていれば最終日の候補として足す
    var target = state.days.findIndex(function (d) { return d.length === 0; });
    if (target < 0) target = state.days.length - 1;
    if (state.days[target].indexOf(id) < 0) {
      state.days[target].push(id);
      if (!quiet) toast(t("added").replace("{name}", hutName(huts[id])).replace("{n}", target + 1),
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

  // 予約の状況: 未連絡 → 問い合わせ中 → 確保／満室／取り消した。変えた日も残す（この端末の中だけ）
  var STATUSES = ["none", "asked", "held", "full", "cancel"];
  function statusControl(h) {
    var wrap = el("label", "plan-status");
    wrap.appendChild(el("span", "plan-status-k", t("st_h")));
    var sel = el("select");
    var cur = contact[h.id] || null;
    STATUSES.forEach(function (k) {
      var o = el("option", null, t("st_" + k));
      o.value = k;
      if ((cur ? cur.s : "none") === k) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      if (sel.value === "none") delete contact[h.id];
      else contact[h.id] = { s: sel.value, d: todayIso() };
      saveContact();
      render();
    });
    wrap.appendChild(sel);
    if (cur && cur.d) wrap.appendChild(el("small", "plan-status-d", t("st_on").replace("{d}", cur.d.slice(5).replace("-", "/"))));
    return wrap;
  }

  // その日に開いているか。年の日付が無いときだけ、公式の「例年の営業期間」で目安を出す（日付には直さない）
  function seasonBadge(h, date) {
    var st = openOn(h, date);
    var us = st === null ? usualOn(h, date) : null;
    if (st === true) return el("span", "plan-badge is-open", t("open_on"));
    if (st === false) return el("span", "plan-badge is-closed", t("closed_on"));
    if (us === "in") return el("span", "plan-badge is-usual", t("usual_in").replace("{l}", usualLabel(h.usual_season)));
    if (us === "edge") return el("span", "plan-badge is-unknown", t("usual_edge").replace("{l}", usualLabel(h.usual_season)));
    if (us === "out") return el("span", "plan-badge is-closed", t("usual_out").replace("{l}", usualLabel(h.usual_season)));
    return el("span", "plan-badge is-unknown", t("season_unknown"));
  }

  function hutCard(h, day) {
    var card = el("div", "plan-card");
    if (contact[h.id]) card.classList.add("st-" + contact[h.id].s);
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
    card.appendChild(seasonBadge(h, date));

    var se = h.season_2026 || {};
    var res = se.reservation || {};
    var opens = res.opens_at && (LANG === "en" ? (res.opens_at.en || res.opens_at.ja) : res.opens_at.ja);
    if (opens) card.appendChild(el("p", "plan-opens", t("booking_opens") + " " + opens));
    card.appendChild(statusControl(h));

    var chs = res.channels || [];
    var avail = chs.filter(function (c) { return c.availability === 1; })[0];
    var mail = chs.filter(function (c) { return c.kind === "email"; })[0];
    var acts = el("div", "plan-card-actions");
    // 申し込む前に空きが見られるページ（公式）があれば、それをいちばん先に
    if (avail) {
      var av = el("a", "btn btn-primary", t("avail"));
      av.href = (LANG === "en" && avail.url_en) ? avail.url_en : avail.url; av.target = "_blank"; av.rel = "noopener";
      av.dataset.track = "reservation"; av.dataset.hut = h.id;
      acts.appendChild(av);
    }
    if (res.url && (!avail || avail.url !== res.url)) {
      var bu = el("a", "btn" + (avail ? "" : " btn-primary"), t("book"));
      bu.href = res.url; bu.target = "_blank"; bu.rel = "noopener";
      bu.dataset.track = "official_site"; bu.dataset.hut = h.id;
      acts.appendChild(bu);
    }
    if (res.phone) {
      var ph = el("a", "btn", res.phone);
      ph.href = "tel:" + res.phone.replace(/[-\s]/g, "");
      ph.dataset.track = "phone"; ph.dataset.hut = h.id;
      acts.appendChild(ph);
    }
    if (mail && (h.country || "JP") !== "JP") card.dataset.mail = "1";
    if ((res.phone || res.url || chs.length) && window.HutsGoContact) {
      var cbtn = el("button", "btn btn-ghost plan-contact-btn", t(card.dataset.mail ? "contact_btn_mail" : "contact_btn"));
      cbtn.type = "button";
      var panelId = "contact-" + h.id + "-" + day;
      cbtn.setAttribute("aria-expanded", "false");
      cbtn.addEventListener("click", function () {
        var panel = card.querySelector(".plan-contact");
        var open = !panel.hidden;
        panel.hidden = open;
        cbtn.setAttribute("aria-expanded", String(!open));
        if (!open && !panel.dataset.built) { panel.dataset.built = "1"; fillContactPanel(panel, h, date, day); }
      });
      acts.appendChild(cbtn);
    }
    card.appendChild(acts);
    if ((res.phone || res.url || chs.length) && window.HutsGoContact) {
      var contactPanel = el("div", "plan-contact");
      contactPanel.hidden = true;
      card.appendChild(contactPanel);
    }

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

  var MONTH_EN = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];

  // 同じ小屋に続けて泊まる泊数（この日から）。メールの「何泊」に使う
  function nightsFrom(id, day) {
    var n = 0;
    for (var i = day; i < state.days.length && state.days[i].indexOf(id) >= 0; i++) n++;
    return Math.max(1, n);
  }
  // メールの文（伊・独・英）。送るのは見ている人のメールアプリから（mailto:）。HutsGo には何も届かない（A4・A6）
  function mailComposer(panel, h, ch, dateIso, day) {
    var C = window.HutsGoContact;
    panel.appendChild(el("h4", "plan-contact-h", t("mail_h")));
    if (!dateIso) { panel.appendChild(el("p", "quiet", t("need_date"))); return; }
    var opts = { lang: "it", plan: "hb", room: "any", members: false };
    var form = el("div", "plan-mail-opts");
    function select(label, key, choices) {
      var w = el("label", "plan-field"), s = el("select");
      w.appendChild(document.createTextNode(label));
      choices.forEach(function (c) { var o = el("option", null, c[1]); o.value = c[0]; if (opts[key] === c[0]) o.selected = true; s.appendChild(o); });
      s.addEventListener("change", function () { opts[key] = s.value; update(); });
      w.appendChild(s); form.appendChild(w);
    }
    select(t("mail_lang"), "lang", [["it", "Italiano"], ["de", "Deutsch"], ["en", "English"]]);
    select(t("mail_plan"), "plan", [["hb", t("half_board")], ["bb", t("bb")], ["bo", t("bed_only")]]);
    select(t("mail_room"), "room", [["any", t("room_any")], ["dorm", t("room_dorm")], ["room", t("room_private")]]);
    var mem = el("label", "plan-check"), cb = el("input");
    cb.type = "checkbox";
    cb.addEventListener("change", function () { opts.members = cb.checked; update(); });
    mem.appendChild(cb); mem.appendChild(document.createTextNode(" " + t("mail_members")));
    form.appendChild(mem);
    panel.appendChild(form);
    var pre = el("pre", "plan-mail-body");
    panel.appendChild(pre);
    var row = el("div", "plan-card-actions");
    var send = el("a", "btn btn-primary", t("mail_open"));
    send.dataset.track = "reservation"; send.dataset.hut = h.id;
    var copy = el("button", "btn btn-ghost", t("mail_copy"));
    copy.type = "button";
    row.appendChild(send); row.appendChild(copy);
    panel.appendChild(row);
    panel.appendChild(el("p", "quiet", t("mail_note")));
    var cur = null;
    function update() {
      cur = C.bookingMail({ lang: opts.lang, start: dateIso, nights: nightsFrom(h.id, day), people: state.people || 1,
                            plan: opts.plan, room: opts.room, members: opts.members });
      pre.textContent = "Subject: " + cur.subject + "\n\n" + cur.body;
      send.href = ch.url + "?subject=" + encodeURIComponent(cur.subject) + "&body=" + encodeURIComponent(cur.body);
    }
    copy.addEventListener("click", function () {
      var txt = cur.subject + "\n\n" + cur.body;
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { toast(t("mail_copied")); }, function () { toast(t("load_failed")); });
    });
    // メールを開いたら「問い合わせ中」にする（まだ確保ではない）
    send.addEventListener("click", function () {
      if (!contact[h.id] || contact[h.id].s === "cancel") { contact[h.id] = { s: "asked", d: todayIso() }; saveContact(); setTimeout(render, 400); }
    });
    update();
  }

  // 連絡の準備パネル。開いたときに一度だけ組み立てる（押すたびに毎回作り直さない）
  function fillContactPanel(panel, h, dateIso, day) {
    var C = window.HutsGoContact;
    var world = (h.country || "JP") !== "JP";
    var se = h.season_2026 || {}, res = se.reservation || {};
    var p = dateIso ? dateIso.split("-").map(Number) : null;

    if (p) {
      panel.appendChild(el("p", "quiet plan-contact-stay",
        t("your_stay") + "：" + p[0] + "-" + String(p[1]).padStart(2, "0") + "-" + String(p[2]).padStart(2, "0")
        + "（" + (state.people || 1) + (LANG === "en" ? (state.people === 1 ? " person" : " people") : "名") + "）"));
    }

    // --- 予約の窓口（小屋が案内しているものだけ。英語で使えるかを並べて見せる） ---
    var chs = res.channels || [];
    if (chs.length) {
      panel.appendChild(el("h4", "plan-contact-h", t("ch_h")));
      var ul = el("ul", "channel-list");
      chs.forEach(function (c) {
        var li = el("li");
        var a = el("a", null, c.kind === "email" ? t("ch_email") + " " + c.url.replace(/^mailto:/, "")
                                : t(c.operator === "hut" && c.kind === "form" ? "ch_hut_form" : "ch_" + c.operator));
        a.href = (LANG === "en" && c.url_en) ? c.url_en : c.url;
        a.target = "_blank"; a.rel = "noopener";
        // 旅行会社への案内は小屋への送客ではないので、送客率の計測に混ぜない
        a.dataset.track = c.kind === "agency" ? "agency_link" : "reservation";
        a.dataset.hut = h.id;
        li.appendChild(a);
        if (c.kind !== "email") li.appendChild(el("span", "ch-en ch-en-" + c.english, t("ch_en_" + c.english + (world && c.english === "no" ? "_world" : ""))));
        if (c.availability === 1) li.appendChild(el("span", "ch-avail", t("avail_chip")));
        if (c.guide_en_url) {
          var g = el("a", "ch-guide", t("ch_guide"));
          g.href = c.guide_en_url; g.target = "_blank"; g.rel = "noopener";
          li.appendChild(g);
        }
        var note = c.note && (LANG === "en" ? (c.note.en || c.note.ja) : (c.note.ja || c.note.en));
        if (note) li.appendChild(el("small", null, note));
        if (c.kind === "agency") li.appendChild(el("small", null, t("ch_agency")));
        ul.appendChild(li);
      });
      panel.appendChild(ul);
    }

    // --- 日本の外: メールの文・前払いと取り消し・泊まり方の説明。日本語の電話の台本と予約フォームの対訳は出さない ---
    if (world) {
      var terms = se.booking_terms && (LANG === "en" ? (se.booking_terms.en || se.booking_terms.ja) : (se.booking_terms.ja || se.booking_terms.en));
      if (terms) {
        panel.appendChild(el("h4", "plan-contact-h", t("terms_h")));
        panel.appendChild(el("p", null, terms));
      }
      var mail = chs.filter(function (c) { return c.kind === "email"; })[0];
      if (mail) mailComposer(panel, h, mail, dateIso, day);
      var gl = el("p", "quiet");
      var ga = el("a", null, t("guide_link"));
      ga.href = "#rifugio-guide";
      ga.addEventListener("click", function () { var d = $("#rifugio-guide"); if (d) d.open = true; });
      gl.appendChild(ga);
      panel.appendChild(gl);
      return;
    }

    // --- 電話の台本 ---
    if (res.phone) {
      panel.appendChild(el("h4", "plan-contact-h", t("phone_h")));
      panel.appendChild(el("p", "quiet", t("phone_note")));
      var twoMeals = (h.rates_2026 || []).some(function (r) { return r.plan === "two_meals"; });
      var script = C.phoneScript({
        month: p ? p[1] : null, day: p ? p[2] : null,
        dateEn: p ? (MONTH_EN[p[1] - 1] + " " + p[2]) : null,
        people: state.people || 1, twoMeals: twoMeals
      });
      var ol = el("ol", "contact-script");
      script.forEach(function (line) {
        var li = el("li");
        li.appendChild(el("p", "contact-ja", line.ja));
        li.appendChild(el("p", "contact-gloss", line.romaji + " — " + line.en));
        ol.appendChild(li);
      });
      panel.appendChild(ol);
    }

    // --- Web予約フォームの対訳 ---
    if (res.url) {
      var det = el("details", "plan-contact-glossary");
      var sum = el("summary", null, t("web_h"));
      det.appendChild(sum);
      det.appendChild(el("p", "quiet", t("web_note")));
      var table = el("table", "rates");
      var tbody = el("tbody");
      C.formGlossary().forEach(function (pair) {
        var tr = el("tr");
        var th = el("th"); th.setAttribute("scope", "row"); th.textContent = pair[0];
        var td = el("td", null, pair[1]);
        tr.appendChild(th); tr.appendChild(td);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      det.appendChild(table);
      panel.appendChild(det);
    }

    // --- 受付開始のカレンダー登録 ---
    var rule = res.opens_rule;
    var icsWrap = el("div", "plan-contact-ics");
    if (!rule) {
      icsWrap.appendChild(el("p", "quiet", t("ics_unknown")));
    } else if (rule.rule === "months_before_stay" && !dateIso) {
      icsWrap.appendChild(el("p", "quiet", t("need_date")));
    } else {
      var opens = C.computeOpensUtc(rule, dateIso, 2026);
      if (!opens || opens.getTime() < Date.now()) {
        icsWrap.appendChild(el("p", "quiet", t("ics_past")));
      } else {
        var icsBtn = el("button", "btn btn-primary", t("ics_btn"));
        icsBtn.type = "button";
        icsBtn.addEventListener("click", function () {
          var ics = C.buildIcsForEntries([{ hut: h, stayIso: dateIso, seasonYear: 2026,
                                            hutName: hutName(h), lang: LANG }]);
          if (!ics) { toast(t("ics_unknown")); return; }
          C.downloadIcs("hutsgo-" + h.id + ".ics", ics);
          toast(t("ics_downloaded"));
        });
        icsWrap.appendChild(icsBtn);
        icsWrap.appendChild(el("p", "quiet", t("ics_note")));
      }
    }
    panel.appendChild(icsWrap);
  }

  // 行程ぜんぶの受付開始をまとめて .ics に。計算できる小屋がある泊だけ拾う
  function setupIcsAll() {
    var btn = $("#plan-ics-all");
    if (!btn || !window.HutsGoContact) return;
    btn.addEventListener("click", function () {
      var entries = [];
      state.days.forEach(function (ids, day) {
        var date = dayDate(day);
        ids.forEach(function (id) {
          var h = huts[id];
          if (h) entries.push({ hut: h, stayIso: date, seasonYear: 2026, hutName: hutName(h), lang: LANG });
        });
      });
      var ics = window.HutsGoContact.buildIcsForEntries(entries);
      if (!ics) { toast(t("ics_all_none")); return; }
      window.HutsGoContact.downloadIcs("hutsgo-plan.ics", ics);
      toast(t("ics_downloaded"));
    });
  }

  function render() {
    ensureDays();
    var box = $("#plan-days");
    box.innerHTML = "";
    var heldN = 0;
    state.days.forEach(function (ids, i) {
      var day = el("section", "plan-day");
      day.dataset.day = i;
      var date = dayDate(i);
      var h2 = el("h3", null, t("day_n").replace("{n}", i + 1) + (date ? "  " + date : ""));
      // その夜に「確保」の小屋があれば見出しに出す。満室・取り消しの候補は後ろへ回す
      var held = ids.filter(function (id) { return contact[id] && contact[id].s === "held"; })[0];
      if (held && huts[held]) { h2.appendChild(el("span", "plan-day-held", t("st_day_held").replace("{name}", hutName(huts[held])))); heldN++; }
      day.appendChild(h2);
      var row = el("div", "plan-day-row");
      if (!ids.length) row.appendChild(el("p", "plan-empty", t("drop_here")));
      var rank = function (id) { var c = contact[id]; return c && (c.s === "full" || c.s === "cancel") ? 1 : 0; };
      ids.slice().sort(function (a, b) { return rank(a) - rank(b); })
         .forEach(function (id) { if (huts[id]) row.appendChild(hutCard(huts[id], i)); });
      day.appendChild(row);
      box.appendChild(day);
    });
    var sum = $("#plan-status-sum");
    if (sum) {
      var anyStatus = chosenIds().some(function (id) { return contact[id]; });
      sum.hidden = !anyStatus;
      sum.textContent = t("st_summary").replace("{held}", heldN).replace("{n}", state.days.length);
    }
    save();
    writeHash();
    if (mapApi) mapApi.setChosen(chosenIds());
    refreshIcsAllButton();
    if (sheetId) fillSheet(sheetId);
  }

  function refreshIcsAllButton() {
    var btn = $("#plan-ics-all");
    if (!btn || !window.HutsGoContact) return;
    var entries = [];
    state.days.forEach(function (ids, day) {
      var date = dayDate(day);
      ids.forEach(function (id) { if (huts[id]) entries.push({ hut: huts[id], stayIso: date }); });
    });
    btn.hidden = !window.HutsGoContact.hasComputable(entries);
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
      b.addEventListener("click", function () { openSheet(hut.id); });
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
  var mapApi = null, currentView = function () { return "map"; };
  // 地図は 1 つの行き先ずつ（日本とイタリアを 1 枚に入れると、どちらの小屋も点にしか見えない）。
  // 地図の出どころも行き先で変わる（日本 = 地理院、日本の外 = OpenTopoMap。docs/REGIONS.md）
  function zoneName(id) { var z = ZONES.filter(function (x) { return x.id === id; })[0]; return z ? z.name : id; }
  // 地図は 3D（MapLibre）を先に使う。WebGL が無い端末・部品が読めないときは平面の地図（map.js）。?map=2d でも平面
  var mapToken = 0, pendingFocus = null;
  function makeMap() {
    if (!window.HutsGoMap && !window.HutsGoMap3D) return;
    if (mapApi && mapApi.destroy) mapApi.destroy();
    mapApi = null;
    closeSheet(true);
    // 前の地図が付けた操作の見張りを残さないよう、地図の箱を作り直す
    var old = $("#plan-map"), box = old.cloneNode(false);
    old.parentNode.replaceChild(box, old);
    var z = ZONES.filter(function (x) { return x.id === zone; })[0] || ZONES[0];
    var opts = {
      huts: Object.keys(huts).map(function (id) { return huts[id]; }).filter(function (h) { return zoneOf(h) === zone; }),
      source: z.source,
      strings: T,
      lang: LANG,
      nameOf: hutName,
      onPick: openSheet,                                  // 押した小屋は、まずカード（絵・概要）を出す。行程にはカードから入れる
      onBlank: function () { closeSheet(); },
      onMove: drawNearby
    };
    var my = ++mapToken;
    function ready(api) {
      if (my !== mapToken) { if (api.destroy) api.destroy(); return; }   // 読み込み中に行き先が変わった
      mapApi = api;
      mapApi.setChosen(chosenIds());
      drawNearby();
      if (pendingFocus) { mapApi.focus(pendingFocus[0], pendingFocus[1]); pendingFocus = null; }
    }
    function flat() { if (window.HutsGoMap) ready(window.HutsGoMap.create(box, opts)); }
    if (window.HutsGoMap3D && window.HutsGoMap3D.supported() && !/[?&]map=2d\b/.test(location.search)) {
      box.classList.add("is-loading");
      box.setAttribute("data-loading", t("map3d_loading"));
      window.HutsGoMap3D.create(box, opts).then(function (api) {
        box.classList.remove("is-loading"); ready(api);
      }, function () {
        box.classList.remove("is-loading");
        if (my === mapToken) flat();
      });
    } else flat();
  }
  // 地図ができる前に「この小屋を見せて」と頼まれたら、できてから寄る
  function focusHut(id, zoom) {
    if (mapApi) mapApi.focus(id, zoom); else pendingFocus = [id, zoom];
  }

  // ---- 地図で押した小屋のカード（絵・概要 → 行程に追加 → 予約の準備）-------------
  // 絵: 小屋の写真があればそれ、無ければ小屋のまわりの 3D の静止画（tools/hut_posters.mjs）。写真と取り違えないよう札を付ける
  var PICS = window.HUTSGO_PLAN_PICS || {};
  var sheetId = null;
  function sheetOffset() {
    var v = $("#plan-map-view"), w = v.clientWidth, hh = v.clientHeight;
    // 広い画面ではカードが左にかぶるので小屋を右へ、狭い画面では下にかぶるので上へ
    return window.matchMedia && window.matchMedia("(min-width: 900px)").matches
      ? [Math.round(Math.min(360, w * 0.4) / 2), 0] : [0, -Math.round(hh * 0.24)];
  }
  function openSheet(id) {
    var box = $("#plan-sheet");
    if (!huts[id]) return;
    if (!box) { addHut(id); return; }
    sheetId = id;
    fillSheet(id);
    box.hidden = false;
    // 狭い画面では地図が画面の下にはみ出していることがある。カードが見える所まで送る
    var r = box.getBoundingClientRect();
    if (r.bottom > window.innerHeight && box.scrollIntoView) box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (mapApi && mapApi.select) mapApi.select(id, sheetOffset());
    else if (mapApi) mapApi.focus(id);
  }
  function closeSheet(quiet) {
    var box = $("#plan-sheet");
    if (box) box.hidden = true;
    if (sheetId && !quiet && mapApi && mapApi.select) mapApi.select(null);
    sheetId = null;
  }
  function dayOf(id) {
    for (var i = 0; i < state.days.length; i++) if (state.days[i].indexOf(id) >= 0) return i;
    return -1;
  }
  function credit3d(h) {
    return (h.country || "JP") === "JP"
      ? (LANG === "en" ? "GSI Japan" : "国土地理院")
      : "EOxCloudless 2025 · Terrain Tiles (AWS) · © OpenStreetMap";
  }
  function fact(dl, k, v) {
    if (v == null || v === "") return;
    dl.appendChild(el("dt", null, k));
    var dd = el("dd");
    if (typeof v === "string") dd.textContent = v; else dd.appendChild(v);
    dl.appendChild(dd);
  }
  function fillSheet(id) {
    var box = $("#plan-sheet"), h = huts[id];
    if (!box || !h) return;
    box.innerHTML = "";
    var world = (h.country || "JP") !== "JP";
    var x = el("button", "plan-sheet-x", "×");
    x.type = "button"; x.setAttribute("aria-label", t("sh_close"));
    x.addEventListener("click", function () { closeSheet(); });
    box.appendChild(x);
    var pic = PICS[h.id];
    if (pic) {
      var fig = el("figure", "plan-sheet-pic");
      var img = el("img");
      img.src = BASE + pic.src; img.alt = pic.alt || ""; img.width = 640; img.height = 400; img.decoding = "async";
      fig.appendChild(img);
      fig.appendChild(el("figcaption", null, pic.kind === "3d" ? t("sh_pic_3d") + " · " + credit3d(h) : (pic.credit || "")));
      box.appendChild(fig);
    }
    var body = el("div", "plan-sheet-body");
    var area = h.area && h.area.name ? (LANG === "en" ? (h.area.name.en || h.area.name.ja) : (h.area.name.ja || h.area.name.en)) : "";
    var ele = h.location && h.location.elevation_m;
    body.appendChild(el("p", "plan-sheet-k", [area, ele ? Number(ele).toLocaleString() + "m" : ""].filter(Boolean).join(" · ")));
    body.appendChild(el("h3", "plan-sheet-n", hutName(h)));

    // 入れる（入っている）夜に開いているか。入れる夜は addHut と同じ決め方（空いている最初の夜、無ければ最後の夜）
    ensureDays();
    var inDay = dayOf(h.id);
    var night = inDay >= 0 ? inDay : state.days.findIndex(function (d) { return d.length === 0; });
    if (night < 0) night = state.days.length - 1;
    var date = dayDate(night);
    if (date) body.appendChild(seasonBadge(h, date));

    var dl = el("dl", "plan-sheet-facts");
    var yr = date ? date.slice(0, 4) : "2026";
    var se = h["season_" + yr];
    var season = null;
    if (se && se.status === "year_round") season = t("sh_year_round");
    else if (se && (se.open_date || se.close_date) && (se.open_date || se.close_date).slice(0, 4) === yr) {
      // 片方だけ分かっているときは、分かっている方だけ（「〜9/27」）
      var md = function (d) { if (!d) return ""; var a = d.split("-"); return Number(a[1]) + "/" + Number(a[2]); };
      season = md(se.open_date) + (LANG === "en" ? " – " : "〜") + md(se.close_date);
    } else if (h.usual_season && h.usual_season.from_month) season = t("sh_usual").replace("{l}", usualLabel(h.usual_season));
    fact(dl, t("sh_season").replace("{y}", yr), season || t("sh_none"));
    var r2 = (h.rates_2026 || []).filter(function (r) { return r.plan === "two_meals"; })[0];
    fact(dl, world ? t("half_board") : t("sh_two"), r2 && r2.price ? money(r2.price, r2.currency) + (r2.is_from_price ? "+" : "") : t("sh_none"));
    var res = (h.season_2026 || {}).reservation || {}, chs = res.channels || [];
    var ways = [];
    chs.forEach(function (c) {
      var k = c.kind === "email" ? "sh_email" : c.kind === "form" ? "sh_form" : c.kind === "web" ? "sh_web" : null;
      if (k && ways.indexOf(t(k)) < 0) ways.push(t(k));
    });
    if (res.url && !chs.length) ways.push(t("sh_web"));
    if (res.phone) ways.push(t("sh_phone"));
    var wv = el("span", null, ways.length ? ways.join(LANG === "en" ? " · " : "・") : t("sh_none"));
    if (chs.some(function (c) { return c.availability === 1; })) wv.appendChild(el("span", "ch-avail", t("sh_avail")));
    fact(dl, t("sh_ways"), wv);
    var f = h.facilities || {}, fac = [];
    [["shower", "sh_shower"], ["private_room", "sh_private"], ["credit_card", "sh_card"], ["wifi", "sh_wifi"]].forEach(function (p) { if (f[p[0]] === 1) fac.push(t(p[1])); });
    if (fac.length) fact(dl, t("sh_fac"), fac.join(LANG === "en" ? " · " : "・"));
    if (h.owner_kind) fact(dl, t("sh_owner"), t("owner_" + h.owner_kind));
    body.appendChild(dl);

    if (inDay >= 0) {
      var c = contact[h.id];
      var inP = el("p", "plan-sheet-in", t("sh_in").replace("{n}", inDay + 1) + (LANG === "en" ? " · " : "・")
        + t("st_h") + (LANG === "en" ? ": " : "：") + t("st_" + (c ? c.s : "none")) + " ");
      var rm = el("button", "linklike", t("remove"));
      rm.type = "button";
      rm.addEventListener("click", function () { removeHut(inDay, h.id); });
      inP.appendChild(rm);
      body.appendChild(inP);
    }
    var acts = el("div", "plan-sheet-acts");
    if (inDay < 0) {
      var add = el("button", "btn btn-primary", t("sh_add"));
      add.type = "button";
      add.addEventListener("click", function () { addHut(h.id, true); });
      acts.appendChild(add);
    } else {
      var go = el("button", "btn btn-primary", t("sh_book"));
      go.type = "button";
      go.addEventListener("click", function () { openBooking(h.id); });
      acts.appendChild(go);
    }
    var pg = el("a", "btn btn-ghost", t("sh_page"));
    pg.href = LB + "/huts/" + h.id + "/";
    acts.appendChild(pg);
    body.appendChild(acts);
    var pv = h.provenance || {};
    if (pv.last_verified_at) body.appendChild(el("p", "plan-sheet-src", t("sh_checked").replace("{d}", pv.last_verified_at)));
    box.appendChild(body);
  }
  // 行程のその小屋のカードへ移り、連絡の準備（窓口・メールの文・前払いの決まり）を開く
  function openBooking(id) {
    var card = document.querySelector('#plan-days .plan-card[data-hut="' + id + '"]');
    if (!card) return;
    var btn = card.querySelector(".plan-contact-btn"), panel = card.querySelector(".plan-contact");
    if (btn && panel && panel.hidden) btn.click();
    card.classList.add("is-flash");
    setTimeout(function () { card.classList.remove("is-flash"); }, 1800);
    // 上に貼り付いている日付の帯にカードの頭が隠れないよう、帯の高さだけあけて止める
    var bar = $(".plan-bar");
    card.style.scrollMarginTop = ((bar ? bar.offsetHeight : 0) + 12) + "px";
    if (card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function switchZone(id) {
    if (id === zone || !ZONES.some(function (x) { return x.id === id; })) return;
    zone = id;
    try { localStorage.setItem(KEY + "-zone", zone); } catch (e) { /* 保存できなくても動く */ }
    document.querySelectorAll("[data-plan-zone]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.planZone === zone));
    });
    drawRidge($("#plan-ridge"));
    drawList($("#plan-list"), "");
    if (currentView() === "map") makeMap();
    else if (mapApi) { mapApi.destroy && mapApi.destroy(); mapApi = null; }
  }
  // 行き先の切り替え（地図の上）。最初は、行程に入っている小屋が全部同じ行き先ならそこ、次に前に見ていた行き先
  function setupZones() {
    var cs = chosenIds().map(function (id) { return huts[id] && zoneOf(huts[id]); }).filter(Boolean);
    var saved = null;
    try { saved = localStorage.getItem(KEY + "-zone"); } catch (e) { /* 読めなくても既定で動く */ }
    if (cs.length && cs.every(function (c) { return c === cs[0]; })) zone = cs[0];
    else if (saved && ZONES.some(function (x) { return x.id === saved; })) zone = saved;
    var box = $("#plan-zones");
    if (!box || ZONES.length < 2) return;
    box.hidden = false;
    ZONES.forEach(function (z) {
      var b = el("button", "plan-zone", z.name);
      b.type = "button";
      b.dataset.planZone = z.id;
      b.setAttribute("aria-pressed", String(z.id === zone));
      b.addEventListener("click", function () { switchZone(z.id); });
      box.appendChild(b);
    });
  }
  function setupViews(data) {
    var tabs = document.querySelectorAll(".plan-tab");
    var views = {
      map: $("#plan-map-view"), profile: $("#plan-profile-view"),
      ridge: $("#plan-ridge-view"), list: $("#plan-list-view")
    };
    function show(name) {
      Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
      tabs.forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.view === name)); });
      try { localStorage.setItem(KEY + "-view", name); } catch (e) { /* 保存できなくても動く */ }
      $("#plan-nearby").hidden = name !== "map";
      if (name === "map") {
        if (!mapApi) makeMap();
        else mapApi.redraw();
      }
    }
    currentView = function () { return Object.keys(views).filter(function (k) { return !views[k].hidden; })[0]; };
    tabs.forEach(function (b) { b.addEventListener("click", function () { show(b.dataset.view); }); });
    var saved = null;
    try { saved = localStorage.getItem(KEY + "-view"); } catch (e) { /* 読めなくても既定で動く */ }
    show(views[saved] ? saved : "map");
  }

  // ---- 共有（コピー・SNS・QR）-------------------------------------------
  // 行程は URL に入っている。QR はこの端末の中で作る（外のサービスに行程を渡さない）
  function setupShare() {
    var menu = $(".plan-sharemenu");
    if (!menu) return;
    var qrBox = $("#plan-qr");

    function shareUrl() { writeHash(); return location.href; }
    function shareText() { return t("share_text"); }

    function refreshLinks() {
      var u = encodeURIComponent(shareUrl());
      var tx = encodeURIComponent(shareText());
      var set = function (id, href) { var a = $(id); if (a) a.href = href; };
      set("#plan-share-line", "https://line.me/R/msg/text/?" + tx + "%0A" + u);
      set("#plan-share-x", "https://twitter.com/intent/tweet?text=" + tx + "&url=" + u);
      set("#plan-share-fb", "https://www.facebook.com/sharer/sharer.php?u=" + u);
      set("#plan-share-mail", "mailto:?subject=" + tx + "&body=" + u);
    }
    menu.addEventListener("toggle", function () { if (menu.open) refreshLinks(); });

    $("#plan-share-copy").addEventListener("click", function () {
      var u = shareUrl();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(u).then(function () { toast(t("copied")); }, function () { toast(u); });
      } else {
        toast(u);
      }
      menu.open = false;
    });

    var nativeBtn = $("#plan-share-native");
    if (navigator.share && nativeBtn) {
      nativeBtn.hidden = false;
      nativeBtn.addEventListener("click", function () {
        navigator.share({ title: "HutsGo", text: shareText(), url: shareUrl() }).catch(function () { /* 取り消しただけ */ });
        menu.open = false;
      });
    }

    $("#plan-share-qr").addEventListener("click", function () {
      if (!qrBox.hidden) { qrBox.hidden = true; return; }
      qrBox.innerHTML = "";
      if (typeof qrcode !== "function") { toast(t("load_failed")); return; }
      try {
        var q = qrcode(0, "M");
        q.addData(shareUrl());
        q.make();
        var wrap = el("div", "plan-qr-img");
        wrap.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        qrBox.appendChild(wrap);
        qrBox.appendChild(el("p", "quiet", t("qr_note")));
        qrBox.hidden = false;
      } catch (e) {
        toast(t("load_failed"));
      }
    });
  }

  // ---- 起動 -----------------------------------------------------------
  function start(data, osm) {
    // OSM から引いた位置・標高（ODbL）は別のファイル。ここで小屋に足す（docs/REGIONS.md）
    var op = (osm && osm.huts) || {};
    data.forEach(function (h) {
      var o = op[h.id];
      if (o) {
        h.location = h.location || {};
        if (o.lat != null && h.location.lat == null) { h.location.lat = o.lat; h.location.lon = o.lon; }
        if (o.elevation_m != null && h.location.elevation_m == null) h.location.elevation_m = o.elevation_m;
      }
      huts[h.id] = h;
    });
    loadContact();
    // 小屋ページ・ルートページからの #add= / #addroute= は load/render より先に読む。
    // render() が hash を #p=... に書き換えるので、後から読むと消えている
    var addId = (/[#&]add=([a-z0-9_]+)/.exec(location.hash) || [])[1];
    var addRoute = (/[#&]addroute=([a-z0-9_]+)/.exec(location.hash) || [])[1];
    load();
    var root = $("#plan");
    root.hidden = false;
    var sd = $("#plan-start"), nn = $("#plan-nights"), pp = $("#plan-people");
    if (state.start) sd.value = state.start;
    nn.value = String(Math.max(1, state.days.length || state.nights));
    pp.value = String(state.people || 1);
    sd.addEventListener("change", function () { state.start = sd.value; render(); });
    nn.addEventListener("change", function () { state.nights = Number(nn.value); render(); });
    pp.addEventListener("change", function () {
      state.people = Math.max(1, Math.min(20, Number(pp.value) || 1));
      pp.value = String(state.people);
      render();
    });
    $("#plan-clear").addEventListener("click", function () {
      state = { start: sd.value, nights: Number(nn.value), people: Number(pp.value) || 1, days: [] };
      render();
      toast(t("cleared"));
    });
    setupIcsAll();
    setupShare();
    setupZones();
    if (addId && huts[addId]) zone = zoneOf(huts[addId]);   // 小屋ページから来たら、その小屋の行き先を開く
    document.querySelectorAll("[data-plan-zone]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.planZone === zone)); });
    drawRidge($("#plan-ridge"));
    drawList($("#plan-list"), "");
    setupSearch();
    setupProfile();
    setupViews(data);
    wireDrag($("#plan-days"));
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && sheetId) closeSheet(); });
    render();
    if (addId) {
      addHut(addId);
      focusHut(addId);   // どこの山かを地図で見せる
    }
    if (addRoute) addTrail(addRoute);
  }

  // ルートページの「このルートを行程に入れる」。泊まれる小屋を行程順に、1泊ずつ置く
  function addTrail(trailId) {
    fetch((meta("hutsgo-data") || "").replace(/huts\.json$/, "trails.json"))
      .then(function (r) { return r.json(); })
      .then(function (trails) {
        var tr = trails.filter(function (x) { return x.id === trailId; })[0];
        if (!tr) return;
        var ids = tr.stops.filter(function (st) { return st.hut_id && st.overnight_candidate; })
                          .map(function (st) { return st.hut_id; })
                          .filter(function (id) { return huts[id]; });
        if (!ids.length) return;
        // ルート上の小屋は「その日の候補」。泊数はルートの目安に合わせ、行程順に振り分ける。
        // 1軒1泊にすると、実際には通過するだけの小屋まで泊まることになってしまう
        var nights = Math.max(1, Math.min(5, tr.nights_typical || Math.min(3, ids.length)));
        var per = Math.ceil(ids.length / nights);
        state.days = [];
        for (var i = 0; i < nights; i++) state.days.push(ids.slice(i * per, (i + 1) * per));
        state.days = state.days.filter(function (d, i) { return d.length || i === 0; });
        state.nights = state.days.length;
        var nn = $("#plan-nights");
        if (nn) nn.value = String(state.days.length);
        render();
        var name = LANG === "en" ? (tr.name.en || tr.name.ja) : (tr.name.ja || tr.name.en);
        toast(t("route_added").replace("{name}", name).replace("{n}", ids.length));
        focusHut(ids[0], 12);
      })
      .catch(function () { toast(t("load_failed")); });
  }

  var url = meta("hutsgo-data");
  if (!url) return;
  var osmUrl = url.replace(/huts\.json$/, "huts-osm.json");
  Promise.all([
    fetch(url).then(function (r) { return r.json(); }),
    fetch(osmUrl).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
  ]).then(function (v) { start(v[0], v[1]); }).catch(function () {
    var m = $("#plan-msg");
    if (m) { m.textContent = t("load_failed"); m.hidden = false; }
  });
})();
