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
    // カメラ用のならした軌道: 50m おきに並べ直し、前後 500m で平均する（細かいくねりでカメラが揺れない）
    var raw = [], STEP = 50;
    for (var d = 0; d <= r.len; d += STEP) raw.push(at(r, d));
    var W2 = 10, rail = raw.map(function (_, i) {
      var la = 0, lo = 0, n = 0;
      for (var j = Math.max(0, i - W2); j <= Math.min(raw.length - 1, i + W2); j++) { la += raw[j][0]; lo += raw[j][1]; n++; }
      return [la / n, lo / n];
    });
    r.rail = rail; r.railStep = STEP;
    return r;
  }
  function railAt(d) {
    var rl = route.rail, x = Math.max(0, Math.min(rl.length - 1, d / route.railStep)), i = Math.floor(x), f = x - i, b = rl[Math.min(rl.length - 1, i + 1)];
    return [rl[i][0] + (b[0] - rl[i][0]) * f, rl[i][1] + (b[1] - rl[i][1]) * f];
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
  function nearestStop(d) {   // 小屋・登山口と山頂のうち、道の上でいちばん近いもの
    var s = null;
    (route.stops || []).concat(route.peaks || []).forEach(function (x) { if (!s || Math.abs(x.d - d) < Math.abs(s.d - d)) s = x; });
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
      // 撮影した向き（GPSImgDirection）。磁北基準（M）なら日本の偏角ぶん（西に約 8 度）直して真北基準にする
      if (g[0x11]) {
        var dir = rat(g[0x11].off, 0), ref = g[0x10] ? String.fromCharCode(v.getUint8(t + g[0x10].off)) : "T";
        if (isFinite(dir)) res.dir = ((ref === "M" ? dir - 8 : dir) + 360) % 360;
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
          m.gps = ex.gps || null; m.dir = ex.dir != null ? ex.dir : null; m.local = ex.local != null ? ex.local : null; m.offset = ex.offset != null ? ex.offset : null;
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
      t.firstChild.textContent = m.name; t.lastChild.textContent = m.err ? "読めませんでした（" + m.err + "）" : placeText(m) + (m.dir != null ? "・撮影方向あり" : "");
      li.appendChild(t);
      if (!m.err) {
        var star = document.createElement("button");
        star.type = "button"; star.className = "fly-star" + (m.star ? " is-on" : ""); star.dataset.star = String(media.indexOf(m));
        star.textContent = m.star ? "★" : "☆"; star.setAttribute("aria-label", "冒頭に使う"); star.setAttribute("aria-pressed", String(!!m.star));
        li.appendChild(star);
      }
      ol.appendChild(li);
    });
  }

  // ------------------------------------------------------------------ タイルの先読み（読み込みの遅れ・灰色の抜け対策）
  // 地理院のタイルには保存期間の指定が無く、ブラウザの保存は当てにできない。そこで地図のタイルを自前の保存庫（gsic://）
  // 経由で読み、①ルートを開いたら道の周りの粗い写真と標高、②再生中は現在地から先 3.5km の細かい写真を先に取っておく。
  // 粗い写真が手元にあれば、細かい写真が間に合わなくても灰色にならず、ぼやけた写真が出る
  var store = new Map(), STORE_MAX = 2500, queue = [], inflight = 0, PREFETCH_PAR = 4;
  function getTile(url) {
    if (store.has(url)) { var hit = store.get(url); store.delete(url); store.set(url, hit); return hit; }   // 使ったものを新しい側へ
    var pr = fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); });
    pr.catch(function () { store.delete(url); });
    store.set(url, pr);
    if (store.size > STORE_MAX) store.delete(store.keys().next().value);
    return pr;
  }
  if (window.maplibregl && maplibregl.addProtocol) {
    maplibregl.addProtocol("gsic", function (params) {
      return getTile(params.url.replace(/^gsic:\/\//, "https://")).then(function (buf) { return { data: buf }; });
    });
  }
  var TILE = { photo: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", dem: "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png" };
  function tileXY(lat, lon, z) {
    var n = Math.pow(2, z);
    return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(lat * rad) + 1 / Math.cos(lat * rad)) / Math.PI) / 2 * n)];
  }
  function pump() {
    // 画面に要るタイルを読んでいる間は先読みしない（遅い回線で取り合うと、今見ている所が遅れる）
    if (map && map.loaded() && !map.areTilesLoaded()) { setTimeout(pump, 300); return; }
    while (inflight < PREFETCH_PAR && queue.length) {
      var url = queue.shift();
      if (store.has(url)) continue;
      inflight++;
      getTile(url).catch(function () {}).then(function () { inflight--; pump(); });
    }
  }
  // 道の d0〜d1 の区間について、zoom z のタイルを、道の点から r タイル以内まで先読みの列に足す（先に足したものから取る）
  function want(kind, z, d0, d1, r) {
    var seen = {}, step = 40075000 * Math.cos(at(route, d0)[0] * rad) / Math.pow(2, z) / 2;
    for (var d = Math.max(0, d0); d <= Math.min(route.len, d1) + step; d += step) {
      var p = at(route, Math.min(d, route.len)), t = tileXY(p[0], p[1], z);
      for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) {
        var key = (t[0] + dx) + "/" + (t[1] + dy);
        if (seen[key]) continue;
        seen[key] = true;
        var url = TILE[kind].replace("{z}", z).replace("{x}", t[0] + dx).replace("{y}", t[1] + dy);
        if (!store.has(url) && queue.indexOf(url) < 0) queue.push(url);
      }
    }
    pump();
  }
  function prefetchBase() {   // ルートを開いたとき: 標高と、下敷きの粗い写真を道全体で（数十枚）
    queue = [];
    [9, 10, 11, 12].forEach(function (z) { want("dem", z, 0, route.len, 1); });
    [10, 11, 12, 13].forEach(function (z) { want("photo", z, 0, route.len, 1); });
  }
  var lastAhead = -1e9;
  function prefetchAhead(d) {   // 再生中: 現在地から先 3.5km の細かい写真（500m 進むごとに足す）
    if (Math.abs(d - lastAhead) < 500) return;
    lastAhead = d;
    want("photo", 14, d, d + 4000, 1);
    want("photo", 15, d, d + 2000, 0);
  }

  // ------------------------------------------------------------------ 地図
  function initMap() {
    map = new maplibregl.Map({
      container: "fly-map", attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      // ちらつき対策: 切り替えをフェードでなめらかにし、細かさの違うタイルを多めに持っておく。画素比は 2 まで（3 だと重くてカクつく）
      maxPitch: 80, fadeDuration: 250, maxTileCacheZoomLevels: 8, pixelRatio: Math.min(2, window.devicePixelRatio || 1),
      style: {
        version: 8,
        sources: {
          photo: { type: "raster", tiles: ["gsic://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 16,
                   attribution: "国土地理院" },
          // 地理院の標高 PNG: 標高 = (R×2^16 + G×2^8 + B) × 0.01 m
          // 標高は z12 まで（約 30m 格子）。z14 まで使うと動くたびに地形の細かさが切り替わって山がちらつく
          dem: { type: "raster-dem", tiles: ["gsic://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 12,
                 encoding: "custom", redFactor: 655.36, greenFactor: 2.56, blueFactor: 0.01, baseShift: 0 },
          "photo-lo": { type: "raster", tiles: ["gsic://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 13 },
          "dem-hs": { type: "raster-dem", tiles: ["gsic://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 12,
                      encoding: "custom", redFactor: 655.36, greenFactor: 2.56, blueFactor: 0.01, baseShift: 0 },
          world: { type: "geojson", data: { type: "Feature", geometry: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } }
        },
        layers: [
          // 下敷き: 粗い写真（z13 まで）。枚数が少なくすぐ揃うので、細かい写真が届く前も灰色にならない
          // 地理院の航空写真は z13 以下と z14 以上で元の写真が違い、z13 以下はかなり暗い（燕岳付近で平均 RGB 40,75,67 と 103,129,123）。
          // そのままだと細かい写真に切り替わるたびに山の色が変わるので、下敷きを明るく持ち上げて色をそろえる
          { id: "photo-lo", type: "raster", source: "photo-lo", paint: { "raster-saturation": -0.05, "raster-contrast": -0.1, "raster-brightness-min": 0.2, "raster-fade-duration": 0 } },
          { id: "photo", type: "raster", source: "photo", paint: { "raster-saturation": 0.1, "raster-contrast": 0.08, "raster-fade-duration": 400 } },
          // 日の当たり方: 太陽の方位から影を落とす（地形用とは別の標高ソースを使う。同じソースを共有すると描画が乱れることがある）
          { id: "hs", type: "hillshade", source: "dem-hs", paint: { "hillshade-illumination-anchor": "map", "hillshade-illumination-direction": 315, "hillshade-exaggeration": 0.3 } },
          // 朝夕の赤み・夜の暗さを全体に薄く重ねる
          { id: "tint", type: "fill", source: "world", paint: { "fill-color": "#ff9a55", "fill-opacity": 0 } }
        ],
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
  var DONE = "#1FB5E8", REST = "#E4572E", lastHere = null;   // 通った所 / これから
  function setRouteOnMap() {
    var gj = { type: "Feature", geometry: { type: "LineString", coordinates: route.line.map(function (p) { return [p[1], p[0]]; }) } };
    if (map.getSource("route")) { map.getSource("route").setData(gj); return; }
    map.addSource("route", { type: "geojson", data: gj, lineMetrics: true });
    map.addLayer({ id: "route-halo", type: "line", source: "route", paint: { "line-width": 7, "line-opacity": 0.85, "line-gradient": ["step", ["line-progress"], "#ffffff", 0.5, "#ffffff"] }, layout: { "line-join": "round", "line-cap": "round" } });
    map.addLayer({ id: "route", type: "line", source: "route", paint: { "line-width": 4, "line-gradient": progressExpr(0) }, layout: { "line-join": "round", "line-cap": "round" } });
    map.addSource("here", { type: "geojson", data: hereData(0) });
    map.addLayer({ id: "here-halo", type: "circle", source: "here", paint: { "circle-radius": 15, "circle-color": "rgba(31,181,232,.28)", "circle-pitch-alignment": "viewport" } });
    map.addLayer({ id: "here", type: "circle", source: "here", paint: { "circle-radius": 7.5, "circle-color": "#1E88E5", "circle-stroke-color": "#fff", "circle-stroke-width": 3, "circle-pitch-alignment": "viewport" } });
  }
  // 線の塗り分け: line-progress（線の長さに対する割合）で、通った所と残りを分ける。毎回データを作り直さないので軽い
  function progressExpr(frac) { return ["step", ["line-progress"], DONE, Math.min(0.999999, Math.max(0.000001, frac)), REST]; }
  function hereData(d) { var p = at(route, d); return { type: "Feature", geometry: { type: "Point", coordinates: [p[1], p[0]] } }; }
  function showProgress(d) {
    if (!map.getSource("here")) return;
    lastHere = hereData(d).geometry.coordinates;
    map.getSource("here").setData(hereData(d));
    map.setPaintProperty("route", "line-gradient", progressExpr(d / route.len));
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
      markers.push(new maplibregl.Marker({ element: a, anchor: "bottom", subpixelPositioning: true }).setLngLat([s.lon, s.lat]).addTo(map));
    });
    (route.peaks || []).forEach(function (pk) {
      var el = document.createElement("div");
      el.className = "fly-peak"; el.textContent = pk.name.ja;
      if (pk.elev) { var sm = document.createElement("small"); sm.textContent = pk.elev.toLocaleString() + "m"; el.appendChild(sm); }
      markers.push(new maplibregl.Marker({ element: el, anchor: "bottom", subpixelPositioning: true, opacityWhenCovered: "0" }).setLngLat([pk.lon, pk.lat]).addTo(map));
    });
    media.forEach(function (m) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "fly-thumb" + (m.kind === "video" ? " is-video" : "");
      if (m.thumb) b.style.backgroundImage = "url(" + JSON.stringify(m.thumb) + ")";
      b.setAttribute("aria-label", m.name + " を大きく見る");
      b.addEventListener("click", function (e) { e.stopPropagation(); pause(); setD(m.d, true); openPopup(m); });
      var p = at(route, m.d);
      markers.push(new maplibregl.Marker({ element: b, anchor: "bottom", offset: [0, -8], subpixelPositioning: true, opacityWhenCovered: "0.35" }).setLngLat([p[1], p[0]]).addTo(map));
    });
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

  // ------------------------------------------------------------------ 日の当たり方（その地点を通った時刻の太陽の位置）
  // 太陽の方位と高度は時刻と緯度経度から計算する（簡易式。誤差は 1 度程度で、影の向きには十分）。
  // 影（hillshade）を太陽の方位から落とし、高度に応じて明るさ・色味・空の色を変える。時刻が無いときは昼の既定
  function sunPos(ms, lat, lon) {
    var d = (ms - 946728000000) / 86400000, M = rad * (357.5291 + 0.98560028 * d);
    var L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
    var e = rad * 23.4397, dec = Math.asin(Math.sin(e) * Math.sin(L)), ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
    var phi = rad * lat, H = rad * (280.16 + 360.9856235 * d) + rad * lon - ra;
    var az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    var alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    return { az: (az / rad + 180 + 360) % 360, alt: alt / rad };
  }
  function lerp(a, b, f) { return a + (b - a) * f; }
  function ramp(x, pts) {   // 高度 x に対して [高度, 値] の表を線形補間
    if (x <= pts[0][0]) return pts[0][1];
    for (var i = 1; i < pts.length; i++) if (x <= pts[i][0]) return lerp(pts[i - 1][1], pts[i][1], (x - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]));
    return pts[pts.length - 1][1];
  }
  function mix(c1, c2, f) {
    var a = [1, 3, 5].map(function (i) { return parseInt(c1.substr(i, 2), 16); }), b = [1, 3, 5].map(function (i) { return parseInt(c2.substr(i, 2), 16); });
    return "#" + a.map(function (v, i) { return Math.round(lerp(v, b[i], f)).toString(16).padStart(2, "0"); }).join("");
  }
  var lastLight = null, skyPaint = { top: "#6f9fcb", bottom: "#dfe8ee" };
  function applyLight(d) {
    if (!map || !map.getLayer("hs")) return;
    var t = timeAt(d), p = at(route, d), s = t != null ? sunPos(t, p[0], p[1]) : { az: 315, alt: 40 };
    if (lastLight && Math.abs(lastLight.alt - s.alt) < 0.4 && Math.abs(((s.az - lastLight.az + 540) % 360) - 180) < 1.5) return;
    lastLight = s;
    var a = s.alt;
    // 夜 < -6° < 薄明 < 4° < 朝夕の光 < 15° < 昼
    var warm = ramp(a, [[-8, 0], [-2, 0.9], [4, 1], [15, 0]]);
    var night = ramp(a, [[-10, 1], [-4, 0.6], [2, 0]]);
    ["photo", "photo-lo"].forEach(function (id) {
      map.setPaintProperty(id, "raster-brightness-max", ramp(a, [[-10, 0.3], [-3, 0.55], [5, 0.92], [20, 1]]));
      map.setPaintProperty(id, "raster-saturation", ramp(a, [[-6, -0.45], [5, 0.05], [20, 0.1]]));
    });
    map.setPaintProperty("hs", "hillshade-illumination-direction", s.az);
    map.setPaintProperty("hs", "hillshade-exaggeration", ramp(a, [[-6, 0.15], [3, 0.7], [15, 0.45], [50, 0.25]]));
    map.setPaintProperty("hs", "hillshade-highlight-color", "rgba(255," + Math.round(lerp(255, 196, warm)) + "," + Math.round(lerp(255, 120, warm)) + "," + (0.18 + 0.25 * warm).toFixed(2) + ")");
    map.setPaintProperty("hs", "hillshade-shadow-color", "rgba(" + Math.round(lerp(20, 30, night)) + ",30," + Math.round(lerp(40, 70, night)) + ",0.6)");
    map.setPaintProperty("tint", "fill-color", warm > night ? "#ff9a55" : "#0b1d3a");
    map.setPaintProperty("tint", "fill-opacity", Math.max(warm * 0.1, night * 0.4));
    var sky = { top: mix(mix("#6f9fcb", "#e0855a", warm), "#0b1730", night), bottom: mix(mix("#dfe8ee", "#ffc794", warm), "#26385a", night) };
    skyPaint = sky;
    if (map.setSky) map.setSky({ "sky-color": sky.top, "horizon-color": sky.bottom, "fog-color": mix(mix("#dde6ea", "#f3b48a", warm), "#1b2740", night),
                                 "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.85 });
  }

  // ------------------------------------------------------------------ 山頂（地理院の注記: 312=山名、7102=三角点・7201=標高点）
  // 注記の位置は文字の置き場所で山頂からずれるので、近くの標高点（400m 以内で最も高いもの）を山頂として使う。道から 2.5km 以内だけ
  function pbfReader(buf) {
    var b = new Uint8Array(buf), pos = 0;
    var varint = function () { var r = 0, sh = 0, c; do { c = b[pos++]; r += (c & 0x7F) * Math.pow(2, sh); sh += 7; } while (c >= 0x80); return r; };
    return {
      fields: function (start, end, cb) {
        pos = start;
        while (pos < end) {
          var key = varint(), f = Math.floor(key / 8), w = key & 7, v, s0;
          if (w === 0) v = varint();
          else if (w === 2) { var n = varint(); s0 = pos; pos += n; v = [s0, s0 + n]; }
          else if (w === 1) { v = null; pos += 8; } else if (w === 5) { v = null; pos += 4; } else return;
          var keep = pos; cb(f, w, v); pos = keep;
        }
      },
      packed: function (r) { var out = [], save = pos; pos = r[0]; while (pos < r[1]) out.push(varint()); pos = save; return out; },
      str: function (r) { return new TextDecoder().decode(b.subarray(r[0], r[1])); }
    };
  }
  function annoFromTile(buf, z, x, y) {
    var R = pbfReader(buf), out = [];
    R.fields(0, buf.byteLength, function (f, w, layer) {
      if (f !== 3 || w !== 2) return;
      var name = "", keys = [], vals = [], feats = [], extent = 4096;
      R.fields(layer[0], layer[1], function (lf, lw, lv) {
        if (lf === 1) name = R.str(lv);
        else if (lf === 3) keys.push(R.str(lv));
        else if (lf === 4) { var val = null; R.fields(lv[0], lv[1], function (vf, vw, vv) { if (vf === 1) val = R.str(vv); else if (vf >= 4 && vf <= 6) val = vv; }); vals.push(val); }
        else if (lf === 5) extent = lv;
        else if (lf === 2) feats.push(lv);
      });
      if (name !== "Anno") return;
      feats.forEach(function (fr) {
        var tags = [], geom = [];
        R.fields(fr[0], fr[1], function (ff, fw, fv) { if (ff === 2) tags = R.packed(fv); if (ff === 4) geom = R.packed(fv); });
        var props = {}; for (var i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = vals[tags[i + 1]];
        if (geom.length < 3) return;
        var zz = function (n) { return (n >>> 1) ^ -(n & 1); }, px = zz(geom[1]), py = zz(geom[2]), n2 = Math.pow(2, z);
        var lon = (x + px / extent) / n2 * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / extent) / n2))) / rad;
        out.push({ code: Number(props.vt_code), text: props.vt_text == null ? "" : String(props.vt_text), lat: lat, lon: lon });
      });
    });
    return out;
  }
  var tileCache = new Map();
  async function loadPeaks() {
    var la = route.line.map(function (p) { return p[0]; }), lo = route.line.map(function (p) { return p[1]; });
    var minLa = Math.min.apply(null, la), maxLa = Math.max.apply(null, la), minLo = Math.min.apply(null, lo), maxLo = Math.max.apply(null, lo);
    if (maxLa < 24 || minLa > 46 || maxLo < 122 || minLo > 154) return [];   // 地理院のタイルは日本だけ
    var z = 12, n = Math.pow(2, z), tx = function (l) { return Math.floor((l + 180) / 360 * n); };
    var ty = function (l) { return Math.floor((1 - Math.log(Math.tan(l * rad) + 1 / Math.cos(l * rad)) / Math.PI) / 2 * n); };
    var m = 0.025, all = [];
    for (var x = tx(minLo - m); x <= tx(maxLo + m); x++) {
      for (var y = ty(maxLa + m); y <= ty(minLa - m); y++) {
        var key = z + "/" + x + "/" + y;
        if (!tileCache.has(key)) {
          tileCache.set(key, fetch("https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/" + key + ".pbf")
            .then(function (r) { return r.ok ? r.arrayBuffer() : null; }).catch(function () { return null; }));
        }
        var buf = await tileCache.get(key);
        if (buf) all = all.concat(annoFromTile(buf, z, x, y));
      }
    }
    var names = all.filter(function (a) { return a.code === 312 && a.text; });
    var spots = all.filter(function (a) { return (a.code === 7102 || a.code === 7201) && /^\d{3,4}(\.\d)?$/.test(a.text); });
    var seen = {}, peaks = [];
    names.forEach(function (nm) {
      if (seen[nm.text]) return;
      var best = null;
      spots.forEach(function (sp) { var dd = dist([nm.lat, nm.lon], [sp.lat, sp.lon]); if (dd < 400 && (!best || Number(sp.text) > Number(best.text))) best = sp; });
      var pt = best || nm, pr = project([pt.lat, pt.lon], route);
      if (pr.off > 2500) return;
      seen[nm.text] = true;
      peaks.push({ kind: "peak", name: { ja: nm.text, en: nm.text }, lat: pt.lat, lon: pt.lon, elev: best ? Math.round(Number(best.text)) : null, d: pr.d, off: pr.off });
    });
    peaks.sort(function (a, b) { return (b.elev || 0) - (a.elev || 0); });
    return peaks.slice(0, 18);
  }

  // ------------------------------------------------------------------ 山の裏に回り込まないカメラ
  // カメラから現在地までの見通しを、地形の高さで 12 点確かめる。遮られるなら傾きを起こして真上寄りにする。
  // 起こすのは早く、戻すのはゆっくり（視点が跳ねないように）。地形が読み込まれていない所は判定しない
  var aimPitch = null;
  function camPos() {
    try {
      var c = map.getCameraLngLat ? map.getCameraLngLat() : map.transform.getCameraLngLat();
      var a = map.getCameraAltitude ? map.getCameraAltitude() : map.transform.getCameraAltitude();
      return c && a != null && isFinite(a) ? { lat: c.lat, lon: c.lng, alt: a } : null;
    } catch (e) { return null; }
  }
  function blocked(target) {   // target は [緯度, 経度]
    var c = camPos(), te = map.queryTerrainElevation([target[1], target[0]]);
    if (!c || te == null) return false;
    for (var k = 1; k <= 12; k++) {
      var f = k / 13, la = c.lat + (target[0] - c.lat) * f, lo = c.lon + (target[1] - c.lon) * f;
      var e = map.queryTerrainElevation([lo, la]), los = c.alt + (te + 10 - c.alt) * f;
      if (e != null && e > los + 15) return true;
    }
    return false;
  }
  var aimWant = null, aimCount = 0;
  function aim(cam, target, step, every) {
    var want = cam.pitch;
    if (every && aimWant != null && (aimCount++ % every)) {
      want = Math.min(cam.pitch, aimWant);   // 間引いたコマは前回の判定を使う（重い地形の問い合わせを毎コマしない）
    } else {
      map.jumpTo(cam);
      while (want > 25 && blocked(target)) { want -= 8; map.jumpTo(Object.assign({}, cam, { pitch: want })); }
      aimWant = want;
    }
    if (aimPitch == null) aimPitch = want;
    aimPitch += Math.max(-step * 3, Math.min(step, want - aimPitch));
    map.jumpTo(Object.assign({}, cam, { pitch: aimPitch }));
  }

  // ------------------------------------------------------------------ 画面の再生（スライドバー・断面図・写真の小窓）
  var player = { d: 0, playing: false, hold: null, last: null, followBearing: null };
  function setD(d, moveCamera) {
    player.d = Math.max(0, Math.min(route.len, d));
    $("fly-seek").value = String(Math.round(player.d / route.len * 1000));
    var p = at(route, player.d);
    showProgress(player.d);
    applyLight(player.d);
    if (moveCamera) map.jumpTo({ center: [p[1], p[0]] });
    updateView();
  }
  function play() {
    if (player.d >= route.len - 1) setD(0, true);
    player.playing = true; player.last = null; player.followBearing = null; closePopup();
    player.basePitch = map.getPitch(); aimPitch = null; aimWant = null;   // 傾きは再生を始めたときの値を基準にする
    lastAhead = -1e9; prefetchAhead(player.d);
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
    // 次の写真まで遠いときは最大 4 倍の速さで進み、写真の 300m 手前からふつうの速さに戻す
    var d0 = player.d, next = media.find(function (m) { return m.d > d0; }), gap = next ? next.d - d0 : Infinity;
    var v = route.len / PLAY_SEC * (1 + 3 * Math.max(0, Math.min(1, (gap - 300) / 2000)));
    var d1 = Math.min(route.len, d0 + v * dt);
    var hit = media.find(function (m) { return m.d > d0 && m.d <= d1; });
    if (hit) d1 = hit.d;
    setD(d1, false);
    // カメラは進む向きに少しずつ回しながらついていく（ズームと傾きは触った値のまま）
    var b = bearing(railAt(d1 - 800), railAt(d1 + 1600));   // ならした軌道の向き（細かい曲がりで揺れない）
    if (player.followBearing == null) player.followBearing = map.getBearing();
    var diff = ((b - player.followBearing + 540) % 360) - 180;
    player.followBearing = (player.followBearing + diff * 0.02 + 360) % 360;
    var p = at(route, d1), c = railAt(d1);
    aim({ center: [c[1], c[0]], bearing: player.followBearing, pitch: player.basePitch, zoom: map.getZoom() }, p, 0.35, 6);
    prefetchAhead(d1);
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

  // ------------------------------------------------------------------ 書き出し（ショート動画）
  // 構成: ①冒頭: ハイライトの写真・動画を全面に、山名と数字を大きく（最初の 1 秒で止まってもらう）
  //       ②真上からルートが一気に描かれる ③スタートへ降りる ④道を進み、写真の地点では撮影した向きを見る視点へ降りて
  //       3D から本物の写真へ溶かす ⑤最後は全体を引きで見せ、距離・登った高さで締める
  // 文字は SNS の画面で隠れる上端・下 2 割・右端を避ける。音は入れない（各アプリで流行りの音を付けてもらう）
  var FPS = Number(Q.get("fps")) || 24;
  var SHOW_Z = 12.4, SHOW_PITCH = 55;   // 道中は少し高く引いて上から見る（低いと斜面ばかり映って道が見えない）
  var SAFE_TOP = 150, SAFE_BOTTOM = H - Math.round(H * 0.2);
  function ease(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
  function easeOut(x) { return 1 - Math.pow(1 - x, 3); }
  function angLerp(a, b, f) { var dd = ((b - a + 540) % 360) - 180; return (a + dd * f + 360) % 360; }
  function destination(p, brg, m) {   // p から方位 brg に m メートル進んだ点
    var dr = m / R, b = brg * rad, la = p[0] * rad, lo = p[1] * rad;
    var la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(b));
    var lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(la), Math.cos(dr) - Math.sin(la) * Math.sin(la2));
    return [la2 / rad, lo2 / rad];
  }
  function gainUp() {   // 登った高さの合計（3m 未満の上下はならす）
    var N = 400, last = null, up = 0;
    for (var i = 0; i <= N; i++) {
      var e = eleAt(route.len * i / N); if (e == null) continue;
      if (last == null) last = e; else if (e - last > 3) { up += e - last; last = e; } else if (last - e > 3) last = e;
    }
    return Math.round(up);
  }
  function ymd(utc) { var d = new Date(localMs(utc)); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; }
  function titleInfo() {
    var top = (route.peaks || []).filter(function (p) { return p.elev; }).sort(function (a, b) { return b.elev - a.elev; })[0];
    var t0 = timeAt(0), t1 = timeAt(route.len), days = null, date = "";
    if (t0 != null && t1 != null) {
      var a = ymd(t0), b = ymd(t1);
      days = Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000) + 1;
      date = a[0] + "." + String(a[1]).padStart(2, "0") + "." + String(a[2]).padStart(2, "0") + (days > 1 ? "–" + (a[1] === b[1] ? String(b[2]).padStart(2, "0") : b[1] + "." + String(b[2]).padStart(2, "0")) : "");
    }
    var g = gainUp();
    return { title: top ? top.name.ja : route.name.ja, sub: top ? top.elev.toLocaleString() + "m" : "", date: date,
             stats: [fmtDist(route.len), g ? "↑" + g.toLocaleString() + "m" : null, days ? days + "日間" : null].filter(Boolean) };
  }
  function highlight() {
    return media.find(function (m) { return m.star; }) || media.find(function (m) { return m.kind === "video"; })
      || media.slice().sort(function (a, b) { return (eleAt(b.d) || 0) - (eleAt(a.d) || 0); })[0] || null;
  }
  // 入れる写真を選ぶ: 選んだ長さの 6 割まで。込み合った所から間引き、道の上に散らばるようにする（★は残す）
  function chooseMedia(budget, per) {
    var list = media.slice().sort(function (a, b) { return a.d - b.d; });
    var cost = function (l) { return l.reduce(function (s, m) { return s + per(m); }, 0); };
    while (list.length && cost(list) > budget * 0.6) {
      var worst = -1, gap = Infinity;
      list.forEach(function (m, i) {
        if (m.star && list.length > 1) return;
        var g = Math.min(i ? m.d - list[i - 1].d : Infinity, i < list.length - 1 ? list[i + 1].d - m.d : Infinity);
        if (g < gap) { gap = g; worst = i; }
      });
      list.splice(worst < 0 ? 0 : worst, 1);
    }
    return list;
  }
  function buildShow() {
    var T = Number(($("fly-len") || {}).value) || 20, s = T <= 10 ? 0.7 : T <= 20 ? 0.9 : 1;
    var hl = highlight();
    var hook = (hl ? 1.4 : 1.0) * s, draw = 1.3 * s, swoop = 1.1 * s, outro = 2.2 * s;
    var budget = T - hook - draw - swoop - outro;
    var per = function (m) { return 0.9 * s + (m.kind === "video" ? Math.min(m.dur, 3 * s) : 1.7 * s) + 0.6 * s; };
    var chosen = chooseMedia(budget, per);
    var used = chosen.reduce(function (a, m) { return a + per(m); }, 0), flyT = Math.max(budget * 0.4, budget - used);
    var ev = [], t = 0, push = function (o, dur) { o.t0 = t; o.t1 = t + dur; ev.push(o); t += dur; };
    push({ kind: "hook", m: hl }, hook);
    push({ kind: "draw" }, draw);
    push({ kind: "swoop" }, swoop);
    var v = route.len / flyT, d = 0;
    chosen.forEach(function (m) {
      var dt = (m.d - d) / v;
      if (dt > 0.05) push({ kind: "fly", d0: d, d1: m.d }, dt);
      d = m.d;
      push({ kind: "approach", m: m, d0: d, d1: d }, 0.9 * s);
      push({ kind: "photo", m: m, d0: d, d1: d }, m.kind === "video" ? Math.min(m.dur, 3 * s) : 1.7 * s);
      push({ kind: "back", m: m, d0: d, d1: d }, 0.6 * s);
    });
    if (route.len - d > 1) push({ kind: "fly", d0: d, d1: route.len }, Math.max(0.3, (route.len - d) / v));
    push({ kind: "outro" }, outro);
    // 足し合わせで選んだ長さを超えたら、飛ぶ区間を縮めて合わせる
    if (t > T) {
      var over = t - T, flys = ev.filter(function (e) { return e.kind === "fly"; }), ft = flys.reduce(function (a, e) { return a + e.t1 - e.t0; }, 0);
      var k = Math.max(0.2, (ft - over) / (ft || 1)); t = 0;
      ev.forEach(function (e) { var dur = (e.t1 - e.t0) * (e.kind === "fly" ? k : 1); e.t0 = t; e.t1 = t + dur; t += dur; });
    }
    return { ev: ev, total: t, info: titleInfo(), chosen: chosen };
  }

  // カメラ: 道中は「ならした軌道」の上を進む（細かいくねりを追わない）。写真では撮影地点に立って撮った向きを見る
  var overviewCamCache = null, flyBearing = null;
  // カメラの中心の標高。渡さないと海抜 0m の点を狙うので、標高 3,000m 級の稜線が画面の上へ浮いて現在地が上端に寄る
  function groundAt(lon, lat, fallbackD) {
    var e = map.queryTerrainElevation([lon, lat]);
    return e != null ? e : (fallbackD != null && eleAt(fallbackD) != null ? eleAt(fallbackD) * EXAG : 0);
  }
  function overviewCam(spin) {
    if (!overviewCamCache) {
      var b = new maplibregl.LngLatBounds();
      route.line.forEach(function (p) { b.extend([p[1], p[0]]); });
      var c = map.cameraForBounds(b, { padding: { top: 120, bottom: 170, left: 30, right: 30 }, pitch: 0, bearing: 0 }) || { center: b.getCenter(), zoom: 11 };
      overviewCamCache = { center: [c.center.lng != null ? c.center.lng : c.center[0], c.center.lat != null ? c.center.lat : c.center[1]], zoom: c.zoom - 0.15 };
      overviewCamCache.elevation = groundAt(overviewCamCache.center[0], overviewCamCache.center[1], route.len / 2);
    }
    return { center: overviewCamCache.center, zoom: overviewCamCache.zoom, pitch: 38, bearing: -20 + (spin || 0), elevation: overviewCamCache.elevation };
  }
  function flyCam(d, stepState) {
    var c = railAt(d), b = bearing(railAt(d - 800), railAt(d + 1600));
    if (stepState) { if (flyBearing == null) flyBearing = b; flyBearing = angLerp(flyBearing, b, 0.05); b = flyBearing; }
    else if (flyBearing != null) b = flyBearing;
    return { center: [c[1], c[0]], zoom: SHOW_Z, pitch: SHOW_PITCH, bearing: b, elevation: groundAt(c[1], c[0], d) };
  }
  // カメラを地面より上に保つ: 動かした後のカメラの真下の地形と比べ、80m より低ければ引いて（ズームを下げて）持ち上げる。
  // 写真の地点へ降りる途中は 2 つのカメラの間をなめらかにつなぐので、急斜面では地面に潜ることがある
  function keepAbove(cam) {
    map.jumpTo(cam);
    for (var i = 0; i < 10; i++) {
      var c = camPos(); if (!c) return;
      var g = map.queryTerrainElevation([c.lon, c.lat]);
      if (g == null || c.alt > g + 80) return;
      cam = Object.assign({}, cam, { zoom: cam.zoom - 0.3 });
      map.jumpTo(cam);
    }
  }
  function povCam(m) {   // 撮影地点の少し上から、撮った向きを見る（向きが分からないものは斜め上から寄る）
    if (m.pov) return m.pov;
    if (m.dir == null) {
      var q = at(route, m.d), fb = flyBearing != null ? flyBearing : bearing(railAt(m.d - 800), railAt(m.d + 1600));
      m.pov = { center: [q[1], q[0]], zoom: 14.2, pitch: 50, bearing: fb, elevation: groundAt(q[1], q[0], m.d) };
      return m.pov;
    }
    var p = m.gps && project(m.gps, route).off < 300 ? m.gps : at(route, m.d);
    var dir = m.dir != null ? m.dir : bearing(at(route, m.d - 300), at(route, m.d + 600));
    var tgt = destination(p, dir, 1800);
    var eFrom = map.queryTerrainElevation([p[1], p[0]]), eTo = map.queryTerrainElevation([tgt[1], tgt[0]]);
    if (eFrom == null) eFrom = (eleAt(m.d) || 1500) * EXAG;
    if (eTo == null) eTo = eFrom;
    var co = null;
    try {
      co = map.calculateCameraOptionsFromTo(new maplibregl.LngLat(p[1], p[0]), eFrom + 110, new maplibregl.LngLat(tgt[1], tgt[0]), Math.max(eTo, eFrom - 300));
    } catch (e) { co = null; }
    if (co && isFinite(co.zoom) && co.center) {
      co = { center: [co.center.lng != null ? co.center.lng : co.center[0], co.center.lat != null ? co.center.lat : co.center[1]],
             zoom: Math.min(16, co.zoom), pitch: Math.max(55, Math.min(78, co.pitch)), bearing: co.bearing != null ? co.bearing : dir,
             elevation: co.elevation != null ? co.elevation : Math.max(eTo, eFrom - 300) };
    } else {
      co = { center: [tgt[1], tgt[0]], zoom: 14.4, pitch: 74, bearing: dir, elevation: eTo };
    }
    m.pov = co;
    return co;
  }
  function mixCam(a, b, f) {
    return { center: [lerp(a.center[0], b.center[0], f), lerp(a.center[1], b.center[1], f)], zoom: lerp(a.zoom, b.zoom, f),
             pitch: lerp(a.pitch, b.pitch, f), bearing: angLerp(a.bearing, b.bearing, f), elevation: lerp(a.elevation || 0, b.elevation || 0, f) };
  }
  function showState(show, t) {
    var e = show.ev.find(function (x) { return t >= x.t0 && t < x.t1; }) || show.ev[show.ev.length - 1];
    var f = Math.max(0, Math.min(1, (t - e.t0) / ((e.t1 - e.t0) || 1))), st = { e: e, f: f, d: 0, line: 1, photoAlpha: 0, hud: 0, m: e.m || null };
    if (e.kind === "hook") { st.cam = overviewCam(0); st.line = 0; st.photoAlpha = e.m ? 1 : 0; }
    else if (e.kind === "draw") { st.cam = overviewCam(8 * f); st.line = easeOut(f); st.drawing = true; }
    else if (e.kind === "swoop") { var k = ease(f); st.cam = mixCam(overviewCam(8), flyCam(0, false), k); st.hud = k; }
    else if (e.kind === "fly") { st.d = e.d0 + (e.d1 - e.d0) * f; st.cam = flyCam(st.d, true); st.hud = 1; }
    else if (e.kind === "approach") { st.d = e.d0; st.cam = mixCam(flyCam(e.d0, false), povCam(e.m), ease(f)); st.hud = 1 - f; }
    else if (e.kind === "photo") {
      st.d = e.d0; var pc = povCam(e.m);
      st.cam = { center: pc.center, zoom: pc.zoom, pitch: pc.pitch, bearing: pc.bearing + 3 * f, elevation: pc.elevation };
      st.photoAlpha = Math.min(1, f / 0.22, (1 - f) / 0.18);   // 3D から本物の写真へ溶け、最後に 3D へ戻る
    }
    else if (e.kind === "back") { st.d = e.d0; st.cam = mixCam(povCam(e.m), flyCam(e.d0, false), ease(f)); st.hud = f; }
    else { st.d = route.len; st.cam = mixCam(flyCam(route.len, false), overviewCam(8 + 25 * f), ease(f)); st.outro = true; }
    return st;
  }
  function setLine(st) {   // 描かれていく線（冒頭）／通った所と残り（道中）
    if (!map.getLayer("route")) return;
    if (st.drawing || st.e.kind === "hook") {
      var fr = Math.min(0.999999, Math.max(0.000001, st.line));
      map.setPaintProperty("route", "line-gradient", ["step", ["line-progress"], REST, fr, "rgba(0,0,0,0)"]);
      map.setPaintProperty("route-halo", "line-gradient", ["step", ["line-progress"], "#ffffff", fr, "rgba(255,255,255,0)"]);
    } else {
      map.setPaintProperty("route", "line-gradient", progressExpr(st.outro ? 1 : st.d / route.len));
      map.setPaintProperty("route-halo", "line-gradient", ["step", ["line-progress"], "#ffffff", 0.5, "#ffffff"]);
    }
    // 撮影地点に降りた視点では、足元の線が遠近で極太になるので薄くする
    var pov = st.e.kind === "approach" || st.e.kind === "photo" || st.e.kind === "back";
    map.setPaintProperty("route", "line-opacity", pov ? 0.35 : 1);
    map.setPaintProperty("route-halo", "line-opacity", pov ? 0 : 0.85);
    var showDot = !(st.drawing || st.e.kind === "hook" || st.outro || pov);
    ["here", "here-halo"].forEach(function (id) { map.setLayoutProperty(id, "visibility", showDot ? "visible" : "none"); });
  }

  // 合成（地図＋本物の写真＋文字）
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function text(s, x, y, size, weight, color, align) {
    ctx.font = (weight || 600) + " " + size + "px system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif";
    ctx.textAlign = align || "left"; ctx.fillStyle = color || "#fff";
    ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 12; ctx.fillText(s, x, y); ctx.shadowBlur = 0;
  }
  function drawFull(m, alpha, k) {   // 写真・動画を画面いっぱいに（ゆっくり寄る）
    var src = m.kind === "video" ? m.el : m.img, sw = m.kind === "video" ? m.el.videoWidth : m.img.width, sh = m.kind === "video" ? m.el.videoHeight : m.img.height;
    if (!sw || !sh || alpha <= 0) return;
    var sc = Math.max(W / sw, H / sh) * (1.02 + 0.08 * k), dw = sw * sc, dh = sh * sc;
    ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh); ctx.restore();
  }
  function shade(top, bottom) {
    var g = ctx.createLinearGradient(0, 0, 0, 420); g.addColorStop(0, "rgba(0,0,0," + top + ")"); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, 420);
    g = ctx.createLinearGradient(0, H * 0.45, 0, H); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0," + bottom + ")");
    ctx.fillStyle = g; ctx.fillRect(0, H * 0.45, W, H * 0.55);
  }
  function compose(st, show) {
    var info = show.info;
    if (st.photoAlpha < 1) {
      var sky = ctx.createLinearGradient(0, 0, 0, H * 0.55);
      sky.addColorStop(0, skyPaint.top); sky.addColorStop(1, skyPaint.bottom);
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(map.getCanvas(), 0, 0, W, H);
      var sc = W / map.getContainer().clientWidth, shown = st.outro || st.e.kind === "hook" ? 99 : 0, placed = [];
      (route.peaks || []).filter(function (pk) { return pk.elev; }).forEach(function (pk) {   // 山頂は見えている高いものから 4 つまで、重ならないものだけ
        if (shown >= 4) return;
        var q = map.project([pk.lon, pk.lat]), x = q.x * sc, y = q.y * sc;
        if (x < 30 || x > W - 30 || y < SAFE_TOP + 120 || y > SAFE_BOTTOM - 60) return;
        if (placed.some(function (o) { return Math.abs(o[0] - x) < 170 && Math.abs(o[1] - y) < 50; })) return;
        placed.push([x, y]);
        text("▲", x, y, 18, 700, "#fff", "center");
        text(pk.name.ja + " " + pk.elev.toLocaleString() + "m", x, y - 26, 24, 700, "#fff", "center");
        shown++;
      });
    }
    if (st.photoAlpha > 0 && st.m) drawFull(st.m, st.photoAlpha, st.f);
    var k = st.e.kind;
    if (k === "hook") {
      shade(0.35, 0.75);
      var a = Math.min(1, st.f * 5);
      ctx.save(); ctx.globalAlpha = a;
      text(info.date, W / 2, H * 0.50, 30, 600, "#fff", "center");
      text(info.title, W / 2, H * 0.50 + 92, info.title.length > 7 ? 70 : 92, 800, "#fff", "center");
      if (info.sub) text(info.sub, W / 2, H * 0.50 + 150, 44, 700, "#fff", "center");
      text(info.stats.join("  ·  "), W / 2, H * 0.50 + 214, 34, 700, "#fff", "center");
      ctx.restore();
    } else if (k === "draw" || k === "swoop") {
      shade(0.4, 0.3);
      ctx.save(); ctx.globalAlpha = k === "draw" ? 1 : 1 - st.f;
      text(info.title + (info.sub ? " " + info.sub : ""), W / 2, SAFE_TOP + 40, 44, 800, "#fff", "center");
      text(info.stats.join("  ·  "), W / 2, SAFE_TOP + 92, 28, 600, "#fff", "center");
      ctx.restore();
    } else if (k === "photo") {
      shade(0.15, 0.55 * st.photoAlpha);
      var m = st.m, t = m.utc != null ? m.utc : (m.local != null && tz ? m.local - tz.ms : timeAt(st.d)), near = nearestStop(st.d), e = eleAt(st.d);
      ctx.save(); ctx.globalAlpha = Math.min(1, st.photoAlpha * 1.4);
      if (t != null) text(fmtClock(t), 48, SAFE_BOTTOM - 70, 64, 800, "#fff", "left");
      text((near && Math.abs(near.d - st.d) < 1500 ? near.name.ja + "  " : "") + (e != null ? Math.round(e).toLocaleString() + "m" : ""), 50, SAFE_BOTTOM - 20, 30, 700, "#fff", "left");
      ctx.restore();
    } else if (st.outro) {
      shade(0.45, 0.6);
      var o = Math.min(1, st.f * 3);
      ctx.save(); ctx.globalAlpha = o;
      text(info.title + (info.sub ? " " + info.sub : ""), W / 2, H * 0.40, 56, 800, "#fff", "center");
      info.stats.forEach(function (s2, i) { text(s2, W / 2, H * 0.40 + 92 + i * 70, 54, 800, "#fff", "center"); });
      if (info.date) text(info.date, W / 2, H * 0.40 + 92 + info.stats.length * 70 + 10, 28, 600, "#fff", "center");
      ctx.restore();
    }
    if (st.hud > 0) {   // 道中: 左上に標高と距離（音なしでも伝わる数字）
      shade(0.35 * st.hud, 0);
      var e2 = eleAt(st.d), t2 = timeAt(st.d);
      ctx.save(); ctx.globalAlpha = st.hud;
      if (e2 != null) text(Math.round(e2).toLocaleString() + "m", 44, SAFE_TOP + 52, 58, 800, "#fff", "left");
      text(fmtDist(st.d) + (t2 != null ? "  ·  " + fmtClock(t2) : ""), 46, SAFE_TOP + 98, 28, 700, "#fff", "left");
      ctx.restore();
    }
    ctx.save(); ctx.globalAlpha = 0.8;
    text("HutsGo", W - 40, SAFE_TOP - 22, 24, 800, "#fff", "right");
    text("地図: 国土地理院", 40, SAFE_BOTTOM + 34, 18, 500, "rgba(255,255,255,.85)", "left");
    ctx.restore();
  }

  function seek(el, t) {
    return new Promise(function (ok) {
      var done = false, fin = function () { if (!done) { done = true; ok(); } };
      el.addEventListener("seeked", fin, { once: true }); setTimeout(fin, 1500);
      el.currentTime = Math.max(0, Math.min(t, (el.duration || t) - 0.05));
    });
  }
  // 書き出し前の準備: 飛ぶ道筋と写真の地点の地図を先に読む（読み込みを待つ時間を書き出しの外に出す）
  async function prepareTiles(show) {
    queue = [];
    want("photo", 14, 0, route.len, 1);
    want("photo", 15, 0, route.len, 0);
    show.chosen.forEach(function (m) { want("photo", 15, Math.max(0, m.d - 500), m.d + 2500, 1); });
    var t0 = Date.now(), total = queue.length + inflight || 1;
    while ((queue.length || inflight) && Date.now() - t0 < 30000) {
      status("地図を準備中… " + Math.round((1 - (queue.length + inflight) / total) * 100) + "%");
      await new Promise(function (ok) { setTimeout(ok, 250); });
    }
  }
  function stageMap(on) {   // 書き出し・プレビューの間だけ、地図を 360×640 の 2 倍（720×1280）に固定する
    var phone = document.querySelector(".fly-phone");
    phone.classList.toggle("is-exporting", on);
    map.setPixelRatio(on ? W / 360 : Math.min(2, window.devicePixelRatio || 1)); map.resize();
    markers.forEach(function (mk) { mk.getElement().style.visibility = on ? "hidden" : ""; });
    // 書き出し中は写真の切り替えフェードを切る（「読み込み完了」がフェードの終わりまで待つので、1 コマごとに遅くなる）
    map.setPaintProperty("photo", "raster-fade-duration", on ? 0 : 400);
    // 全体を見せたときの余白（fitBounds）が残ると画面の中心がずれる。書き出し中は上にだけ余白を付け、現在地を画面の下寄りに置く（前方が見える）
    map.setPadding(on ? { top: 170, bottom: 0, left: 0, right: 0 } : { top: 0, bottom: 0, left: 0, right: 0 });
    overviewCamCache = null;
  }
  async function encodeFrames(show) {
    if (!window.VideoEncoder || !window.VideoFrame || !window.Mp4Muxer) return null;
    var config = null, codecs = ["avc1.640028", "avc1.4d0028", "avc1.42001f"];
    for (var c = 0; c < codecs.length && !config; c++) {
      var cfg = { codec: codecs[c], width: W, height: H, bitrate: 8e6, framerate: FPS };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) config = cfg; } catch (e) { /* 次の候補へ */ }
    }
    if (!config) return null;
    var muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: "avc", width: W, height: H }, fastStart: "in-memory" });
    var failedEnc = null, t0 = Date.now();
    var enc = new VideoEncoder({ output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); }, error: function (e) { failedEnc = e; } });
    enc.configure(config);
    media.forEach(function (m) { if (m.el) m.el.pause(); m.pov = null; });
    flyBearing = null; timeouts = 0; aimPitch = null; aimWant = null;
    var N = Math.ceil(show.total * FPS);
    for (var i = 0; i < N; i++) {
      var t = i / FPS, st = showState(show, t);
      if (st.photoAlpha < 1) {   // 写真が全面に出ている間は地図を描かない（そのぶん速い）
        if (st.e.kind === "fly" || st.e.kind === "swoop") aim(st.cam, at(route, st.d), 30 / FPS); else keepAbove(st.cam);
        setLine(st); showProgress(st.d); applyLight(st.d); prefetchAhead(st.d);
        await settle(6000);
      }
      if (st.m && st.m.kind === "video" && st.photoAlpha > 0) await seek(st.m.el, st.e.kind === "hook" ? t : t - st.e.t0);
      compose(st, show);
      var vf = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: i % (FPS * 2) === 0 });
      vf.close();
      if (failedEnc) throw failedEnc;
      if (enc.encodeQueueSize > 8) await new Promise(function (ok) { setTimeout(ok, 0); });
      if (i % 6 === 0) status("書き出し中… " + Math.round(i / N * 100) + "%");
    }
    await enc.flush();
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), sec: show.total, frames: N, timeouts: timeouts, took: (Date.now() - t0) / 1000,
             mime: "video/mp4（" + FPS + "fps）" + (timeouts ? "・読み込み待ちを打ち切ったコマ " + timeouts : "") };
  }
  function playShow(show, rec) {   // 実時間で流す（プレビュー、または WebCodecs の無い端末での録画）
    return new Promise(function (resolve) {
      var start = null;
      media.forEach(function (m) { m.pov = null; });
      flyBearing = null; aimPitch = null; aimWant = null;
      function tick(now) {
        if (start === null) start = now;
        var t = (now - start) / 1000, st = showState(show, Math.min(t, show.total - 0.001));
        if (st.photoAlpha < 1) {
          if (st.e.kind === "fly" || st.e.kind === "swoop") aim(st.cam, at(route, st.d), 1.2, 6); else keepAbove(st.cam);
          setLine(st); showProgress(st.d); applyLight(st.d); prefetchAhead(st.d);
        }
        if (st.m && st.m.kind === "video" && st.photoAlpha > 0 && st.m.el.paused) { st.m.el.currentTime = 0; st.m.el.play().catch(function () {}); }
        if (st.photoAlpha < 1) { map.once("render", function () { compose(st, show); }); map.triggerRepaint(); } else compose(st, show);
        if (t < show.total) requestAnimationFrame(tick); else setTimeout(function () { if (rec) rec.stop(); resolve(); }, 200);
      }
      requestAnimationFrame(tick);
    });
  }
  async function recordRealtime(show) {
    var mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find(function (m) {
      return window.MediaRecorder && MediaRecorder.isTypeSupported(m); }) || "", chunks = [];
    var rec = new MediaRecorder(out.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
    rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
    var done = new Promise(function (ok) { rec.onstop = ok; });
    rec.start(500);
    await playShow(show, rec); await done;
    return { blob: new Blob(chunks, { type: rec.mimeType || mime }), mime: (rec.mimeType || mime) + "（実時間で録画）", sec: show.total };
  }
  function showOut(on) { out.hidden = !on; out.classList.toggle("is-live", on); }
  async function previewVideo() {
    if (busy) return;
    busy = true; pause(); closePopup(); setButtons(false);
    var keep = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    try {
      stageMap(true); showOut(true);
      var show = buildShow();
      status("プレビュー（" + Math.round(show.total) + " 秒）");
      await playShow(show, null);
      status("");
    } catch (e) { status("うまく動きませんでした: " + (e && e.message || e)); }
    showOut(false); stageMap(false); map.jumpTo(keep); restoreLine();
    busy = false; setButtons(true);
  }
  async function exportVideo() {
    if (busy) return;
    busy = true; pause(); closePopup(); setButtons(false);
    var keep = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    try {
      stageMap(true); showOut(true);
      var show = buildShow();
      await prepareTiles(show);
      var res = await encodeFrames(show);
      if (!res) { status("この端末は 1 コマずつの書き出しに対応していないため、実時間で録画します…"); res = await recordRealtime(show); }
      var url = URL.createObjectURL(res.blob), ext = /mp4/.test(res.mime) ? "mp4" : "webm";
      $("fly-video").src = url;
      $("fly-download").href = url; $("fly-download").download = "hutsgo-" + (route.source === "gpx" ? "gpx" : route.id) + "." + ext;
      $("fly-format").textContent = Math.round(res.sec) + " 秒・" + (res.blob.size / 1048576).toFixed(1) + "MB・" + res.mime + (res.took ? "・作成 " + Math.round(res.took) + " 秒" : "")
        + (ext === "webm" ? "（MP4 で録れませんでした。Instagram などに上げるときは変換が要ることがあります）" : "");
      $("fly-result").hidden = false;
      status("できました。");
      track("flyover_export");
    } catch (e) {
      status("うまく動きませんでした: " + (e && e.message || e));
    }
    showOut(false); stageMap(false); map.jumpTo(keep); restoreLine();
    busy = false; setButtons(true);
  }
  function restoreLine() {
    if (!map.getLayer("route")) return;
    setLine({ e: { kind: "fly" }, d: player.d, line: 1 });
    applyLight(player.d);
  }
  function setButtons(on) { ["fly-record", "fly-preview"].forEach(function (id) { var b = $(id); if (b) b.disabled = !on; }); }
  function track(ev) {
    var api = (document.querySelector('meta[name="hutsgo-api"]') || {}).content;
    if (api && navigator.sendBeacon) {
      navigator.sendBeacon(api + "/track.php", new Blob([JSON.stringify({ ev: ev, lang: "ja", hut: "", trail: route.source === "gpx" ? "" : route.id, page: location.pathname, ref: "" })], { type: "text/plain" }));
    }
  }

  // ------------------------------------------------------------------ 起動
  async function useRoute(r) {
    pause(); closePopup();
    route = prepRoute(r); route._pv = null; route.profile = null; player.d = 0; lastLight = null; overviewCamCache = null;
    await loadHuts();
    await nearbyHuts();
    prefetchBase(); lastAhead = -1e9;
    try { route.peaks = await loadPeaks(); } catch (e) { route.peaks = []; }
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
    $("fly-preview").addEventListener("click", previewVideo);
    // ★: 冒頭（フック）に使う写真・動画を選ぶ
    $("fly-list").addEventListener("click", function (e) {
      var b = e.target.closest("[data-star]"); if (!b) return;
      var m = media[Number(b.dataset.star)]; var on = !m.star;
      media.forEach(function (x) { x.star = false; }); m.star = on; renderList();
    });
    window.HutsGoFlyover = {
      map: map, setD: function (d) { setD(d, true); }, play: play, pause: pause,
      // 試験用: 道の d の地点を指定の傾きで狙い、遮られたまま残ったかを返す
      sun: function (ms, lat, lon) { return sunPos(ms, lat, lon); },
      timeline: function () { var sh = buildShow(); return { total: sh.total, kinds: sh.ev.map(function (e) { return e.kind; }), info: sh.info, chosen: sh.chosen.length }; },
      pov: function (i) { var m = media[i]; m.pov = null; return povCam(m); },
      flyDebug: async function (d) {
        stageMap(true); flyBearing = null;
        var cam = flyCam(d, true); map.jumpTo(cam); await settle(15000);
        var dot = at(route, d), rl = railAt(d), q = map.project([dot[1], dot[0]]), c = map.project(map.getCenter());
        var res = { railOff: Math.round(dist(dot, rl)), dotY: Math.round(q.y), centerY: Math.round(c.y), h: map.getContainer().clientHeight,
                    padding: map.getPadding(), pitch: map.getPitch(), zoom: map.getZoom() };
        stageMap(false); return res;
      },
      aimTest: async function (d, pitch) {
        var p = at(route, d), b = bearing(at(route, d - 700), at(route, d + 1800));
        map.jumpTo({ center: [p[1], p[0]], bearing: b, pitch: pitch, zoom: Z }); await settle(15000);
        var before = blocked(p); aimPitch = null; aim({ center: [p[1], p[0]], bearing: b, pitch: pitch, zoom: Z }, p, 90); await settle(15000);
        return { before: before, after: blocked(p), pitch: map.getPitch() };
      },
      here: function () { return lastHere; },
      gradient: function () { return JSON.stringify(map.getPaintProperty("route", "line-gradient")); },
      state: function () {
        return { route: route.id, source: route.source, len: route.len, d: player.d, playing: player.playing, tz: tz && tz.ms,
                 hutsNear: (route.stops || []).filter(function (s) { return s.kind === "hut"; }).map(function (s) { return s.id; }),
                 media: media.map(function (m) { return { name: m.name, placed: m.placed, d: m.d }; }), profile: !!(route.ele || route.profile),
                 stats: [$("fly-st-time").textContent, $("fly-st-elev").textContent, $("fly-st-dist").textContent], date: $("fly-date").textContent, clock: $("fly-clock").textContent,
                 popup: !$("fly-popup").hidden, thumbs: document.querySelectorAll(".fly-thumb").length,
                 peaks: (route.peaks || []).map(function (p) { return p.name.ja + (p.elev ? ":" + p.elev : ""); }), light: lastLight,
                 dirs: media.map(function (m) { return m.dir == null ? null : Math.round(m.dir); }), highlight: (highlight() || {}).name || null,
                 tiles: { stored: store.size, queued: queue.length, inflight: inflight } };
      }
    };
  }
  boot();
})();
