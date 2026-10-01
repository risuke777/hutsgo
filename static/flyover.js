/* 試作 /lab/flyover/: 歩いた道を 3D でふりかえり、縦長の動画にも書き出す。
   - 道: HutsGo のルート、または手持ちの GPX（時刻・標高があれば使う）
   - 写真・動画: 端末の中だけで読む（送信しない）。位置は EXIF の GPS・iPhone 動画の ©xyz、
     無ければ撮影時刻を GPX の時刻と突き合わせて置く。どちらも無ければ撮影時刻の順に並べる（目安と明示）
   - 3D: 国土地理院の航空写真（seamlessphoto）と標高（dem_png）。MapLibre GL JS 5。指で回転・傾け・拡大できる
   - 近くの小屋: GPX から 800m 以内の HutsGo の小屋をピンで出し、小屋ページへつなぐ
   - 書き出し: 1 コマずつ「カメラを動かす→読み込みを待つ→合成→符号化」（WebCodecs ＋ mp4-muxer）。無ければ実時間録画 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var Q = new URLSearchParams(location.search);
  var BASE = location.pathname.replace(/\/lab\/flyover\/.*$/, "");
  var W = 720, H = 1280;                       // 書き出しの大きさ（縦 9:16）
  var FLY_SEC = Number(Q.get("sec")) || 26;    // 書き出しで飛ぶ秒数（写真の停止は別）
  var PLAY_SEC = 40;                           // 画面の再生で端から端まで進む秒数
  var PHOTO_SEC = 2.8, VIDEO_MAX_SEC = 5;
  var EXAG = 1.3, Z = 12.9, PITCH = 60;        // 4 通り撮り比べて決めた（2026-10-01）
  var HUT_NEAR_M = 800;
  var routes = [], route = null, media = [], failed = [], map = null, huts = null, busy = false, tz = null;
  var out = $("fly-out"), ctx = out.getContext("2d");
  var status = function (s) { $("fly-status").textContent = s; };
  var JA_DOW = ["日", "月", "火", "水", "木", "金", "土"];

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
    r.cum = cum; r.len = cum[cum.length - 1] || 1;
    (r.stops || []).forEach(function (s) { s.d = project([s.lat, s.lon], r).d; });
    return r;
  }
  function seg(r, d) {   // 距離 d が入る区間と、その中の割合
    d = Math.max(0, Math.min(r.len, d));
    var lo = 0, hi = r.cum.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (r.cum[mid] <= d) lo = mid; else hi = mid; }
    return { lo: lo, hi: hi, f: (d - r.cum[lo]) / ((r.cum[hi] - r.cum[lo]) || 1) };
  }
  function at(r, d) {
    var s = seg(r, d), a = r.line[s.lo], b = r.line[s.hi];
    return [a[0] + (b[0] - a[0]) * s.f, a[1] + (b[1] - a[1]) * s.f];
  }
  function lerpArr(arr, r, d) {
    if (!arr) return null;
    var s = seg(r, d), a = arr[s.lo], b = arr[s.hi];
    if (a == null || b == null) return a != null ? a : b;
    return a + (b - a) * s.f;
  }
  function project(p, r) {
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
  function eleAt(d) { return route.ele ? lerpArr(route.ele, route, d) : profileAt(d); }
  function profileAt(d) {
    var p = route.profile; if (!p) return null;
    var x = d / route.len * (p.length - 1), i = Math.floor(x), f = x - i;
    var a = p[i], b = p[Math.min(p.length - 1, i + 1)];
    return a == null ? b : b == null ? a : a + (b - a) * f;
  }
  function timeAt(d) { return route.times ? lerpArr(route.times, route, d) : null; }
  function dAtTime(ms) {
    var T = route.times; if (!T) return null;
    for (var i = 1; i < T.length; i++) {
      if (T[i - 1] != null && T[i] != null && ms >= T[i - 1] && ms <= T[i]) {
        return route.cum[i - 1] + (route.cum[i] - route.cum[i - 1]) * ((ms - T[i - 1]) / ((T[i] - T[i - 1]) || 1));
      }
    }
    return null;
  }
  function nearestStop(d) {
    var s = null;
    (route.stops || []).forEach(function (x) { if (!s || Math.abs(x.d - d) < Math.abs(s.d - d)) s = x; });
    return s;
  }

  // ------------------------------------------------------------------ GPX
  function parseGpx(text, fname) {
    var doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("GPX として読めませんでした");
    var pts = Array.prototype.slice.call(doc.getElementsByTagName("trkpt"));
    if (pts.length < 2) pts = Array.prototype.slice.call(doc.getElementsByTagName("rtept"));
    if (pts.length < 2) throw new Error("GPX に道の点（trkpt / rtept）がありません");
    var child = function (el, tag) { var c = el.getElementsByTagName(tag)[0]; return c ? c.textContent.trim() : null; };
    var nameEl = doc.querySelector("trk > name") || doc.querySelector("metadata > name") || doc.querySelector("rte > name");
    var line = [], ele = [], times = [], hasE = false, hasT = false;
    pts.forEach(function (p) {
      var la = Number(p.getAttribute("lat")), lo = Number(p.getAttribute("lon"));
      if (!isFinite(la) || !isFinite(lo)) return;
      var e = child(p, "ele"), t = child(p, "time");
      var em = e != null && e !== "" ? Number(e) : null, tm = t ? Date.parse(t) : null;
      if (line.length && dist(line[line.length - 1], [la, lo]) < 1) return;   // 止まっていた間の重複
      line.push([la, lo]); ele.push(em != null && isFinite(em) ? em : null); times.push(tm != null && isFinite(tm) ? tm : null);
      if (em != null && isFinite(em)) hasE = true;
      if (tm != null && isFinite(tm)) hasT = true;
    });
    if (line.length < 2) throw new Error("GPX の点が少なすぎます");
    // 点が多すぎると重いので間引く（形は保つ。最後の点は必ず残す）
    var MAX = 4000;
    if (line.length > MAX) {
      var k = Math.ceil(line.length / MAX), keep = function (_, i, a) { return i % k === 0 || i === a.length - 1; };
      line = line.filter(keep); ele = ele.filter(keep); times = times.filter(keep);
    }
    var nm = (nameEl && nameEl.textContent.trim()) || fname.replace(/\.gpx$/i, "");
    return { id: "gpx", source: "gpx", name: { ja: nm, en: nm }, traced: true, line: line,
             ele: hasE ? ele : null, times: hasT ? times : null, stops: [] };
  }

  // ------------------------------------------------------------------ EXIF（JPEG の GPS・撮影日時・時差）と動画
  function readExif(buf) {
    var v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
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
        tags[tag] = { type: type, cnt: cnt, off: cnt * size > 4 ? u32(e + 8) : e + 8 };
      }
      return tags;
    };
    var rat = function (o, i) { return u32(o + i * 8) / (u32(o + i * 8 + 4) || 1); };
    var str = function (x) { var s = ""; for (var i = 0; i < x.cnt - 1; i++) s += String.fromCharCode(v.getUint8(t + x.off + i)); return s; };
    var ifd0 = ifd(u32(4)), res = {};
    if (ifd0[0x8769]) {
      var ex = ifd(u32(ifd0[0x8769].off));   // Exif IFD（LONG 1 個なので項目の中に直接入っている）
      var dt = ex[0x9003] || ex[0x9004];
      if (dt) res.local = parseExifDate(str(dt));
      var ot = ex[0x9011] || ex[0x9010];      // OffsetTimeOriginal（"+02:00"）。iPhone などが書く
      if (ot) { var m = /^([+-])(\d{2}):(\d{2})$/.exec(str(ot)); if (m) res.offset = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000; }
    }
    if (res.local == null && ifd0[0x0132]) res.local = parseExifDate(str(ifd0[0x0132]));
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
  function parseExifDate(s) {   // 端末の現地時刻（時差は別）。「現地時刻をそのまま UTC として数えた値」で持つ
    var m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):?(\d{2})?/.exec(s || "");
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
  }
  function readVideoMeta(buf) {   // iPhone の .mov: ©xyz に位置、mvhd に作成時刻（UTC、1904 年起点の秒）
    var b = new Uint8Array(buf), res = {};
    for (var i = 0; i < b.length - 16; i++) {
      if (!res.gps && b[i] === 0xA9 && b[i + 1] === 0x78 && b[i + 2] === 0x79 && b[i + 3] === 0x7A) {
        var s = ""; for (var j = i + 4; j < Math.min(b.length, i + 64); j++) { var c = b[j]; if (c >= 0x2B && c <= 0x39 || c === 0x2F) s += String.fromCharCode(c); }
        var m = /([+-]\d+\.\d+)([+-]\d+\.\d+)/.exec(s);
        if (m) res.gps = [Number(m[1]), Number(m[2])];
      }
      if (!res.utc && b[i] === 0x6D && b[i + 1] === 0x76 && b[i + 2] === 0x68 && b[i + 3] === 0x64) {   // "mvhd"
        var dv = new DataView(buf, i + 4), ver = dv.getUint8(0);
        var secs = ver === 1 ? dv.getUint32(4) * 4294967296 + dv.getUint32(8) : dv.getUint32(4);
        if (secs > 2082844800) res.utc = (secs - 2082844800) * 1000;
      }
    }
    return res;
  }
  function headAndTail(file, n) {
    var parts = [file.slice(0, n)];
    if (file.size > n) parts.push(file.slice(Math.max(n, file.size - n)));
    return new Blob(parts).arrayBuffer();
  }

  // ------------------------------------------------------------------ 写真・動画の読み込み（何度でも足せる）
  async function addFiles(files) {
    status("読み込み中…");
    var added = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i], isVideo = /^video\//.test(f.type) || /\.(mov|mp4|m4v)$/i.test(f.name);
      var m = { file: f, kind: isVideo ? "video" : "image", name: f.name, url: URL.createObjectURL(f) };
      try {
        if (isVideo) {
          var vm = readVideoMeta(await headAndTail(f, 2 * 1024 * 1024));
          m.gps = vm.gps || null; m.utc = vm.utc || null;
          m.el = document.createElement("video");
          m.el.src = m.url; m.el.muted = true; m.el.playsInline = true; m.el.preload = "auto";
          await new Promise(function (ok) { m.el.onloadeddata = ok; m.el.onerror = ok; setTimeout(ok, 8000); });
          m.dur = Math.min(VIDEO_MAX_SEC, m.el.duration || VIDEO_MAX_SEC);
          m.thumb = videoThumb(m.el);
        } else {
          var ex = readExif(await f.slice(0, 256 * 1024).arrayBuffer()) || {};
          m.gps = ex.gps || null; m.local = ex.local != null ? ex.local : null; m.offset = ex.offset != null ? ex.offset : null;
          if (m.local != null && m.offset != null) m.utc = m.local - m.offset;
          m.img = await createImageBitmap(f);
          m.thumb = m.url;
        }
      } catch (e) {
        m.err = String(e && e.message || e);
      }
      if (!m.err) { media.push(m); added++; } else { failed.push(m); }
    }
    place();
    renderList();
    drawMarkers();
    updateView();
    status(added ? "地図に置きました。丸い写真を押すと大きく見られます。" : "読み込めるファイルがありませんでした。");
  }
  function videoThumb(el) {
    try {
      var c = document.createElement("canvas"); c.width = 96; c.height = 96;
      var s = Math.min(el.videoWidth, el.videoHeight) || 1;
      c.getContext("2d").drawImage(el, (el.videoWidth - s) / 2, (el.videoHeight - s) / 2, s, s, 0, 0, 96, 96);
      return c.toDataURL("image/jpeg", 0.8);
    } catch (e) { return ""; }
  }

  // 位置の決め方: ①写真の GPS ②撮影時刻と GPX の時刻 ③撮影時刻の順（目安）
  function guessTz() {
    // 撮影時刻に時差が書かれていない写真のために、時差を推定する。
    // GPS と時刻の両方がある写真があれば、その場所を通った GPX の時刻との差から決める（いちばん確か）
    if (!route.times) return null;
    var diffs = [];
    media.forEach(function (m) {
      if (m.gps && m.local != null && m.offset == null) {
        var p = project(m.gps, route); if (p.off > 1500) return;
        var t = timeAt(p.d); if (t != null) diffs.push(m.local - t);
      }
    });
    if (diffs.length) {
      diffs.sort(function (a, b) { return a - b; });
      return { ms: Math.round(diffs[diffs.length >> 1] / 900000) * 900000, how: "写真の位置と時刻から" };
    }
    // 無ければ、撮影時刻がいちばん多く GPX の時間内に収まる時差（15 分刻み）を選ぶ。同点なら経度に近い時差
    var naive = media.filter(function (m) { return m.local != null && m.offset == null; });
    if (!naive.length) return null;
    var t0 = route.times.find(function (x) { return x != null; }), t1 = route.times.slice().reverse().find(function (x) { return x != null; });
    var lonGuess = Math.round(route.line[0][1] / 15) * 3600000, best = null;
    for (var o = -12 * 3600000; o <= 14 * 3600000; o += 900000) {
      var n = naive.filter(function (m) { var u = m.local - o; return u >= t0 - 1800000 && u <= t1 + 1800000; }).length;
      var score = n * 1e9 - Math.abs(o - lonGuess) / 1000;
      if (!best || score > best.score) best = { ms: o, score: score, n: n };
    }
    return best.n ? { ms: best.ms, how: "撮影時刻と GPX の時間帯から推定" } : null;
  }
  function place() {
    if (!route) return;
    tz = guessTz();
    var rest = [];
    media.forEach(function (m) {
      m.placed = null; m.d = null; m.far = false;
      if (m.gps) {
        var p = project(m.gps, route);
        if (p.off < 3000) { m.d = p.d; m.placed = "gps"; m.off = p.off; return; }
        m.far = true;
      }
      var u = m.utc != null ? m.utc : (m.local != null && tz ? m.local - tz.ms : null);
      var d = u != null ? dAtTime(u) : null;
      if (d != null) { m.d = d; m.placed = "time"; return; }
      rest.push(m);
    });
    // 残り: 撮影時刻の順に、置けた写真のあいだへ挟む。何も無ければ等間隔（目安）
    var key = function (m) { return m.utc != null ? m.utc : m.local != null ? m.local : m.file.lastModified; };
    rest.sort(function (a, b) { return key(a) - key(b); });
    var anchors = media.filter(function (m) { return m.d != null; }).sort(function (a, b) { return key(a) - key(b); });
    rest.forEach(function (m, i) {
      var before = null, after = null;
      anchors.forEach(function (a) { if (key(a) <= key(m)) before = a; else if (!after) after = a; });
      if (before && after) m.d = (before.d + after.d) / 2;
      else if (before) m.d = Math.min(route.len * 0.97, before.d + route.len * 0.05);
      else if (after) m.d = Math.max(route.len * 0.03, after.d - route.len * 0.05);
      else m.d = route.len * (0.08 + 0.86 * (i + 1) / (rest.length + 1));
      m.placed = "order";
    });
    media.sort(function (a, b) { return a.d - b.d; });
  }
  function placeText(m) {
    var near = nearestStop(m.d), nearTxt = near && Math.abs(near.d - m.d) < 1500 ? "・" + near.name.ja + "付近" : "";
    if (m.placed === "gps") return "撮影地点に配置（道から " + Math.round(m.off) + "m）" + nearTxt;
    if (m.placed === "time") return "撮影時刻で GPX の通過地点に配置" + (m.utc == null && tz ? "（時差 " + fmtOffset(tz.ms) + "・" + tz.how + "）" : "") + nearTxt;
    return (m.far ? "位置が道から 3km 以上離れているため、" : "位置も時刻の手がかりも無いため、") + "撮影の順に配置（場所は目安）";
  }
  function fmtOffset(ms) { var s = ms < 0 ? "-" : "+", a = Math.abs(ms) / 60000; return s + Math.floor(a / 60) + ":" + String(a % 60).padStart(2, "0"); }
  function renderList() {
    var ol = $("fly-list"); ol.innerHTML = "";
    media.concat(failed).forEach(function (m) {
      var li = document.createElement("li");
      var th = document.createElement("img"); th.alt = ""; if (m.thumb) th.src = m.thumb;
      li.appendChild(th);
      var t = document.createElement("div"); t.innerHTML = "<span></span><small></small>";
      t.firstChild.textContent = m.name; t.lastChild.textContent = m.err ? "読めませんでした（" + m.err + "）" : placeText(m);
      li.appendChild(t); ol.appendChild(li);
    });
  }

  // ------------------------------------------------------------------ 地図
  function initMap() {
    map = new maplibregl.Map({
      container: "fly-map", attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      maxPitch: 80, fadeDuration: 0,
      style: {
        version: 8,
        sources: {
          photo: { type: "raster", tiles: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 18,
                   attribution: "国土地理院" },
          // 地理院の標高 PNG: 標高 = (R×2^16 + G×2^8 + B) × 0.01 m
          dem: { type: "raster-dem", tiles: ["https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 14,
                 encoding: "custom", redFactor: 655.36, greenFactor: 2.56, blueFactor: 0.01, baseShift: 0 }
        },
        layers: [{ id: "photo", type: "raster", source: "photo", paint: { "raster-saturation": 0.1, "raster-contrast": 0.08 } }],
        sky: { "sky-color": "#9cc3e4", "horizon-color": "#e8eef2", "fog-color": "#dde6ea", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.85 }
      },
      center: [137.69, 36.36], zoom: 11, pitch: 0
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
    // 再生中に地図を触ったら止める（見たい所を自由に回せるように）
    // 毎コマ jumpTo で動かしているため、地図の dragstart は出る前に打ち消されることがある。触れた瞬間に止める
    ["pointerdown", "wheel", "touchstart"].forEach(function (ev) {
      $("fly-map").addEventListener(ev, function () { if (player.playing) pause(); }, { passive: true, capture: true });
    });
    return new Promise(function (ok) { map.on("load", ok); });
  }
  function setRouteOnMap() {
    var gj = { type: "Feature", geometry: { type: "LineString", coordinates: route.line.map(function (p) { return [p[1], p[0]]; }) } };
    if (map.getSource("route")) { map.getSource("route").setData(gj); return; }
    map.addSource("route", { type: "geojson", data: gj });
    map.addLayer({ id: "route-halo", type: "line", source: "route", paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.85 }, layout: { "line-join": "round", "line-cap": "round" } });
    map.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#E4572E", "line-width": 3.5 }, layout: { "line-join": "round", "line-cap": "round" } });
  }
  async function loadHuts() {
    if (huts) return huts;
    try { huts = await (await fetch(BASE + "/data/huts.json")).json(); } catch (e) { huts = []; }
    return huts;
  }
  async function nearbyHuts() {
    // GPX のときだけ、道の近くの HutsGo の小屋を「通過点」として持つ（HutsGo のルートは routes.json の小屋・登山口を使う）
    if (route.source !== "gpx") return;
    var list = await loadHuts();
    route.stops = list.map(function (h) {
      var loc = h.location || {}; if (loc.lat == null) return null;
      var p = project([loc.lat, loc.lon], route);
      return p.off <= HUT_NEAR_M ? { id: h.id, kind: "hut", name: h.name, lat: loc.lat, lon: loc.lon, elev: loc.elevation_m, d: p.d } : null;
    }).filter(Boolean);
  }
  var markers = [], hereMarker = null;
  function clearMarkers() { markers.forEach(function (mk) { mk.remove(); }); markers = []; hereMarker = null; }
  function drawMarkers() {
    clearMarkers();
    (route.stops || []).filter(function (s) { return s.kind === "hut"; }).forEach(function (s) {
      var a = document.createElement("a");
      a.className = "fly-hut"; a.textContent = s.name.ja; a.href = BASE + "/huts/" + s.id + "/"; a.target = "_blank"; a.rel = "noopener";
      a.title = "HutsGo の小屋ページ（営業期間・予約の窓口）";
      markers.push(new maplibregl.Marker({ element: a, anchor: "bottom" }).setLngLat([s.lon, s.lat]).addTo(map));
    });
    media.forEach(function (m) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "fly-thumb" + (m.kind === "video" ? " is-video" : "");
      if (m.thumb) b.style.backgroundImage = "url(" + JSON.stringify(m.thumb) + ")";
      b.setAttribute("aria-label", m.name + " を大きく見る");
      b.addEventListener("click", function (e) { e.stopPropagation(); pause(); setD(m.d, true); openPopup(m); });
      var p = at(route, m.d);
      markers.push(new maplibregl.Marker({ element: b, anchor: "bottom", offset: [0, -8] }).setLngLat([p[1], p[0]]).addTo(map));
    });
    var here = document.createElement("div"); here.className = "fly-here";
    var p0 = at(route, player.d);
    hereMarker = new maplibregl.Marker({ element: here }).setLngLat([p0[1], p0[0]]).addTo(map);
    markers.push(hereMarker);
  }

  async function overview() {   // 道全体を見せ、そのあいだに標高の断面を測る（GPX に標高があればそれを使う）
    map.setTerrain(null);
    var b = new maplibregl.LngLatBounds();
    route.line.forEach(function (p) { b.extend([p[1], p[0]]); });
    map.fitBounds(b, { padding: { top: 90, bottom: 230, left: 40, right: 40 }, duration: 0, pitch: 0, bearing: 0 });
    map.setTerrain({ source: "dem", exaggeration: 1 });
    await settle(8000);
    if (!route.ele) {
      var N = 160, prof = [];
      for (var i = 0; i <= N; i++) {
        var p = at(route, route.len * i / N), e = map.queryTerrainElevation([p[1], p[0]]);
        prof.push(e == null ? null : e);
      }
      route.profile = prof.some(function (x) { return x != null; }) ? prof : null;
    }
    map.setTerrain({ source: "dem", exaggeration: EXAG });
    map.easeTo({ pitch: 55, bearing: -15, duration: 900 });
  }
  var timeouts = 0;
  function settle(ms) {   // 地形と航空写真の読み込みが済むまで待つ。打ち切ったら数える（崩れたコマが混ざった印）
    return new Promise(function (ok) {
      var done = false, fin = function (byTimeout) { if (!done) { done = true; if (byTimeout) timeouts++; ok(); } };
      map.once("idle", function () { fin(false); }); setTimeout(function () { fin(true); }, ms); map.triggerRepaint();
    });
  }

  // ------------------------------------------------------------------ 画面の再生（スライドバー・断面図・写真の小窓）
  var player = { d: 0, playing: false, hold: null, last: null, followBearing: null };
  function setD(d, moveCamera) {
    player.d = Math.max(0, Math.min(route.len, d));
    $("fly-seek").value = String(Math.round(player.d / route.len * 1000));
    var p = at(route, player.d);
    if (hereMarker) hereMarker.setLngLat([p[1], p[0]]);
    if (moveCamera) map.jumpTo({ center: [p[1], p[0]] });
    updateView();
  }
  function play() {
    if (player.d >= route.len - 1) setD(0, true);
    player.playing = true; player.last = null; player.followBearing = null; closePopup();
    $("fly-play").classList.add("is-playing"); $("fly-play").setAttribute("aria-label", "一時停止");
    requestAnimationFrame(step);
  }
  function pause() {
    player.playing = false; player.hold = null;
    $("fly-play").classList.remove("is-playing"); $("fly-play").setAttribute("aria-label", "再生");
  }
  function step(now) {
    if (!player.playing) return;
    var dt = player.last == null ? 0 : Math.min(0.1, (now - player.last) / 1000);
    player.last = now;
    if (player.hold) {
      if (now < player.hold.until) { requestAnimationFrame(step); return; }
      player.hold = null; closePopup();
    }
    var v = route.len / PLAY_SEC, d0 = player.d, d1 = Math.min(route.len, d0 + v * dt);
    var hit = media.find(function (m) { return m.d > d0 && m.d <= d1; });
    if (hit) d1 = hit.d;
    setD(d1, false);
    // カメラは進む向きに少しずつ回しながらついていく（ズームと傾きは触った値のまま）
    var b = bearing(at(route, d1 - 300), at(route, d1 + 900));
    if (player.followBearing == null) player.followBearing = map.getBearing();
    var diff = ((b - player.followBearing + 540) % 360) - 180;
    player.followBearing = (player.followBearing + diff * 0.03 + 360) % 360;
    var p = at(route, d1);
    map.jumpTo({ center: [p[1], p[0]], bearing: player.followBearing });
    if (hit) { openPopup(hit); player.hold = { until: now + (hit.kind === "video" ? Math.max(3, hit.dur) : 3) * 1000 }; }
    if (d1 >= route.len) { pause(); return; }
    requestAnimationFrame(step);
  }
  function openPopup(m) {
    var box = $("fly-popup-media"); box.innerHTML = "";
    var el;
    if (m.kind === "video") { el = document.createElement("video"); el.src = m.url; el.controls = true; el.muted = true; el.playsInline = true; el.autoplay = true; }
    else { el = document.createElement("img"); el.src = m.url; el.alt = m.name; }
    box.appendChild(el);
    var t = m.utc != null ? m.utc : (m.local != null && tz ? m.local - tz.ms : null);
    $("fly-popup-cap").textContent = (t != null ? fmtDate(t) + " " + fmtClock(t) + "・" : m.local != null ? fmtClockNaive(m.local) + "・" : "") + placeText(m);
    $("fly-popup").hidden = false;
  }
  function closePopup() {
    $("fly-popup").hidden = true;
    var v = $("fly-popup-media").querySelector("video"); if (v) v.pause();
  }
  // 日時の表示は「その山行の現地時刻」。時差は写真から推定したもの、無ければ端末の時差
  function localMs(utc) { return utc + (tz ? tz.ms : -new Date(utc).getTimezoneOffset() * 60000); }
  function fmtDate(utc) { var d = new Date(localMs(utc)); return d.getUTCFullYear() + "/" + String(d.getUTCMonth() + 1).padStart(2, "0") + "/" + String(d.getUTCDate()).padStart(2, "0") + "(" + JA_DOW[d.getUTCDay()] + ")"; }
  function fmtClock(utc) { var d = new Date(localMs(utc)); return d.getUTCHours() + ":" + String(d.getUTCMinutes()).padStart(2, "0"); }
  function fmtClockNaive(local) { var d = new Date(local); return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + " " + d.getUTCHours() + ":" + String(d.getUTCMinutes()).padStart(2, "0"); }
  function fmtDur(ms) { var m = Math.round(ms / 60000); return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m"; }
  function fmtDist(d) { return d < 1000 ? Math.round(d) + " m" : (d / 1000).toFixed(1) + " km"; }
  function updateView() {
    if (!route) return;
    var d = player.d, t = timeAt(d), t0 = route.times ? route.times.find(function (x) { return x != null; }) : null;
    $("fly-st-time").textContent = t != null && t0 != null ? fmtDur(t - t0) : "—";
    var e = eleAt(d);
    $("fly-st-elev").textContent = e != null ? Math.round(e).toLocaleString() + " m" : "—";
    $("fly-st-dist").textContent = fmtDist(d);
    $("fly-date").textContent = t != null ? fmtDate(t) : route.name.ja;
    $("fly-clock").textContent = t != null ? fmtClock(t) : "";
    var s = nearestStop(d);
    $("fly-place").textContent = s && Math.abs(s.d - d) < 600 ? s.name.ja + (Math.abs(s.d - d) > 150 ? " 付近" : "") : "";
    drawProfileTo($("fly-profile").getContext("2d"), 640, 120, d, false);
  }
  function profileValues() {
    var N = 160, vals = [];
    for (var i = 0; i <= N; i++) vals.push(eleAt(route.len * i / N));
    return vals.some(function (x) { return x != null; }) ? vals : null;
  }
  function drawProfileTo(c, w, h, d, forVideo) {
    if (!forVideo) c.clearRect(0, 0, w, h);   // 動画の合成では消さない（透明が白として符号化される）
    var prof = route._pv || (route._pv = profileValues());
    if (!prof) return;
    var vals = prof.filter(function (v) { return v != null; }), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = forVideo ? 0 : 6, Y = function (v) { return h - pad - (v - lo) / ((hi - lo) || 1) * (h - pad * 2 - (forVideo ? 0 : 8)); };
    var X = function (i) { return i / (prof.length - 1) * w; }, k = d / route.len * (prof.length - 1);
    var path = function () { c.beginPath(); c.moveTo(0, h); prof.forEach(function (v, i) { c.lineTo(X(i), Y(v == null ? lo : v)); }); c.lineTo(w, h); c.closePath(); };
    path(); c.fillStyle = forVideo ? "rgba(255,255,255,.22)" : "#E6ECE8"; c.fill();
    c.save(); c.beginPath(); c.rect(0, 0, d / route.len * w, h); c.clip(); path(); c.fillStyle = forVideo ? "rgba(255,255,255,.45)" : "#9DB8A7"; c.fill(); c.restore();
    c.beginPath(); prof.forEach(function (v, i) { var y = Y(v == null ? lo : v); if (i) c.lineTo(X(i), y); else c.moveTo(X(i), y); });
    c.strokeStyle = forVideo ? "rgba(255,255,255,.9)" : "#2E6B4A"; c.lineWidth = forVideo ? 3 : 2.5; c.stroke();
    media.forEach(function (m) { c.fillStyle = forVideo ? "rgba(255,255,255,.8)" : "#2F80ED"; c.fillRect(m.d / route.len * w - 2, h - 10, 4, 10); });
    var cy = Y(prof[Math.round(k)] == null ? lo : prof[Math.round(k)]);
    c.beginPath(); c.arc(d / route.len * w, cy, forVideo ? 9 : 7, 0, Math.PI * 2); c.fillStyle = "#E4572E"; c.fill();
    c.lineWidth = 3; c.strokeStyle = "#fff"; c.stroke();
  }

  // ------------------------------------------------------------------ 書き出し（縦長の動画）
  function timeline() {
    var v = route.len / FLY_SEC, ev = [], t = 1.6, d = 0;
    ev.push({ kind: "intro", t0: 0, t1: t });
    media.forEach(function (m) {
      var dt = (m.d - d) / v;
      if (dt > 0) { ev.push({ kind: "fly", t0: t, t1: t + dt, d0: d, d1: m.d }); t += dt; d = m.d; }
      var hold = m.kind === "video" ? m.dur : PHOTO_SEC;
      ev.push({ kind: "photo", t0: t, t1: t + hold, d0: d, d1: d, m: m }); t += hold;
    });
    var rest = (route.len - d) / v;
    ev.push({ kind: "fly", t0: t, t1: t + rest, d0: d, d1: route.len }); t += rest;
    ev.push({ kind: "outro", t0: t, t1: t + 2.2, d0: route.len, d1: route.len }); t += 2.2;
    return { ev: ev, total: t };
  }
  function ease(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
  var smoothBearing = null;
  function cameraAt(tl, t) {
    var e = tl.ev.find(function (x) { return t >= x.t0 && t < x.t1; }) || tl.ev[tl.ev.length - 1];
    var f = (t - e.t0) / ((e.t1 - e.t0) || 1);
    var d = e.kind === "intro" ? 0 : e.kind === "fly" ? e.d0 + (e.d1 - e.d0) * f : e.d0;
    var b = bearing(at(route, d - 300), at(route, d + 900));
    if (smoothBearing === null) smoothBearing = b;
    var diff = ((b - smoothBearing + 540) % 360) - 180;
    smoothBearing = (smoothBearing + diff * 0.04 + 360) % 360;
    var c = at(route, d);   // at() は [緯度, 経度]。MapLibre の center は [経度, 緯度]
    var cam = { center: [c[1], c[0]], bearing: smoothBearing, pitch: PITCH, zoom: Z };
    if (e.kind === "intro") { var k = ease(f); cam.pitch = 20 + (PITCH - 20) * k; cam.zoom = 11.4 + (Z - 11.4) * k; }
    if (e.kind === "photo") cam.bearing = smoothBearing + 10 * Math.sin(f * Math.PI);
    if (e.kind === "outro") { var o = ease(f); cam.zoom = Z - 1.6 * o; cam.pitch = PITCH - 14 * o; cam.bearing = smoothBearing + 40 * o; }
    return { cam: cam, e: e, f: f, d: d };
  }
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function text(s, x, y, size, weight, color, align) {
    ctx.font = (weight || 600) + " " + size + "px system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif";
    ctx.textAlign = align || "left"; ctx.fillStyle = color || "#fff";
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 8; ctx.fillText(s, x, y); ctx.shadowBlur = 0;
  }
  function compose(st) {
    var sky = ctx.createLinearGradient(0, 0, 0, H * 0.55);
    sky.addColorStop(0, "#6f9fcb"); sky.addColorStop(1, "#dfe8ee");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(map.getCanvas(), 0, 0, W, H);
    // 道の上の写真（丸い小窓）。地図の点を画面の位置に直して描く
    var sc = W / map.getContainer().clientWidth;
    media.forEach(function (m) {
      var p = at(route, m.d), q = map.project([p[1], p[0]]);
      if (q.x < -40 || q.y < -40 || q.x > W / sc + 40 || q.y > H / sc + 40) return;
      var x = q.x * sc, y = q.y * sc - 60, r = 42;
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 10; ctx.fill(); ctx.restore();
      ctx.beginPath(); ctx.moveTo(x - 9, y + r + 2); ctx.lineTo(x + 9, y + r + 2); ctx.lineTo(x, y + r + 16); ctx.closePath(); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
      var src = m.img || m.el, sw = m.img ? m.img.width : m.el.videoWidth, sh = m.img ? m.img.height : m.el.videoHeight;
      if (sw && sh) { var s = Math.max(2 * r / sw, 2 * r / sh); ctx.drawImage(src, x - sw * s / 2, y - sh * s / 2, sw * s, sh * s); }
      ctx.restore();
    });
    var g = ctx.createLinearGradient(0, 0, 0, 280); g.addColorStop(0, "rgba(0,0,0,.55)"); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, 280);
    g = ctx.createLinearGradient(0, H - 380, 0, H); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.65)");
    ctx.fillStyle = g; ctx.fillRect(0, H - 380, W, 380);
    var t = timeAt(st.d);
    if (t != null) { text(fmtDate(t), W / 2, 70, 30, 500, "#fff", "center"); text(fmtClock(t), W / 2, 140, 66, 700, "#fff", "center"); }
    else text(route.name.ja, 40, 86, 38, 700);
    var s = nearestStop(st.d);
    if (s && Math.abs(s.d - st.d) < 1500) text((s.elev ? s.elev.toLocaleString() + "m  " : "") + s.name.ja + (Math.abs(s.d - st.d) > 400 ? " 付近" : ""), t != null ? W / 2 : 40, t != null ? 190 : 136, 28, 500, "#f2f2f2", t != null ? "center" : "left");
    if (st.e.kind === "photo") drawPhoto(st.e.m, st.f);
    // 下: 経過時間・標高・距離と断面図
    var t0 = route.times ? route.times.find(function (x) { return x != null; }) : null, e = eleAt(st.d);
    var stats = [t != null && t0 != null ? fmtDur(t - t0) : null, e != null ? Math.round(e).toLocaleString() + " m" : null, fmtDist(st.d)].filter(Boolean).join("   ");
    text(stats, 40, H - 232, 34, 700);
    ctx.save(); ctx.translate(40, H - 205); drawProfileTo(ctx, W - 80, 120, st.d, true); ctx.restore();
    text("hutsgo.com", 40, H - 40, 24, 600, "#fff");
    text("地図: 国土地理院", W - 40, H - 40, 20, 500, "rgba(255,255,255,.85)", "right");
  }
  function drawPhoto(m, f) {
    var a = Math.min(1, f * 6, (1 - f) * 6), sc = 0.94 + 0.06 * Math.min(1, f * 5);
    var src = m.kind === "video" ? m.el : m.img;
    var sw = m.kind === "video" ? m.el.videoWidth : m.img.width, sh = m.kind === "video" ? m.el.videoHeight : m.img.height;
    if (!sw || !sh) return;
    var bw = 600 * sc, bh = Math.min(760, bw * sh / sw) * sc, x = (W - bw) / 2, y = 250 + (760 - bh) / 2;
    ctx.save(); ctx.globalAlpha = a;
    ctx.shadowColor = "rgba(0,0,0,.4)"; ctx.shadowBlur = 30;
    rr(x - 10, y - 10, bw + 20, bh + 20, 22); ctx.fillStyle = "#fff"; ctx.fill(); ctx.shadowBlur = 0;
    rr(x, y, bw, bh, 14); ctx.clip();
    var r = Math.max(bw / sw, bh / sh), dw = sw * r, dh = sh * r;
    ctx.drawImage(src, x + (bw - dw) / 2, y + (bh - dh) / 2, dw, dh);
    ctx.restore();
  }
  var FPS = Number(Q.get("fps")) || 30;
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
    var failedEnc = null;
    var enc = new VideoEncoder({ output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); }, error: function (e) { failedEnc = e; } });
    enc.configure(config);
    media.forEach(function (m) { if (m.el) m.el.pause(); });
    smoothBearing = null; timeouts = 0;
    var tl = timeline(), N = Math.ceil(tl.total * FPS);
    for (var i = 0; i < N; i++) {
      var t = i / FPS, st = cameraAt(tl, t);
      map.jumpTo(st.cam);
      await settle(15000);
      if (st.e.kind === "photo" && st.e.m.kind === "video") await seek(st.e.m.el, t - st.e.t0);
      compose(st);
      var vf = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: i % (FPS * 2) === 0 });
      vf.close();
      if (failedEnc) throw failedEnc;
      if (enc.encodeQueueSize > 8) await new Promise(function (ok) { setTimeout(ok, 0); });
      if (i % 5 === 0) status("書き出し中… " + Math.round(i / N * 100) + "%（1 コマずつ組み立てています。このページを開いたままにしてください）");
    }
    await enc.flush();
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), sec: tl.total, frames: N, timeouts: timeouts,
             mime: "video/mp4（" + config.codec + "・1 コマずつ・" + FPS + "fps）" + (timeouts ? "・読み込み待ちを打ち切ったコマ " + timeouts : "") };
  }
  function recordRealtime() {   // WebCodecs の無い端末の控え: 実時間で録る（読み込みが遅いと崩れたコマが混ざる）
    return new Promise(function (resolve) {
      smoothBearing = null;
      var tl = timeline(), start = null, chunks = [];
      var mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find(function (m) {
        return window.MediaRecorder && MediaRecorder.isTypeSupported(m); }) || "";
      var rec = new MediaRecorder(out.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
      rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
      rec.onstop = function () { resolve({ blob: new Blob(chunks, { type: rec.mimeType || mime }), mime: (rec.mimeType || mime) + "（実時間で録画）", sec: tl.total }); };
      rec.start(500);
      function tick(now) {
        if (start === null) start = now;
        var t = (now - start) / 1000, st = cameraAt(tl, Math.min(t, tl.total - 0.001));
        map.jumpTo(st.cam);
        if (st.e.kind === "photo" && st.e.m.kind === "video" && st.e.m.el.paused) { st.e.m.el.currentTime = 0; st.e.m.el.play().catch(function () {}); }
        map.once("render", function () { compose(st); }); map.triggerRepaint();
        status("録画中… " + Math.min(100, Math.round(t / tl.total * 100)) + "%");
        if (t < tl.total) requestAnimationFrame(tick); else setTimeout(function () { rec.stop(); }, 300);
      }
      requestAnimationFrame(tick);
    });
  }
  async function exportVideo() {
    if (busy) return;
    busy = true; pause(); closePopup(); $("fly-record").disabled = true;
    var phone = document.querySelector(".fly-phone"), keep = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    markers.forEach(function (mk) { mk.getElement().style.visibility = "hidden"; });
    try {
      // 書き出しの間だけ、地図を 360×640 の 2 倍（720×1280）に固定する
      phone.classList.add("is-exporting"); map.setPixelRatio(W / 360); map.resize();
      if (!media.length) status("写真が無いので、道だけを飛びます。");
      var res = await encodeFrames();
      if (!res) {
        status("この端末は 1 コマずつの書き出しに対応していないため、実時間で録画します…");
        res = await recordRealtime();
      }
      var url = URL.createObjectURL(res.blob), ext = /mp4/.test(res.mime) ? "mp4" : "webm";
      $("fly-video").src = url;
      $("fly-download").href = url; $("fly-download").download = "hutsgo-" + (route.source === "gpx" ? "gpx" : route.id) + "." + ext;
      $("fly-format").textContent = "形式: " + res.mime + "・約 " + Math.round(res.sec) + " 秒・" + (res.blob.size / 1048576).toFixed(1) + "MB"
        + (ext === "webm" ? "（この端末では MP4 で録れませんでした。Instagram などに上げるときは MP4 への変換が要ることがあります）" : "");
      $("fly-result").hidden = false;
      status("できました。");
      track("flyover_export");
    } catch (e) {
      status("うまく動きませんでした: " + (e && e.message || e));
    }
    phone.classList.remove("is-exporting"); map.setPixelRatio(window.devicePixelRatio || 1); map.resize();
    map.jumpTo(keep);
    markers.forEach(function (mk) { mk.getElement().style.visibility = ""; });
    busy = false; $("fly-record").disabled = false;
  }
  function track(ev) {
    var api = (document.querySelector('meta[name="hutsgo-api"]') || {}).content;
    if (api && navigator.sendBeacon) {
      navigator.sendBeacon(api + "/track.php", new Blob([JSON.stringify({ ev: ev, lang: "ja", hut: "", trail: route.source === "gpx" ? "" : route.id, page: location.pathname, ref: "" })], { type: "text/plain" }));
    }
  }

  // ------------------------------------------------------------------ 起動
  async function useRoute(r) {
    pause(); closePopup();
    route = prepRoute(r); route._pv = null; route.profile = null; player.d = 0;
    await nearbyHuts();
    setRouteOnMap();
    place(); renderList(); drawMarkers();
    status("地形を読み込んでいます…");
    await overview();
    route._pv = null;
    setD(0, false);
    var hutsNear = (route.stops || []).filter(function (s) { return s.kind === "hut"; }).length;
    status(route.source === "gpx"
      ? "GPX を読み込みました（" + fmtDist(route.len) + (route.times ? "・時刻あり" : "・時刻なし") + (route.ele ? "・標高あり" : "") + "）。"
        + (hutsNear ? "道の近くの小屋 " + hutsNear + " 軒をピンで出しています。" : "")
      : "▶ で再生、下のバーや断面図で道の途中へ移動できます。");
  }
  async function boot() {
    if (!window.maplibregl) { status("地図の部品を読み込めませんでした。通信を確かめてください。"); return; }
    routes = await (await fetch(BASE + "/lab/flyover/routes.json")).json();
    var sel = $("fly-route");
    var blank = document.createElement("option"); blank.value = ""; blank.textContent = "（GPX を使う）"; blank.disabled = true; sel.appendChild(blank);
    routes.forEach(function (r) {
      var o = document.createElement("option"); o.value = r.id;
      o.textContent = r.name.ja + (r.traced ? "" : "（線は目安）"); sel.appendChild(o);
    });
    var want = Q.get("route") || "omote_ginza";
    sel.value = routes.some(function (r) { return r.id === want; }) ? want : routes[0].id;
    status("地図を準備しています…");
    await initMap();
    await useRoute(routes.find(function (r) { return r.id === sel.value; }));
    sel.addEventListener("change", function () { $("fly-gpx").value = ""; useRoute(routes.find(function (r) { return r.id === sel.value; })); });
    $("fly-gpx").addEventListener("change", async function (e) {
      var f = e.target.files[0]; if (!f) return;
      try { await useRoute(parseGpx(await f.text(), f.name)); sel.value = ""; }
      catch (err) { status("GPX を読めませんでした: " + (err && err.message || err)); }
    });
    $("fly-files").addEventListener("change", function (e) { addFiles(Array.prototype.slice.call(e.target.files)); e.target.value = ""; });
    $("fly-add").addEventListener("click", function () { $("fly-files").click(); });
    $("fly-play").addEventListener("click", function () { if (player.playing) pause(); else play(); });
    $("fly-seek").addEventListener("input", function (e) { pause(); setD(Number(e.target.value) / 1000 * route.len, true); });
    var prof = $("fly-profile"), dragging = false;
    var seekProfile = function (ev) { var r = prof.getBoundingClientRect(); pause(); setD((ev.clientX - r.left) / r.width * route.len, true); };
    prof.addEventListener("pointerdown", function (ev) { dragging = true; prof.setPointerCapture(ev.pointerId); seekProfile(ev); });
    prof.addEventListener("pointermove", function (ev) { if (dragging) seekProfile(ev); });
    prof.addEventListener("pointerup", function () { dragging = false; });
    $("fly-popup-close").addEventListener("click", closePopup);
    $("fly-record").addEventListener("click", exportVideo);
    window.HutsGoFlyover = {
      map: map, setD: function (d) { setD(d, true); }, play: play, pause: pause,
      state: function () {
        return { route: route.id, source: route.source, len: route.len, d: player.d, playing: player.playing, tz: tz && tz.ms,
                 hutsNear: (route.stops || []).filter(function (s) { return s.kind === "hut"; }).map(function (s) { return s.id; }),
                 media: media.map(function (m) { return { name: m.name, placed: m.placed, d: m.d }; }), profile: !!(route.ele || route.profile),
                 stats: [$("fly-st-time").textContent, $("fly-st-elev").textContent, $("fly-st-dist").textContent], date: $("fly-date").textContent, clock: $("fly-clock").textContent,
                 popup: !$("fly-popup").hidden, thumbs: document.querySelectorAll(".fly-thumb").length };
      }
    };
  }
  boot();
})();
