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
    var isMap = view === "map", is3d = view === "3d", box3 = document.getElementById("trail-3d");
    box.hidden = !isMap;
    if (box3) box3.hidden = !is3d;
    document.getElementById("trail-map-note").hidden = !(isMap || is3d);
    var fig = document.querySelector("figure.profile");
    if (fig) fig.hidden = isMap || is3d;
    if (is3d) { show3d(box3); }
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

  // ---- 地図（3D）: 地図の部品（MapLibre）は押したときだけ読む。航空写真と標高は国土地理院、道は地図の線と同じ
  var map3d = null, VER = "5.24.0";
  function loadLib() {
    if (window.maplibregl) return Promise.resolve();
    return new Promise(function (ok, ng) {
      var css = document.createElement("link"); css.rel = "stylesheet"; css.href = "https://cdn.jsdelivr.net/npm/maplibre-gl@" + VER + "/dist/maplibre-gl.css";
      document.head.appendChild(css);
      var sc = document.createElement("script"); sc.src = "https://cdn.jsdelivr.net/npm/maplibre-gl@" + VER + "/dist/maplibre-gl.js";
      sc.onload = ok; sc.onerror = ng; document.head.appendChild(sc);
    });
  }
  function show3d(el) {
    if (!el || map3d) { if (map3d) map3d.resize(); return; }
    map3d = "loading";
    el.innerHTML = '<p class="t3d-load">' + (LANG === "en" ? "Loading the 3D map…" : "3D の地図を読み込み中…") + "</p>";
    var pts = []; try { pts = JSON.parse(el.dataset.points || "[]"); } catch (e) { pts = []; }
    var sendView = document.querySelector('[data-trailview="3d"]');
    var api = meta("hutsgo-api");
    if (api && navigator.sendBeacon && sendView) navigator.sendBeacon(api + "/track.php", new Blob([JSON.stringify({ ev: "view_3d", lang: LANG, hut: "", trail: sendView.dataset.trail || "", page: location.pathname, ref: "" })], { type: "text/plain" }));
    loadLib().then(function () {
      el.innerHTML = '<p class="t3d-hint">' + (el.dataset.hint || "") + "</p>";
      var GSI = "https://cyberjapandata.gsi.go.jp/xyz/";
      var dem = { type: "raster-dem", tiles: [GSI + "dem_png/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 14, encoding: "custom",
                  redFactor: 655.36, greenFactor: 2.56, blueFactor: 0.01, baseShift: 0, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>' };
      var m = new maplibregl.Map({
        container: el, attributionControl: false, maxPitch: 80,
        style: { version: 8, glyphs: "https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs/{fontstack}/{range}.pbf",
          sources: { photo: { type: "raster", tiles: [GSI + "seamlessphoto/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 18 }, dem: dem,
                     hsdem: (function () { var d = Object.assign({}, dem); delete d.attribution; return d; })() },
          layers: [{ id: "photo", type: "raster", source: "photo", paint: { "raster-saturation": 0.15, "raster-contrast": 0.1 } },
                   { id: "hs", type: "hillshade", source: "hsdem", paint: { "hillshade-exaggeration": 0.25 } }],
          terrain: { source: "dem", exaggeration: 1.3 },
          sky: { "sky-color": "#9cc3e4", "horizon-color": "#e8eef2", "fog-color": "#dde6ea", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.85 } },
        center: [line[0] ? line[0].lon : 137.65, line[0] ? line[0].lat : 36.3], zoom: 12, pitch: 60
      });
      map3d = m;
      m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
      m.addControl(new maplibregl.FullscreenControl(), "top-right");
      m.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      m.on("error", function (ev) { if (window.console) console.warn("[3d]", ev && ev.error && ev.error.message); });
      m.on("load", function () {
        var coords = line.map(function (p) { return [p.lon, p.lat]; });
        m.addSource("route", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: coords } } });
        m.addLayer({ id: "route-halo", type: "line", source: "route", paint: { "line-color": "#fff", "line-width": 7, "line-opacity": 0.85 }, layout: { "line-join": "round", "line-cap": "round" } });
        m.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#E4572E", "line-width": 4 }, layout: { "line-join": "round", "line-cap": "round" } });
        m.addSource("pts", { type: "geojson", data: { type: "FeatureCollection", features: pts.map(function (p) {
          var lab = p.n + (p.k === "peak" && p.e ? "\n" + Number(p.e).toLocaleString() + "m" : "");
          return { type: "Feature", properties: { k: p.k, label: (p.k === "peak" ? "▲ " : "") + lab }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } };
        }) } });
        m.addLayer({ id: "pts", type: "circle", source: "pts", filter: ["!=", ["get", "k"], "peak"],
          paint: { "circle-radius": 6, "circle-color": ["match", ["get", "k"], "hut", "#2e6b4a", "#fff"], "circle-stroke-color": ["match", ["get", "k"], "hut", "#fff", "#16241d"], "circle-stroke-width": 2.5, "circle-pitch-alignment": "viewport" } });
        m.addLayer({ id: "pts-label", type: "symbol", source: "pts",
          layout: { "text-field": ["get", "label"], "text-font": ["NotoSansJP-Regular"], "text-size": 12, "text-padding": 2,
                  // 山頂を先に置き、重なる名前は上下左右のあいた方へ逃がす
                  "symbol-sort-key": ["match", ["get", "k"], "peak", 0, "hut", 1, 2],
                  "text-variable-anchor": ["bottom", "left", "right", "top"], "text-radial-offset": 0.9, "text-justify": "auto" },
          paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1.4 } });
        if (coords.length > 1) {
          var b = coords.reduce(function (bb, c) { return bb.extend(c); }, new maplibregl.LngLatBounds(coords[0], coords[0]));
          // 真上から全体が入る位置を出し、少し引いてから傾ける（傾けたまま合わせると奥の端が切れる）
          var cam = m.cameraForBounds(b, { padding: 40, bearing: -20 }) || {};
          var pts3 = pts.map(function (p) { return [p.lon, p.lat]; }).concat(coords);
          b = pts3.reduce(function (bb, c) { return bb.extend(c); }, b);
          cam = m.cameraForBounds(b, { padding: 36, bearing: -20 }) || cam;
          m.jumpTo({ center: cam.center, zoom: (cam.zoom || 12) - 0.2, pitch: 50, bearing: -20 });
        }
      });
    }).catch(function () {
      map3d = null;
      el.innerHTML = '<p class="t3d-load">' + (LANG === "en" ? "Could not load the 3D map." : "3D の地図を読み込めませんでした。通信を確かめてください。") + "</p>";
    });
  }

  sw.addEventListener("click", function (e) {
    var b = e.target.closest("[data-trailview]");
    if (b) show(b.dataset.trailview);
  });
})();
