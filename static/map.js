/* 小さなタイル地図。ライブラリは使わない（この用途に必要なのは表示と選択だけ）。
   - 出典: 地理院タイル（日本）/ OpenTopoMap（それ以外）。等高線が見える標準地図を既定にする
   - 操作: ドラッグで移動、＋−ボタンとホイールで拡大縮小。ピンチは受けない代わりに
     ボタンとキーボードで同じことができる（G3: 触る面が多い操作は自作しない、の折衷）
   - 使う側: HutsGoMap.create(box, {huts, onPick, strings}) → {fit, destroy}
*/
(function () {
  "use strict";
  var TILE = 256;

  var SOURCES = {
    gsi: {
      url: "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
      min: 5, max: 16
    },
    topo: {
      url: "https://tile.opentopomap.org/{z}/{x}/{y}.png",
      attribution: '<a href="https://opentopomap.org/" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)',
      min: 5, max: 15
    }
  };

  function lonToX(lon, z) { return (lon + 180) / 360 * TILE * Math.pow(2, z); }
  function latToY(lat, z) {
    var s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * Math.pow(2, z);
  }

  function create(box, opts) {
    var huts = (opts.huts || []).filter(function (h) { return h.location && h.location.lat; });
    var S = opts.strings || {};
    var t = function (k) { return S[k] || k; };
    var src = SOURCES[opts.source || "gsi"] || SOURCES.gsi;
    var z = 11, cx = 0, cy = 0;          // 中心（world pixel、現在の z で）
    var w = 0, h = 0;

    box.classList.add("hgmap");
    box.innerHTML = "";
    var tiles = document.createElement("div");
    tiles.className = "hgmap-tiles";
    var pins = document.createElement("div");
    pins.className = "hgmap-pins";
    var ui = document.createElement("div");
    ui.className = "hgmap-ui";
    var attr = document.createElement("p");
    attr.className = "hgmap-attr";
    attr.innerHTML = src.attribution;
    box.appendChild(tiles);
    box.appendChild(pins);
    box.appendChild(ui);
    box.appendChild(attr);

    function button(label, title, fn) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "hgmap-btn";
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", fn);
      ui.appendChild(b);
      return b;
    }
    button("＋", t("zoom_in"), function () { zoomBy(1); });
    button("−", t("zoom_out"), function () { zoomBy(-1); });
    button("⤢", t("fit"), function () { fit(); });

    function zoomBy(d) {
      var nz = Math.max(src.min, Math.min(src.max, z + d));
      if (nz === z) return;
      var f = Math.pow(2, nz - z);
      cx *= f; cy *= f; z = nz;
      draw();
    }

    function fit() {
      if (!huts.length) return;
      var lats = huts.map(function (x) { return x.location.lat; });
      var lons = huts.map(function (x) { return x.location.lon; });
      var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
      var minLon = Math.min.apply(null, lons), maxLon = Math.max.apply(null, lons);
      measure();
      var best = src.min;
      for (var test = src.min; test <= src.max; test++) {
        var dx = Math.abs(lonToX(maxLon, test) - lonToX(minLon, test));
        var dy = Math.abs(latToY(minLat, test) - latToY(maxLat, test));
        if (dx < w - 80 && dy < h - 80) best = test;
      }
      z = best;
      cx = (lonToX(minLon, z) + lonToX(maxLon, z)) / 2;
      cy = (latToY(minLat, z) + latToY(maxLat, z)) / 2;
      draw();
    }

    function measure() {
      w = box.clientWidth || 640;
      h = box.clientHeight || 420;
    }

    function draw() {
      measure();
      var left = cx - w / 2, top = cy - h / 2;
      var x0 = Math.floor(left / TILE), y0 = Math.floor(top / TILE);
      var x1 = Math.floor((left + w) / TILE), y1 = Math.floor((top + h) / TILE);
      var max = Math.pow(2, z) - 1;
      var frag = document.createDocumentFragment();
      for (var x = x0; x <= x1; x++) {
        for (var y = y0; y <= y1; y++) {
          if (y < 0 || y > max) continue;
          var tx = ((x % (max + 1)) + max + 1) % (max + 1);
          var img = document.createElement("img");
          img.className = "hgmap-tile";
          img.alt = "";
          img.loading = "lazy";
          img.decoding = "async";
          img.src = src.url.replace("{z}", z).replace("{x}", tx).replace("{y}", y);
          img.style.left = (x * TILE - left) + "px";
          img.style.top = (y * TILE - top) + "px";
          frag.appendChild(img);
        }
      }
      tiles.innerHTML = "";
      tiles.appendChild(frag);
      drawPins(left, top);
    }

    function drawPins(left, top) {
      pins.innerHTML = "";
      huts.forEach(function (hut) {
        var px = lonToX(hut.location.lon, z) - left;
        var py = latToY(hut.location.lat, z) - top;
        if (px < -40 || py < -40 || px > w + 40 || py > h + 40) return;
        var b = document.createElement("button");
        b.type = "button";
        b.className = "hgmap-pin";
        b.style.left = px + "px";
        b.style.top = py + "px";
        b.dataset.hut = hut.id;
        var name = opts.nameOf ? opts.nameOf(hut) : hut.id;
        b.title = name;
        b.setAttribute("aria-label", t("add_to_plan") + "：" + name);
        var dot = document.createElement("span");
        dot.className = "hgmap-dot";
        var lab = document.createElement("span");
        lab.className = "hgmap-label";
        lab.textContent = name;
        b.appendChild(dot);
        b.appendChild(lab);
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          if (opts.onPick) opts.onPick(hut.id);
        });
        pins.appendChild(b);
      });
    }

    // ---- 移動（ドラッグ）------------------------------------------------
    var drag = null;
    box.addEventListener("pointerdown", function (e) {
      if (e.target.closest(".hgmap-pin,.hgmap-btn,.hgmap-attr")) return;
      drag = { x: e.clientX, y: e.clientY, cx: cx, cy: cy };
      box.setPointerCapture(e.pointerId);
      box.classList.add("is-panning");
    });
    box.addEventListener("pointermove", function (e) {
      if (!drag) return;
      cx = drag.cx - (e.clientX - drag.x);
      cy = drag.cy - (e.clientY - drag.y);
      draw();
    });
    ["pointerup", "pointercancel"].forEach(function (ev) {
      box.addEventListener(ev, function () { drag = null; box.classList.remove("is-panning"); });
    });
    box.addEventListener("wheel", function (e) {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    box.tabIndex = 0;
    box.addEventListener("keydown", function (e) {
      var step = 60;
      var moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) { cx += moves[e.key][0]; cy += moves[e.key][1]; draw(); e.preventDefault(); }
      if (e.key === "+" || e.key === "=") { zoomBy(1); }
      if (e.key === "-") { zoomBy(-1); }
    });
    window.addEventListener("resize", draw);

    fit();
    return {
      fit: fit,
      redraw: draw,
      visibleHuts: function () {
        var left = cx - w / 2, top = cy - h / 2;
        return huts.filter(function (hut) {
          var px = lonToX(hut.location.lon, z) - left, py = latToY(hut.location.lat, z) - top;
          return px >= 0 && py >= 0 && px <= w && py <= h;
        });
      }
    };
  }

  window.HutsGoMap = { create: create, sources: SOURCES, lonToX: lonToX, latToY: latToY };
})();
