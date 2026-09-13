(function () {
  "use strict";

  // ---- outbound click tracking (the KPI). Works with Plausible or GA4 if present.
  function track(name, props) {
    if (window.plausible) window.plausible(name, { props: props });
    if (window.gtag) window.gtag("event", name, props);
    if (window.umami) window.umami.track(name, props);
    if (!window.plausible && !window.gtag && !window.umami) console.debug("[track]", name, props);
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("[data-track]");
    if (!a) return;
    track("outbound_" + a.dataset.track, { hut: a.dataset.hut, page: location.pathname });
  });

  // ---- profile marker <-> timeline card sync (anchors work without it)
  function syncMarker() {
    var id = location.hash.slice(1);
    Array.prototype.forEach.call(document.querySelectorAll(".pm.is-current"), function (a) { a.classList.remove("is-current"); });
    if (!id) return;
    var m = document.querySelector('.pm[href="#' + id + '"]');
    if (m) m.classList.add("is-current");
  }
  window.addEventListener("hashchange", syncMarker);
  syncMarker();

  // ---- season status for a chosen date
  function status(el, date) {
    var s = el.dataset.status;
    if (!s) return null;
    if (s === "year_round") return "open";
    if (s === "closed_this_year") return "off";
    if (s === "open" && el.dataset.open && el.dataset.close)
      return date >= el.dataset.open && date <= el.dataset.close ? "open" : "closed";
    return null;
  }
  var LABEL = { open: "この日は営業中", closed: "この日は営業期間外", off: "今年は休業" };
  function paint(date) {
    Array.prototype.forEach.call(document.querySelectorAll("[data-plan-date] [data-status]"), function (el) {
      var st = status(el, date);
      var badge = el.querySelector("[data-season-badge]");
      if (!badge) return;
      badge.className = "season-badge" + (st ? " season-" + st : "");
      badge.textContent = st ? LABEL[st] : "";
    });
  }
  var dateInput = document.getElementById("plan-date");
  if (dateInput) {
    paint(dateInput.value);
    dateInput.addEventListener("change", function () { paint(dateInput.value); track("change_date", {}); });
  }

  // ---- filter page
  var dataEl = document.getElementById("hut-data");
  if (!dataEl) return;
  var huts = JSON.parse(dataEl.textContent);
  var base = dataEl.dataset.base || "";
  var form = document.getElementById("filter");
  var results = document.getElementById("results");
  var count = document.getElementById("count");
  var priceOut = document.getElementById("price-out");
  var yen = function (n) { return "¥" + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); };
  var m = /[?&]area=([a-z_]+)/.exec(location.search);
  if (m) {
    Array.prototype.forEach.call(form.querySelectorAll("[name=area]"), function (c) { c.checked = c.value === m[1]; });
  }

  function openOn(h, date) {
    if (h.status === "year_round") return true;
    if (h.status === "open" && h.open && h.close) return date >= h.open && date <= h.close;
    return false;
  }

  function val(name) { var el = form.querySelector("[name=" + name + "]"); return el ? el.value : ""; }
  function checked(name) {
    var out = [];
    Array.prototype.forEach.call(form.querySelectorAll("[name=" + name + "]:checked"), function (c) { out.push(c.value); });
    return out;
  }
  function render() {
    var date = val("date");
    var plan = val("plan");
    var max = Number(val("price"));
    var areas = checked("area");
    var tents = checked("tents").length > 0;
    priceOut.textContent = max >= 20000 ? "指定なし" : yen(max);

    var list = huts.filter(function (h) {
      if (areas.indexOf(h.area_id) < 0) return false;
      if (date && !openOn(h, date)) return false;
      var p = h[plan];
      if (plan === "tent" && p == null) return false;
      if (p != null && max < 20000 && p > max) return false;
      if (tents && !h.tents) return false;
      return true;
    }).sort(function (a, b) { return (a[plan] || 1e9) - (b[plan] || 1e9); });

    count.textContent = list.length ? list.length + "軒が条件に合います" : "";
    results.innerHTML = list.length ? list.map(function (h) {
      var p = h[plan];
      var planName = { two: "1泊2食", none: "素泊まり", tent: "テント" }[plan];
      var period = h.open ? h.open.slice(5).replace("-", "/") + "〜" + h.close.slice(5).replace("-", "/") : (h.status === "year_round" ? "通年" : "");
      var meta = [h.area, h.elev ? yen(h.elev).slice(1) + "m" : "標高未確認", h.tents ? "テント約" + h.tents + "張" : "", period].filter(Boolean);
      return '<li><a class="hut-item" href="' + base + '/huts/' + h.id + '/">'
        + '<span class="main"><span class="name">' + h.name + '<span class="dot dot-' + h.conf + '"></span></span>'
        + '<span class="meta">' + meta.join("　") + '</span></span>'
        + '<span class="price">' + (p != null ? yen(p) : "未確認") + '<small>' + planName + '</small></span>'
        + '</a></li>';
    }).join("") : '<li class="empty">この条件に合う小屋はありません。日付か上限を変えてみてください。</li>';
  }
  form.addEventListener("input", render);
  form.addEventListener("change", render);
  render();
})();
