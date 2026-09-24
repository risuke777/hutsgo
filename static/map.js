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
      // 地理院の英語版地図。z11 までしか無いので、それより寄ったら通常版に戻す
      enUrl: "https://cyberjapandata.gsi.go.jp/xyz/english/{z}/{x}/{y}.png",
      enMax: 11,
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
    var chosen = {};                     // 行程に入っている小屋。ピンの見た目で分かるようにする

    box.classList.add("hgmap");
    box.innerHTML = "";
    var tiles = document.createElement("div");
    tiles.className = "hgmap-tiles";
    var lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    lines.setAttribute("class", "hgmap-lines");
    lines.setAttribute("aria-hidden", "true");
    var pins = document.createElement("div");
    pins.className = "hgmap-pins";
    var ui = document.createElement("div");
    ui.className = "hgmap-ui";
    var attr = document.createElement("p");
    attr.className = "hgmap-attr";
    attr.innerHTML = src.attribution;
    box.appendChild(tiles);
    box.appendChild(lines);
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

    function zoomBy(d, anchorX, anchorY) {
      var nz = Math.max(src.min, Math.min(src.max, z + d));
      if (nz === z) return;
      measure();
      // 押さえている点を動かさずに拡大縮小する。中心基準だと指の下の山が逃げる
      var ax = anchorX == null ? w / 2 : anchorX;
      var ay = anchorY == null ? h / 2 : anchorY;
      var worldX = cx - w / 2 + ax, worldY = cy - h / 2 + ay;
      var f = Math.pow(2, nz - z);
      cx = worldX * f - ax + w / 2;
      cy = worldY * f - ay + h / 2;
      z = nz;
      draw();
    }

    function local(e) {
      var r = box.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
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
          var tpl = (opts.lang === "en" && src.enUrl && z <= (src.enMax || 0)) ? src.enUrl : src.url;
          img.src = tpl.replace("{z}", z).replace("{x}", tx).replace("{y}", y);
          img.style.left = (x * TILE - left) + "px";
          img.style.top = (y * TILE - top) + "px";
          frag.appendChild(img);
        }
      }
      tiles.innerHTML = "";
      tiles.appendChild(frag);
      drawLines(left, top);
      drawPins(left, top);
      if (opts.onMove) opts.onMove();
    }

    function drawLines(left, top) {
      lines.innerHTML = "";
      if (!opts.lines || !opts.lines.length) { lines.style.display = "none"; return; }
      lines.style.display = "";
      lines.setAttribute("viewBox", "0 0 " + w + " " + h);
      lines.setAttribute("width", w);
      lines.setAttribute("height", h);
      opts.lines.forEach(function (pts) {
        var d = pts.filter(function (p) { return p && p.lat; }).map(function (p) {
          return (lonToX(p.lon, z) - left).toFixed(1) + "," + (latToY(p.lat, z) - top).toFixed(1);
        }).join(" ");
        if (!d) return;
        var el = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        el.setAttribute("class", "hgmap-route");
        el.setAttribute("points", d);
        lines.appendChild(el);
      });
    }

    function drawPins(left, top) {
      pins.innerHTML = "";
      // 名前を出すかどうかは密度で決める。拡大したのに名前が消えるのは逆
      var inView = huts.filter(function (hut) {
        var px = lonToX(hut.location.lon, z) - left, py = latToY(hut.location.lat, z) - top;
        return px > -40 && py > -40 && px < w + 40 && py < h + 40;
      });
      var roomy = inView.length <= Math.max(4, Math.floor(w * h / 26000));
      huts.forEach(function (hut) {
        var px = lonToX(hut.location.lon, z) - left;
        var py = latToY(hut.location.lat, z) - top;
        if (px < -40 || py < -40 || px > w + 40 || py > h + 40) return;
        var b = document.createElement("button");
        b.type = "button";
        b.className = "hgmap-pin" + (chosen[hut.id] ? " is-chosen" : "");
        b.setAttribute("aria-pressed", chosen[hut.id] ? "true" : "false");
        b.style.left = px + "px";
        b.style.top = py + "px";
        b.dataset.hut = hut.id;
        var name = opts.nameOf ? opts.nameOf(hut) : hut.id;
        b.title = name;
        b.setAttribute("aria-label", (chosen[hut.id] ? t("in_plan") : t("add_to_plan")) + "：" + name);
        var dot = document.createElement("span");
        dot.className = "hgmap-dot";
        var lab = document.createElement("span");
        lab.className = "hgmap-label";
        if (!roomy && !chosen[hut.id]) lab.classList.add("is-crowded");
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

    // ---- 指とマウスの操作 -------------------------------------------------
    // 1本 = 移動、2本 = ピンチ。タイルは整数ズームなので、間隔が一定倍を超えたところで
    // 1段動かし、そこから測り直す。指の中点は動かさない。
    var drag = null;
    var pointers = {};        // pointerId -> {x, y}
    var pinch = null;         // {dist, midX, midY}

    function pointerList() {
      return Object.keys(pointers).map(function (k) { return pointers[k]; });
    }
    function startPinch() {
      var p = pointerList();
      if (p.length < 2) { pinch = null; return; }
      var dx = p[0].x - p[1].x, dy = p[0].y - p[1].y;
      pinch = { dist: Math.hypot(dx, dy) || 1, midX: (p[0].x + p[1].x) / 2, midY: (p[0].y + p[1].y) / 2 };
      drag = null;
      box.classList.remove("is-panning");
    }

    box.addEventListener("pointerdown", function (e) {
      if (e.target.closest(".hgmap-pin,.hgmap-btn,.hgmap-attr")) return;
      var l = local(e);
      pointers[e.pointerId] = l;
      if (Object.keys(pointers).length >= 2) {
        startPinch();
      } else {
        drag = { x: e.clientX, y: e.clientY, cx: cx, cy: cy };
        box.classList.add("is-panning");
      }
      if (box.setPointerCapture) { try { box.setPointerCapture(e.pointerId); } catch (err) { /* 古い実装 */ } }
    });
    box.addEventListener("pointermove", function (e) {
      if (pointers[e.pointerId]) pointers[e.pointerId] = local(e);
      if (pinch) {
        var p = pointerList();
        if (p.length < 2) return;
        var dx = p[0].x - p[1].x, dy = p[0].y - p[1].y;
        var d = Math.hypot(dx, dy) || 1;
        var midX = (p[0].x + p[1].x) / 2, midY = (p[0].y + p[1].y) / 2;
        var ratio = d / pinch.dist;
        if (ratio > 1.5) { zoomBy(1, midX, midY); startPinch(); }
        else if (ratio < 0.667) { zoomBy(-1, midX, midY); startPinch(); }
        return;
      }
      if (!drag) return;
      cx = drag.cx - (e.clientX - drag.x);
      cy = drag.cy - (e.clientY - drag.y);
      draw();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) {
      box.addEventListener(ev, function (e) {
        delete pointers[e.pointerId];
        if (Object.keys(pointers).length < 2) pinch = null;
        if (!Object.keys(pointers).length) { drag = null; box.classList.remove("is-panning"); }
      });
    });
    box.addEventListener("wheel", function (e) {
      e.preventDefault();
      var l = local(e);
      zoomBy(e.deltaY < 0 ? 1 : -1, l.x, l.y);
    }, { passive: false });
    box.tabIndex = 0;
    box.addEventListener("keydown", function (e) {
      var step = 60;
      var moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) { cx += moves[e.key][0]; cy += moves[e.key][1]; draw(); e.preventDefault(); }
      if (e.key === "+" || e.key === "=") { zoomBy(1); }
      if (e.key === "-") { zoomBy(-1); }
    });
    box.addEventListener("dblclick", function (e) {
      if (e.target.closest(".hgmap-pin,.hgmap-btn,.hgmap-attr")) return;
      var l = local(e);
      zoomBy(1, l.x, l.y);
    });
    window.addEventListener("resize", draw);

    fit();
    return {
      fit: fit,
      redraw: draw,
      // 小屋を中心に寄せる。小屋ページから「行程に追加」で来たとき、その山がどこかを見せる
      focus: function (id, zoom) {
        var hut = huts.filter(function (x) { return x.id === id; })[0];
        if (!hut) return;
        measure();
        z = Math.max(src.min, Math.min(src.max, zoom || Math.max(z, 13)));
        cx = lonToX(hut.location.lon, z);
        cy = latToY(hut.location.lat, z);
        draw();
      },
      setChosen: function (ids) {
        chosen = {};
        (ids || []).forEach(function (id) { chosen[id] = true; });
        draw();
      },
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
