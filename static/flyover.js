/* 試作 /lab/flyover/: 歩いたルートを、航空写真＋標高の 3D の上で飛ぶ縦長動画にする。
   - 写真・動画は端末の中だけで読む（送信しない）。位置は写真の EXIF、iPhone 動画の ©xyz から取る
   - 位置が無いものは撮影時刻の順にルート上へ並べる（推測の位置であることを一覧に出す）
   - 地図: 国土地理院の航空写真（seamlessphoto）と標高タイル（dem_png）。MapLibre GL JS 5
   - 書き出し: 地図と写真・文字を 1 枚の canvas に合成し、MediaRecorder で録る（MP4 が録れる端末は MP4） */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var BASE = location.pathname.replace(/\/lab\/flyover\/.*$/, "");
  var W = 720, H = 1280;              // 書き出しの大きさ（縦 9:16）
  var FLY_SEC = Number(new URLSearchParams(location.search).get("sec")) || 26;   // 飛行だけの秒数（写真の停止は別）
  var PHOTO_SEC = 2.8, VIDEO_MAX_SEC = 5;
  var EXAG = 1.3;                     // 標高の強調。実寸だと山が平たく見え、強すぎると尾根でカメラが地面に潜る
  var Z = 12.9, PITCH = 60;           // 上から見下ろす（God's eye view）寄り。4 通り撮り比べて決めた（2026-10-01）
  var routes = [], route = null, media = [], map = null, busy = false;
  var out = $("fly-out"), ctx = out.getContext("2d");
  var status = function (s) { $("fly-status").textContent = s; };

  // ------------------------------------------------------------------ 位置と距離
  var R = 6371008.8, rad = Math.PI / 180;
  function dist(a, b) {
    var dLa = (b[0] - a[0]) * rad, dLo = (b[1] - a[1]) * rad;
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    var y = Math.sin((b[1] - a[1]) * rad) * Math.cos(b[0] * rad);
    var x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad) - Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos((b[1] - a[1]) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  function prepRoute(r) {
    var cum = [0];
    for (var i = 1; i < r.line.length; i++) cum.push(cum[i - 1] + dist(r.line[i - 1], r.line[i]));
    r.cum = cum; r.len = cum[cum.length - 1];
    r.stops.forEach(function (s) { s.d = project([s.lat, s.lon], r).d; });
    return r;
  }
  function at(r, d) {   // ルート上で距離 d の地点
    d = Math.max(0, Math.min(r.len, d));
    var lo = 0, hi = r.cum.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (r.cum[mid] <= d) lo = mid; else hi = mid; }
    var seg = r.cum[hi] - r.cum[lo] || 1, f = (d - r.cum[lo]) / seg;
    return [r.line[lo][0] + (r.line[hi][0] - r.line[lo][0]) * f, r.line[lo][1] + (r.line[hi][1] - r.line[lo][1]) * f];
  }
  function project(p, r) {   // 点 p に最も近いルート上の位置（距離 d と、ルートからの離れ off）
    var best = { d: 0, off: Infinity }, k = Math.cos(p[0] * rad);
    for (var i = 1; i < r.line.length; i++) {
      var a = r.line[i - 1], b = r.line[i];
      var ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0], px = p[1] * k, py = p[0];
      var dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-12;
      var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
      var q = [ay + dy * t, (ax + dx * t) / k], off = dist(p, q);
      if (off < best.off) best = { d: r.cum[i - 1] + (r.cum[i] - r.cum[i - 1]) * t, off: off };
    }
    return best;
  }
  function nearestStop(r, d) {
    var s = null;
    r.stops.forEach(function (x) { if (!s || Math.abs(x.d - d) < Math.abs(s.d - d)) s = x; });
    return s;
  }

  // ------------------------------------------------------------------ EXIF（JPEG の GPS と撮影日時だけ読む）
  function readExif(buf) {
    var v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null;
    var off = 2;
    while (off + 4 < v.byteLength) {
      var marker = v.getUint16(off), size = v.getUint16(off + 2);
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
      if ((marker & 0xFF00) !== 0xFF00) break;
      off += 2 + size;
    }
    return null;
  }
  function parseTiff(v, t) {
    var le = v.getUint16(t) === 0x4949;
    var u16 = function (o) { return v.getUint16(t + o, le); }, u32 = function (o) { return v.getUint32(t + o, le); };
    var ifd = function (o) {
      var n = u16(o), tags = {};
      for (var i = 0; i < n; i++) {
        var e = o + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
        var size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
        var vo = cnt * size > 4 ? u32(e + 8) : e + 8;
        tags[tag] = { type: type, cnt: cnt, off: vo };
      }
      return tags;
    };
    var rat = function (o, i) { return u32(o + i * 8) / (u32(o + i * 8 + 4) || 1); };
    var str = function (x) { var s = ""; for (var i = 0; i < x.cnt - 1; i++) s += String.fromCharCode(v.getUint8(t + x.off + i)); return s; };
    var ifd0 = ifd(u32(4)), res = {};
    if (ifd0[0x8769]) {
      var ex = ifd(u32(ifd0[0x8769].off));   // Exif IFD への位置（LONG 1 個なので項目の中に直接入っている）
      var dt = ex[0x9003] || ex[0x9004];
      if (dt) res.time = parseExifDate(str(dt));
    }
    if (!res.time && ifd0[0x0132]) res.time = parseExifDate(str(ifd0[0x0132]));
    if (ifd0[0x8825]) {
      var g = ifd(u32(ifd0[0x8825].off));
      if (g[2] && g[4]) {
        var dms = function (x) { return rat(x.off, 0) + rat(x.off, 1) / 60 + rat(x.off, 2) / 3600; };
        var lat = dms(g[2]), lon = dms(g[4]);
        if (g[1] && String.fromCharCode(v.getUint8(t + g[1].off)) === "S") lat = -lat;
        if (g[3] && String.fromCharCode(v.getUint8(t + g[3].off)) === "W") lon = -lon;
        if (lat || lon) res.gps = [lat, lon];
      }
    }
    return res;
  }
  function parseExifDate(s) {   // "2026:08:12 05:41:03"（端末の現地時刻。山行は日本なので JST とみなす）
    var m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/.exec(s || "");
    return m ? { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], key: m[1] + m[2] + m[3] + m[4] + m[5] } : null;
  }
  // iPhone の動画は QuickTime の ©xyz に "+36.3420+137.6479+3100.000/" の形で位置が入る
  function readVideoGps(buf) {
    var b = new Uint8Array(buf);
    for (var i = 0; i < b.length - 8; i++) {
      if (b[i] === 0xA9 && b[i + 1] === 0x78 && b[i + 2] === 0x79 && b[i + 3] === 0x7A) {
        var s = ""; for (var j = i + 4; j < Math.min(b.length, i + 64); j++) { var c = b[j]; if (c >= 0x2B && c <= 0x39 || c === 0x2F) s += String.fromCharCode(c); }
        var m = /([+-]\d+\.\d+)([+-]\d+\.\d+)/.exec(s);
        if (m) return [Number(m[1]), Number(m[2])];
      }
    }
    return null;
  }
  function headAndTail(file, n) {   // moov は先頭にも末尾にもありうる
    var parts = [file.slice(0, n)];
    if (file.size > n) parts.push(file.slice(Math.max(n, file.size - n)));
    return new Blob(parts).arrayBuffer();
  }

  // ------------------------------------------------------------------ 写真・動画の読み込みと配置
  async function loadFiles(files) {
    status("読み込み中…");
    var list = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i], isVideo = /^video\//.test(f.type), m = { file: f, kind: isVideo ? "video" : "image", name: f.name };
      try {
        if (isVideo) {
          m.gps = readVideoGps(await headAndTail(f, 2 * 1024 * 1024));
          m.el = document.createElement("video");
          m.el.src = URL.createObjectURL(f); m.el.muted = true; m.el.playsInline = true; m.el.preload = "auto";
          await new Promise(function (ok) { m.el.onloadeddata = ok; m.el.onerror = ok; });
          m.dur = Math.min(VIDEO_MAX_SEC, m.el.duration || VIDEO_MAX_SEC);
        } else {
          var ex = readExif(await f.slice(0, 256 * 1024).arrayBuffer()) || {};
          m.gps = ex.gps || null; m.time = ex.time || null;
          m.img = await createImageBitmap(f);
        }
      } catch (e) {
        m.err = String(e && e.message || e);
      }
      if (!m.time) m.timeMs = f.lastModified;
      list.push(m);
    }
    media = list.filter(function (m) { return !m.err; });
    place();
    renderList(list);
    status(media.length ? "配置しました。「下見する」で動きを確かめられます。" : "読み込めるファイルがありませんでした。");
  }
  function timeKey(m) { return m.time ? m.time.key : String(m.timeMs || 0); }
  function place() {
    if (!route) return;
    var onRoute = [], rest = [];
    media.forEach(function (m) {
      m.placed = null;
      if (m.gps) {
        var p = project(m.gps, route);
        if (p.off < 3000) { m.d = p.d; m.placed = "gps"; m.off = p.off; onRoute.push(m); return; }
        m.placed = "far";
      }
      rest.push(m);
    });
    // 位置が無いもの: 撮影時刻で、位置のある写真のあいだに挟む。位置のある写真が無ければ時刻順に等間隔
    rest.sort(function (a, b) { return timeKey(a) < timeKey(b) ? -1 : 1; });
    var anchors = onRoute.filter(function (m) { return m.time; }).sort(function (a, b) { return timeKey(a) < timeKey(b) ? -1 : 1; });
    rest.forEach(function (m, i) {
      var before = null, after = null;
      anchors.forEach(function (a) { if (timeKey(a) <= timeKey(m)) before = a; else if (!after) after = a; });
      if (before && after) m.d = (before.d + after.d) / 2;
      else if (before) m.d = Math.min(route.len * 0.97, before.d + route.len * 0.05);
      else if (after) m.d = Math.max(route.len * 0.03, after.d - route.len * 0.05);
      else m.d = route.len * (0.08 + 0.86 * (i + 1) / (rest.length + 1));
      m.placed = m.placed === "far" ? "far" : "time";
    });
    media.sort(function (a, b) { return a.d - b.d; });
  }
  function renderList(all) {
    var ol = $("fly-list"); ol.innerHTML = "";
    (all || media).forEach(function (m) {
      var li = document.createElement("li");
      var th = m.kind === "video" ? document.createElement("video") : document.createElement("img");
      if (!m.err) { th.src = m.el ? m.el.src : URL.createObjectURL(m.file); if (m.el) th.muted = true; }
      li.appendChild(th);
      var t = document.createElement("div");
      var where = m.err ? "読めませんでした（" + m.err + "）"
        : m.placed === "gps" ? "撮影地点に配置（ルートから " + Math.round(m.off) + "m）・" + (nearestStop(route, m.d) || {}).name.ja + "付近"
        : m.placed === "far" ? "位置がルートから 3km 以上離れているため、撮影時刻の順に配置"
        : "位置情報なし。撮影時刻の順に配置（場所は目安）";
      t.innerHTML = "<span></span><small></small>";
      t.firstChild.textContent = m.name; t.lastChild.textContent = where;
      li.appendChild(t); ol.appendChild(li);
    });
  }

  // ------------------------------------------------------------------ 地図
  function initMap() {
    map = new maplibregl.Map({
      container: "fly-map", interactive: false, attributionControl: false, pixelRatio: W / 360,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      maxPitch: 80, fadeDuration: 0,
      style: {
        version: 8,
        sources: {
          photo: { type: "raster", tiles: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 18 },
          // 地理院の標高 PNG: 標高 = (R×2^16 + G×2^8 + B) × 0.01 m
          dem: { type: "raster-dem", tiles: ["https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 14,
                 encoding: "custom", redFactor: 655.36, greenFactor: 2.56, blueFactor: 0.01, baseShift: 0 }
        },
        layers: [{ id: "photo", type: "raster", source: "photo", paint: { "raster-saturation": 0.1, "raster-contrast": 0.08 } }],
        sky: { "sky-color": "#9cc3e4", "horizon-color": "#e8eef2", "fog-color": "#dde6ea", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.85 }
      },
      center: [137.69, 36.36], zoom: 11, pitch: 0
    });
    return new Promise(function (ok) { map.on("load", ok); });
  }
  function setRouteOnMap() {
    var gj = { type: "Feature", geometry: { type: "LineString", coordinates: route.line.map(function (p) { return [p[1], p[0]]; }) } };
    var pts = { type: "FeatureCollection", features: route.stops.map(function (s) {
      return { type: "Feature", properties: { kind: s.kind }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } }; }) };
    if (map.getSource("route")) { map.getSource("route").setData(gj); map.getSource("stops").setData(pts); return; }
    map.addSource("route", { type: "geojson", data: gj });
    map.addSource("stops", { type: "geojson", data: pts });
    map.addLayer({ id: "route-halo", type: "line", source: "route", paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.85 }, layout: { "line-join": "round", "line-cap": "round" } });
    map.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#E4572E", "line-width": 3.5 }, layout: { "line-join": "round", "line-cap": "round" } });
    map.addLayer({ id: "stops", type: "circle", source: "stops", paint: { "circle-radius": 6, "circle-color": "#ffffff", "circle-stroke-color": "#17251F", "circle-stroke-width": 2.5, "circle-pitch-alignment": "map" } });
  }
  async function overview() {   // ルート全体を真上から見せ、そのあいだに標高の断面を測る
    map.setTerrain(null);
    var b = new maplibregl.LngLatBounds();
    route.line.forEach(function (p) { b.extend([p[1], p[0]]); });
    map.fitBounds(b, { padding: 60, duration: 0, pitch: 0, bearing: 0 });
    map.setTerrain({ source: "dem", exaggeration: 1 });
    await idle(8000);
    var N = 160, prof = [];
    for (var i = 0; i <= N; i++) {
      var p = at(route, route.len * i / N);
      var e = map.queryTerrainElevation([p[1], p[0]]);
      prof.push(e == null ? null : e);
    }
    route.profile = prof.some(function (x) { return x != null; }) ? prof : null;
    map.setTerrain({ source: "dem", exaggeration: EXAG });
  }
  function idle(ms) {
    return new Promise(function (ok) {
      var done = false, fin = function () { if (!done) { done = true; ok(); } };
      map.once("idle", fin); setTimeout(fin, ms);
    });
  }

  // ------------------------------------------------------------------ 進行表（飛行と写真の停止）
  function timeline() {
    var v = route.len / FLY_SEC, ev = [], t = 0, d = 0;
    var intro = 1.6, outro = 2.2;
    ev.push({ kind: "intro", t0: 0, t1: intro });
    t = intro;
    media.forEach(function (m) {
      var dt = (m.d - d) / v;
      if (dt > 0) { ev.push({ kind: "fly", t0: t, t1: t + dt, d0: d, d1: m.d }); t += dt; d = m.d; }
      var hold = m.kind === "video" ? m.dur : PHOTO_SEC;
      ev.push({ kind: "photo", t0: t, t1: t + hold, d0: d, d1: d, m: m }); t += hold;
    });
    var rest = (route.len - d) / v;
    ev.push({ kind: "fly", t0: t, t1: t + rest, d0: d, d1: route.len }); t += rest;
    ev.push({ kind: "outro", t0: t, t1: t + outro, d0: route.len, d1: route.len }); t += outro;
    return { ev: ev, total: t };
  }
  function ease(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
  var smoothBearing = null;
  function cameraAt(tl, t) {
    var e = tl.ev.find(function (x) { return t >= x.t0 && t < x.t1; }) || tl.ev[tl.ev.length - 1];
    var f = (t - e.t0) / ((e.t1 - e.t0) || 1);
    var d = e.kind === "intro" ? 0 : e.kind === "fly" ? e.d0 + (e.d1 - e.d0) * f : e.d0;
    var ahead = at(route, d + 900), behind = at(route, d - 300);
    var b = bearing(behind, ahead);
    if (smoothBearing === null) smoothBearing = b;
    var diff = ((b - smoothBearing + 540) % 360) - 180;
    smoothBearing = (smoothBearing + diff * 0.04 + 360) % 360;     // 急に向きを変えない
    var c = at(route, d);   // at() は [緯度, 経度]。MapLibre の center は [経度, 緯度]
    var cam = { center: [c[1], c[0]], bearing: smoothBearing, pitch: PITCH, zoom: Z };
    if (e.kind === "intro") { var k = ease(f); cam.pitch = 20 + (PITCH - 20) * k; cam.zoom = 11.4 + (Z - 11.4) * k; }
    if (e.kind === "photo") cam.bearing = smoothBearing + 10 * Math.sin(f * Math.PI);   // 止まっているあいだも少し回る
    if (e.kind === "outro") { var o = ease(f); cam.zoom = Z - 1.6 * o; cam.pitch = PITCH - 14 * o; cam.bearing = smoothBearing + 40 * o; }
    return { cam: cam, e: e, f: f, d: d };
  }

  // ------------------------------------------------------------------ 合成（地図＋写真＋文字）
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function text(s, x, y, size, weight, color, align) {
    ctx.font = (weight || 600) + " " + size + "px system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif";
    ctx.textAlign = align || "left"; ctx.fillStyle = color || "#fff";
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 8; ctx.fillText(s, x, y); ctx.shadowBlur = 0;
  }
  function fmtTime(m) {
    if (m.time) return m.time.mo + "/" + m.time.d + " " + String(m.time.h).padStart(2, "0") + ":" + String(m.time.mi).padStart(2, "0");
    return "";
  }
  function compose(st) {
    // 傾けたときに空の部分は地図の canvas が透明のままなので、先に空を塗っておく
    var sky = ctx.createLinearGradient(0, 0, 0, H * 0.55);
    sky.addColorStop(0, "#6f9fcb"); sky.addColorStop(1, "#dfe8ee");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(map.getCanvas(), 0, 0, W, H);
    // 上下を少し暗くして文字を読めるようにする
    var g = ctx.createLinearGradient(0, 0, 0, 260); g.addColorStop(0, "rgba(0,0,0,.55)"); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, 260);
    g = ctx.createLinearGradient(0, H - 330, 0, H); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.6)");
    ctx.fillStyle = g; ctx.fillRect(0, H - 330, W, 330);

    text(route.name.ja, 40, 86, 40, 700);
    var s = nearestStop(route, st.d);
    if (s) text((s.elev ? s.elev.toLocaleString() + "m  " : "") + s.name.ja + (Math.abs(s.d - st.d) > 400 ? " 付近" : ""), 40, 136, 28, 500, "#f2f2f2");

    if (st.e.kind === "photo") drawPhoto(st.e.m, st.f);
    drawProfile(st.d);
    text("hutsgo.com/trails/" + route.id + "/", 40, H - 40, 24, 600, "#fff");
    text("地図: 国土地理院", W - 40, H - 40, 20, 500, "rgba(255,255,255,.85)", "right");
  }
  function drawPhoto(m, f) {
    var a = Math.min(1, f * 6, (1 - f) * 6), sc = 0.94 + 0.06 * Math.min(1, f * 5);
    var src = m.kind === "video" ? m.el : m.img;
    var sw = m.kind === "video" ? m.el.videoWidth : m.img.width, sh = m.kind === "video" ? m.el.videoHeight : m.img.height;
    if (!sw || !sh) return;
    var bw = 600 * sc, bh = Math.min(820, bw * sh / sw) * sc, x = (W - bw) / 2, y = 230 + (820 - bh) / 2;
    ctx.save(); ctx.globalAlpha = a;
    ctx.shadowColor = "rgba(0,0,0,.4)"; ctx.shadowBlur = 30;
    rr(x - 10, y - 10, bw + 20, bh + 20, 22); ctx.fillStyle = "#fff"; ctx.fill(); ctx.shadowBlur = 0;
    rr(x, y, bw, bh, 14); ctx.clip();
    var r = Math.max(bw / sw, bh / sh), dw = sw * r, dh = sh * r;
    ctx.drawImage(src, x + (bw - dw) / 2, y + (bh - dh) / 2, dw, dh);
    ctx.restore();
    ctx.save(); ctx.globalAlpha = a;
    var cap = fmtTime(m);
    if (cap) text(cap, W / 2, y + bh + 54, 28, 600, "#fff", "center");
    ctx.restore();
  }
  function drawProfile(d) {
    var x0 = 40, x1 = W - 40, y0 = H - 210, y1 = H - 90;
    var prof = route.profile;
    ctx.save();
    if (prof) {
      var vals = prof.filter(function (v) { return v != null; }), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var Y = function (v) { return y1 - (v - lo) / ((hi - lo) || 1) * (y1 - y0); };
      ctx.beginPath(); ctx.moveTo(x0, y1);
      prof.forEach(function (v, i) { ctx.lineTo(x0 + (x1 - x0) * i / (prof.length - 1), Y(v == null ? lo : v)); });
      ctx.lineTo(x1, y1); ctx.closePath(); ctx.fillStyle = "rgba(255,255,255,.22)"; ctx.fill();
      ctx.beginPath();
      prof.forEach(function (v, i) { var X = x0 + (x1 - x0) * i / (prof.length - 1); i ? ctx.lineTo(X, Y(v == null ? lo : v)) : ctx.moveTo(X, Y(v == null ? lo : v)); });
      ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 3; ctx.stroke();
      var k = Math.round(d / route.len * (prof.length - 1)), cx = x0 + (x1 - x0) * d / route.len, cy = Y(prof[k] == null ? lo : prof[k]);
      media.forEach(function (m) { ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.fillRect(x0 + (x1 - x0) * m.d / route.len - 1.5, y1 + 6, 3, 10); });
      ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fillStyle = "#E4572E"; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke();
      text(Math.round(hi).toLocaleString() + "m", x0, y0 - 10, 20, 500, "rgba(255,255,255,.85)");
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ 再生と録画
  function frame(tl, t) {
    var st = cameraAt(tl, t);
    map.jumpTo(st.cam);
    if (st.e.kind === "photo" && st.e.m.kind === "video") {
      var v = st.e.m.el;
      if (v.paused) { v.currentTime = 0; v.play().catch(function () {}); }
    } else {
      media.forEach(function (m) { if (m.el && !m.el.paused) m.el.pause(); });
    }
    return st;
  }
  function play(record) {
    return new Promise(function (resolve) {
      smoothBearing = null;
      var tl = timeline(), start = null, rec = null, chunks = [], mime = "";
      if (record) {
        mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find(function (m) {
          return window.MediaRecorder && MediaRecorder.isTypeSupported(m); }) || "";
        rec = new MediaRecorder(out.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
        rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
        rec.onstop = function () { resolve({ blob: new Blob(chunks, { type: rec.mimeType || mime }), mime: rec.mimeType || mime, sec: tl.total }); };
        rec.start(500);
      }
      function tick(now) {
        if (start === null) start = now;
        var t = (now - start) / 1000, st;
        try {
          st = frame(tl, Math.min(t, tl.total - 0.001));
        } catch (e) {   // 途中で止まったことが見えるようにする（黙って固まらない）
          if (rec && rec.state !== "inactive") rec.stop();
          status("途中で止まりました: " + (e && e.message || e));
          resolve(null);
          return;
        }
        map.once("render", function () { compose(st); });
        map.triggerRepaint();
        status((record ? "録画中… " : "下見中… ") + Math.min(100, Math.round(t / tl.total * 100)) + "%");
        if (t < tl.total) requestAnimationFrame(tick);
        else if (rec) setTimeout(function () { rec.stop(); }, 300);
        else resolve(null);
      }
      requestAnimationFrame(tick);
    });
  }

  // 1 コマずつ組み立てる書き出し（WebCodecs ＋ mp4-muxer）。カメラを動かす→地形と写真の読み込みを待つ→合成→符号化。
  // 実時間の録画だと、読み込みが追いつかない端末では飛んでいる途中のコマが空になる。こちらは遅い端末でも時間がかかるだけで絵は欠けない
  var FPS = Number(new URLSearchParams(location.search).get("fps")) || 30;
  var timeouts = 0;
  function settle(ms) {   // 地形と航空写真の読み込みが済むまで待つ。打ち切ったら数える（崩れたコマが混ざった印）
    return new Promise(function (ok) {
      var done = false, fin = function (byTimeout) { if (!done) { done = true; if (byTimeout) timeouts++; ok(); } };
      map.once("idle", function () { fin(false); }); setTimeout(function () { fin(true); }, ms); map.triggerRepaint();
    });
  }
  function seek(el, t) {
    return new Promise(function (ok) {
      var done = false, fin = function () { if (!done) { done = true; ok(); } };
      el.addEventListener("seeked", fin, { once: true }); setTimeout(fin, 1500);
      el.currentTime = Math.max(0, Math.min(t, (el.duration || t) - 0.05));
    });
  }
  async function encodeFrames() {
    if (!window.VideoEncoder || !window.VideoFrame || !window.Mp4Muxer) return null;
    var config = null, codecs = ["avc1.640028", "avc1.4d0028", "avc1.42001f"];
    for (var c = 0; c < codecs.length && !config; c++) {
      var cfg = { codec: codecs[c], width: W, height: H, bitrate: 8e6, framerate: FPS };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) config = cfg; } catch (e) { /* 次の候補へ */ }
    }
    if (!config) return null;
    var muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: "avc", width: W, height: H }, fastStart: "in-memory" });
    var failed = null;
    var enc = new VideoEncoder({ output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); }, error: function (e) { failed = e; } });
    enc.configure(config);
    media.forEach(function (m) { if (m.el) m.el.pause(); });
    smoothBearing = null;
    var tl = timeline(), N = Math.ceil(tl.total * FPS);
    timeouts = 0;
    for (var i = 0; i < N; i++) {
      var t = i / FPS, st = cameraAt(tl, t);
      map.jumpTo(st.cam);
      await settle(15000);
      if (st.e.kind === "photo" && st.e.m.kind === "video") await seek(st.e.m.el, t - st.e.t0);
      compose(st);
      var vf = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: i % (FPS * 2) === 0 });
      vf.close();
      if (failed) throw failed;
      if (enc.encodeQueueSize > 8) await new Promise(function (ok) { setTimeout(ok, 0); });
      if (i % 5 === 0) status("書き出し中… " + Math.round(i / N * 100) + "%（1 コマずつ組み立てています。このページを開いたままにしてください）");
    }
    await enc.flush();
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), sec: tl.total, frames: N, timeouts: timeouts,
             mime: "video/mp4（" + config.codec + "・1 コマずつ・" + FPS + "fps）" + (timeouts ? "・読み込み待ちを打ち切ったコマ " + timeouts : "") };
  }

  async function run(record) {
    if (busy) return;
    busy = true; $("fly-preview").disabled = $("fly-record").disabled = true;
    try {
      if (!media.length) status("写真が無いので、ルートだけを飛びます。");
      await overview();
      var res = null;
      if (record) res = await encodeFrames();
      if (record && !res) {
        // WebCodecs が無い端末は実時間で録る。一度ゆっくり飛んで地形を読み込んでから録る
        status("地形を読み込んでいます（一度ゆっくり飛んで準備します）…");
        await play(false);
        res = await play(true);
      } else if (!record) {
        res = await play(false);
      }
      if (res) {
        var url = URL.createObjectURL(res.blob), ext = /mp4/.test(res.mime) ? "mp4" : "webm";
        $("fly-video").src = url;
        $("fly-download").href = url; $("fly-download").download = "hutsgo-" + route.id + "." + ext;
        $("fly-format").textContent = "形式: " + (res.mime || "既定") + "・約 " + Math.round(res.sec) + " 秒・" + (res.blob.size / 1048576).toFixed(1) + "MB"
          + (ext === "webm" ? "（この端末では MP4 で録れませんでした。Instagram などに上げるときは MP4 への変換が要ることがあります）" : "");
        $("fly-result").hidden = false;
        status("できました。");
        track("flyover_export");
      } else {
        status("下見が終わりました。よければ「動画を書き出す」へ。");
      }
    } catch (e) {
      status("うまく動きませんでした: " + (e && e.message || e));
    }
    busy = false; $("fly-preview").disabled = $("fly-record").disabled = false;
  }
  function track(ev) {
    var api = (document.querySelector('meta[name="hutsgo-api"]') || {}).content;
    if (api && navigator.sendBeacon) {
      navigator.sendBeacon(api + "/track.php", new Blob([JSON.stringify({ ev: ev, lang: "ja", hut: "", trail: route.id, page: location.pathname, ref: "" })], { type: "text/plain" }));
    }
  }

  // ------------------------------------------------------------------ 起動
  async function boot() {
    if (!window.maplibregl) { status("地図の部品を読み込めませんでした。通信を確かめてください。"); return; }
    routes = await (await fetch(BASE + "/lab/flyover/routes.json")).json();
    var sel = $("fly-route");
    routes.forEach(function (r) {
      var o = document.createElement("option"); o.value = r.id;
      o.textContent = r.name.ja + (r.traced ? "" : "（線は目安）"); sel.appendChild(o);
    });
    var want = new URLSearchParams(location.search).get("route") || "omote_ginza";
    sel.value = routes.some(function (r) { return r.id === want; }) ? want : routes[0].id;
    route = prepRoute(routes.find(function (r) { return r.id === sel.value; }));
    status("地図を準備しています…");
    await initMap();
    setRouteOnMap();
    await overview();
    compose({ d: 0, e: { kind: "intro" }, f: 0 });
    status("写真・動画を選ぶか、そのまま「下見する」を押してください。");
    sel.addEventListener("change", async function () {
      route = prepRoute(routes.find(function (r) { return r.id === sel.value; }));
      setRouteOnMap(); place(); renderList(); await overview(); compose({ d: 0, e: { kind: "intro" }, f: 0 });
    });
    $("fly-files").addEventListener("change", function (e) { loadFiles(e.target.files); });
    $("fly-preview").addEventListener("click", function () { run(false); });
    $("fly-record").addEventListener("click", function () { run(true); });
    window.HutsGoFlyover = { map: map, at: function (d) { return at(route, d); }, len: function () { return route.len; }, state: function () { return { route: route && route.id, media: media.map(function (m) { return { name: m.name, placed: m.placed, d: m.d }; }), profile: !!(route && route.profile) }; } };
  }
  boot();
})();
