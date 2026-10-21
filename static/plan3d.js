/* 行程ボードの地図（3D）。小屋の名前を地形の上に出し、指でなめらかに動かす（MapLibre GL JS）。
   - 写真と標高: 日本は国土地理院、日本の外は EOxCloudless 2025（非商用）と Terrain Tiles（AWS）。ルートページの 3D と同じ
   - 部品（MapLibre）は地図を開いたときだけ読む。WebGL が無い・読めないときは map.js（平面）に戻す（plan.js）
   - 使う側: HutsGoMap3D.create(box, {huts, source, nameOf, onPick, onBlank, onMove, lang}) → Promise<{fit, redraw, destroy, focus, select, setChosen, visibleHuts}>
     map.js と同じ形にそろえて、plan.js からはどちらでも同じに扱えるようにする */
(function () {
  "use strict";
  var VER = "5.24.0";
  var GSI = "https://cyberjapandata.gsi.go.jp/xyz/";

  function supported() {
    try {
      var c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
    } catch (e) { return false; }
  }
  var libP = null;
  function load() {
    if (window.maplibregl) return Promise.resolve();
    return libP || (libP = new Promise(function (ok, ng) {
      var css = document.createElement("link"); css.rel = "stylesheet"; css.href = "https://cdn.jsdelivr.net/npm/maplibre-gl@" + VER + "/dist/maplibre-gl.css";
      document.head.appendChild(css);
      var sc = document.createElement("script"); sc.src = "https://cdn.jsdelivr.net/npm/maplibre-gl@" + VER + "/dist/maplibre-gl.js";
      sc.onload = ok; sc.onerror = function () { libP = null; ng(); };
      document.head.appendChild(sc);
    }));
  }

  // 地理院の標高 PNG の「データ無し」（湖・海など。RGB = 128,0,0）は、そのまま読むと +83,886m の突起になって空に縦の縞が立つ。
  // 同じ行のいちばん近い左右の値のうち低い方（だいたい岸の高さ）で埋めてから渡す。gsidem://〜 で使う
  function gsiDemProtocol() {
    if (!window.maplibregl || maplibregl.__hgGsiDem) return;
    maplibregl.__hgGsiDem = true;
    maplibregl.addProtocol("gsidem", function (params, abort) {
      var url = params.url.replace(/^gsidem:\/\//, "https://");
      return fetch(url, { signal: abort && abort.signal }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        if (!window.OffscreenCanvas || !window.createImageBitmap) return { data: buf };
        return createImageBitmap(new Blob([buf], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" }).then(function (bm) {
          var w = bm.width, h = bm.height, c = new OffscreenCanvas(w, h), g = c.getContext("2d", { willReadFrequently: true });
          g.drawImage(bm, 0, 0);
          var im = g.getImageData(0, 0, w, h), d = im.data, hole = false;
          for (var i = 0; i < d.length; i += 4) if (d[i] === 128 && d[i + 1] === 0 && d[i + 2] === 0) { hole = true; break; }
          if (!hole) return { data: buf };
          for (var y = 0; y < h; y++) {
            var row = y * w * 4, left = new Array(w), last = null, x, k;
            for (x = 0; x < w; x++) { k = row + x * 4; if (!(d[k] === 128 && d[k + 1] === 0 && d[k + 2] === 0)) last = k; left[x] = last; }
            var right = null;
            for (x = w - 1; x >= 0; x--) {
              k = row + x * 4;
              if (!(d[k] === 128 && d[k + 1] === 0 && d[k + 2] === 0)) { right = k; continue; }
              var a = left[x], b = right, src = a == null ? b : b == null ? a : (val(d, a) <= val(d, b) ? a : b);
              if (src == null) { d[k] = 0; d[k + 1] = 0; d[k + 2] = 0; }      // 行ぜんぶが無し（海）: 0m
              else { d[k] = d[src]; d[k + 1] = d[src + 1]; d[k + 2] = d[src + 2]; }
            }
          }
          g.putImageData(im, 0, 0);
          return c.convertToBlob({ type: "image/png" }).then(function (b) { return b.arrayBuffer(); }).then(function (out) { return { data: out }; });
        });
      });
    });
  }
  // 地理院の標高 PNG の値（m）。2^23 以上は負の値
  function val(d, k) { var v = d[k] * 65536 + d[k + 1] * 256 + d[k + 2]; return (v >= 8388608 ? v - 16777216 : v) * 0.01; }

  function style(world) {
    // 標高は z12 まで（約 30m 格子）。それより細かい段を使うと、動かすたびに地形の細かさが切り替わって山がちらつく（flyover.js で確かめた）
    var dem = world
      ? { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 12, encoding: "terrarium",
          attribution: 'Terrain Tiles (AWS Open Data) · Huts © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }
      : { type: "raster-dem", tiles: ["gsidem://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 12, encoding: "custom",
          redFactor: 655.36, greenFactor: 2.56, blueFactor: 0.01, baseShift: 0,
          attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>' };
    var photo = world
      ? { type: "raster", tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg"], tileSize: 256, maxzoom: 15,
          attribution: '<a href="https://s2maps.eu" target="_blank" rel="noopener">EOxCloudless 2025</a> (Contains modified Copernicus Sentinel data 2025)' }
      : { type: "raster", tiles: [GSI + "seamlessphoto/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 18 };
    var hs = Object.assign({}, dem); delete hs.attribution;
    return {
      version: 8,
      glyphs: "https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs/{fontstack}/{range}.pbf",
      sources: { photo: photo, dem: dem, hsdem: hs },
      layers: [{ id: "photo", type: "raster", source: "photo", paint: { "raster-saturation": 0.15, "raster-contrast": 0.1 } },
               { id: "hs", type: "hillshade", source: "hsdem", paint: { "hillshade-exaggeration": 0.25 } }],
      terrain: { source: "dem", exaggeration: 1.3 },
      sky: { "sky-color": "#9cc3e4", "horizon-color": "#e8eef2", "fog-color": "#dde6ea", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.85 }
    };
  }

  function create(box, opts) {
    var huts = (opts.huts || []).filter(function (h) { return h.location && h.location.lat != null && h.location.lon != null; });
    var byId = {}; huts.forEach(function (h) { byId[h.id] = h; });
    var nameOf = opts.nameOf || function (h) { return h.id; };
    var en = opts.lang === "en";
    var chosen = {}, sel = null;
    // 地図の上は短く（「ロカテッリ小屋（ドライツィンネン小屋）」→「ロカテッリ小屋」、「Rifugio Locatelli / Dreizinnenhütte」→「Rifugio Locatelli」）。カードは正式な名前
    function short(n) { return String(n).replace(/\s*[（(].*$/, "").replace(/\s+\/\s+.*$/, "") || n; }
    return load().then(function () {
      gsiDemProtocol();
      box.classList.add("plan-map3d");
      var m = new maplibregl.Map({
        container: box, style: style(opts.source === "topo"), attributionControl: false,
        maxPitch: 75, minZoom: 4.5, pixelRatio: Math.min(window.devicePixelRatio || 1, 2), fadeDuration: 150,
        center: [137.6, 36.3], zoom: 7, pitch: 45
      });
      box.hgMap = m;   // 確認用（ヘッドレスの試験から触る）
      m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
      // 家のボタン: 回しすぎて迷ったら、行き先の小屋が全部入る向きに戻る
      m.addControl({
        onAdd: function () {
          var d = document.createElement("div"); d.className = "maplibregl-ctrl maplibregl-ctrl-group";
          var b = document.createElement("button"); b.type = "button"; b.className = "t3d-home";
          var lab = en ? "Show all huts" : "小屋の全体に戻る";
          b.title = lab; b.setAttribute("aria-label", lab);
          b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5M5.5 9.8V20h4.8v-5.5h3.4V20h4.8V9.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
          b.addEventListener("click", function () { fit(true); });
          d.appendChild(b); return d;
        },
        onRemove: function () {}
      }, "top-right");
      m.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      m.on("error", function (ev) { var s = ev && ev.error && ev.error.message || ""; if (!/40[034]/.test(s) && window.console) console.warn("[plan3d]", s); });

      function data() {
        return { type: "FeatureCollection", features: huts.map(function (h, i) {
          var e = h.location.elevation_m;
          return { type: "Feature", id: i, geometry: { type: "Point", coordinates: [h.location.lon, h.location.lat] },
                   properties: { id: h.id, label: short(nameOf(h)) + (e ? "\n" + Number(e).toLocaleString() + "m" : ""),
                                 c: chosen[h.id] ? 1 : 0, s: sel === h.id ? 1 : 0 } };
        }) };
      }
      function refresh() { var s = m.getSource("huts"); if (s) s.setData(data()); }
      // 小屋の点と名前は、地図の設定が読めた時点で載せる（写真・標高のタイルを待たない）
      var drawn = false;
      function overlays() {
        if (drawn) return; drawn = true;
        m.addSource("huts", { type: "geojson", data: data() });
        m.addLayer({ id: "huts", type: "circle", source: "huts",
          paint: { "circle-radius": ["case", ["==", ["get", "s"], 1], 9, ["==", ["get", "c"], 1], 7.5, 6],
                   "circle-color": ["case", ["==", ["get", "c"], 1], "#E4572E", "#2e6b4a"],
                   "circle-stroke-color": "#fff", "circle-stroke-width": ["case", ["==", ["get", "s"], 1], 3.5, 2.5],
                   "circle-pitch-alignment": "viewport" } });
        // 名前: 選んだ小屋 → 行程の小屋 → ほかの順に場所を取る。重なる名前は上下左右のあいた方へ逃がし、入らなければ隠す
        m.addLayer({ id: "huts-label", type: "symbol", source: "huts",
          layout: { "text-field": ["get", "label"], "text-font": ["NotoSansJP-Regular"],
                    "text-size": ["case", ["==", ["get", "s"], 1], 14, 12], "text-padding": 3, "text-line-height": 1.15,
                    "symbol-sort-key": ["case", ["==", ["get", "s"], 1], 0, ["==", ["get", "c"], 1], 1, 2],
                    "text-variable-anchor": ["bottom", "left", "right", "top"], "text-radial-offset": 0.95, "text-justify": "auto" },
          paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.78)", "text-halo-width": 1.5 } });
        m.on("mousemove", function (e) { m.getCanvas().style.cursor = hit(e.point) ? "pointer" : ""; });
      }
      if (m.isStyleLoaded()) overlays(); else m.once("style.load", overlays);

      // 指の近くにある小屋のうち、いちばん近いもの（名前の札を押しても拾う）
      function hit(pt) {
        if (!m.getLayer("huts")) return null;
        var fs = m.queryRenderedFeatures([[pt.x - 20, pt.y - 20], [pt.x + 20, pt.y + 20]], { layers: ["huts", "huts-label"] });
        var best = null, bd = 1e9;
        fs.forEach(function (f) {
          var h = byId[f.properties.id]; if (!h) return;
          var s = m.project([h.location.lon, h.location.lat]), d = Math.hypot(s.x - pt.x, s.y - pt.y);
          if (d < bd) { bd = d; best = h; }
        });
        return best;
      }
      m.on("click", function (e) {
        var h = hit(e.point);
        if (h) { if (opts.onPick) opts.onPick(h.id); }
        else if (opts.onBlank) opts.onBlank();
      });
      var moveT = 0;
      m.on("moveend", function () { clearTimeout(moveT); moveT = setTimeout(function () { if (opts.onMove) opts.onMove(); }, 120); });

      function fit(animate) {
        if (!huts.length) return;
        var ids = Object.keys(chosen).filter(function (id) { return byId[id]; });
        var list = ids.length ? ids.map(function (id) { return byId[id]; }) : huts;
        var b = list.reduce(function (bb, h) { return bb.extend([h.location.lon, h.location.lat]); },
                            new maplibregl.LngLatBounds([list[0].location.lon, list[0].location.lat], [list[0].location.lon, list[0].location.lat]));
        // 真上から全体が入る位置を出し、少し引いてから傾ける（傾けたまま合わせると奥の端が切れる）
        var cam = m.cameraForBounds(b, { padding: 50, maxZoom: 13 }) || {};
        var to = { center: cam.center, zoom: Math.max(5, (cam.zoom || 8) - 0.3), pitch: 45, bearing: 0 };
        if (animate) m.flyTo(Object.assign({ duration: 1100, essential: true }, to)); else m.jumpTo(to);
      }
      // 小屋へ少し寄る。カードが下（狭い画面）か左（広い画面）にかぶるので、小屋はあいている側に置く
      function focus(id, zoom, offset) {
        var h = byId[id]; if (!h) return;
        var z = zoom || Math.min(14, Math.max(m.getZoom() + 1.3, 12.5));
        m.flyTo({ center: [h.location.lon, h.location.lat], zoom: z, pitch: Math.max(m.getPitch(), 58),
                  offset: offset || [0, 0], duration: 1000, essential: true });
      }
      fit(false);
      return {
        fit: function () { fit(true); },
        redraw: function () { m.resize(); },
        destroy: function () { m.remove(); box.classList.remove("plan-map3d"); },
        focus: function (id, zoom) { focus(id, zoom); },
        // 押した小屋: 印を大きくして、少し寄る
        select: function (id, offset) {
          sel = id; refresh();
          if (id) focus(id, null, offset);
        },
        setChosen: function (ids) {
          chosen = {};
          (ids || []).forEach(function (id) { chosen[id] = true; });
          refresh();
        },
        // いま画面に入っている小屋（真ん中に近い順）。地平線の向こうの遠い小屋は入れない
        visibleHuts: function () {
          var c = m.getCanvas(), w = c.clientWidth, hh = c.clientHeight, mid = { x: w / 2, y: hh * 0.6 };
          return huts.map(function (h) {
            var s = m.project([h.location.lon, h.location.lat]);
            return { h: h, s: s, d: Math.hypot(s.x - mid.x, s.y - mid.y) };
          }).filter(function (o) { return o.s.x >= 0 && o.s.x <= w && o.s.y >= hh * 0.12 && o.s.y <= hh; })
            .sort(function (a, b) { return a.d - b.d; })
            .map(function (o) { return o.h; });
        }
      };
    });
  }

  window.HutsGoMap3D = { supported: supported, load: load, create: create, gsiDem: gsiDemProtocol };
})();
