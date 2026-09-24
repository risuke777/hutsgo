/* ルートページの「断面図 ⇄ 地図」。地図は map.js を使い、そのルートの小屋だけを出す。
   線は小屋と登山口を順に結んだ目安（登山道そのものではない旨はページに書く）。 */
(function () {
  "use strict";
  var box = document.getElementById("trail-map");
  var sw = document.querySelector(".viewswitch");
  if (!box || !sw || !window.HutsGoMap) return;

  var meta = function (n) { var m = document.querySelector('meta[name="' + n + '"]'); return m ? m.content : ""; };
  var LANG = meta("hutsgo-lang") || "ja";
  var BASE = location.pathname.replace(/\/trails\/.*$/, "");
  if (LANG === "en") BASE = BASE.replace(/\/en$/, "");
  var T = window.HUTSGO_PLAN_STRINGS || {};

  var ids = (box.dataset.huts || "").split(",").filter(Boolean);
  var line = (box.dataset.line || "").split(";").filter(Boolean).map(function (p) {
    var a = p.split(",");
    return { lat: Number(a[0]), lon: Number(a[1]) };
  });
  var api = null;

  function show(view) {
    var isMap = view === "map";
    box.hidden = !isMap;
    document.getElementById("trail-map-note").hidden = !isMap;
    var fig = document.querySelector("figure.profile");
    if (fig) fig.hidden = isMap;
    sw.querySelectorAll("[data-trailview]").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.dataset.trailview === view));
    });
    if (!isMap) return;
    if (api) { api.redraw(); return; }
    fetch(BASE + "/data/huts.json").then(function (r) { return r.json(); }).then(function (all) {
      var huts = all.filter(function (h) { return ids.indexOf(h.id) >= 0; });
      api = window.HutsGoMap.create(box, {
        huts: huts,
        lang: LANG,
        lines: line.length > 1 ? [line] : [],
        strings: T,
        nameOf: function (h) {
          var n = h.name || {};
          return LANG === "en" ? (n.en || n.ja || h.id) : (n.ja || n.en || h.id);
        },
        onPick: function (id) { location.href = BASE + (LANG === "en" ? "/en" : "") + "/huts/" + id + "/"; }
      });
    });
  }

  sw.addEventListener("click", function (e) {
    var b = e.target.closest("[data-trailview]");
    if (b) show(b.dataset.trailview);
  });
})();
