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
    var added = 0, bad = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i], isVideo = /^video\//.test(f.type) || /\.(mov|mp4|m4v)$/i.test(f.name);
      var m = { file: f, kind: isVideo ? "video" : "image", name: f.name, url: URL.createObjectURL(f) };
      try {
        if (isVideo) {
          var vm = readVideoMeta(await headAndTail(f, 2 * 1024 * 1024));
          m.gps = vm.gps || null; m.utc = vm.utc || null;
          m.el = document.createElement("video");
          m.el.src = m.url; m.el.muted = true; m.el.playsInline = true; m.el.preload = "auto";
          vbin().appendChild(m.el);   // 文書に入れておかないと、Android では止めた動画の絵を取り出せないことがある
          await new Promise(function (ok) { m.el.onloadeddata = ok; m.el.onerror = ok; setTimeout(ok, 8000); });
          m.el.style.cssText = "width:96px;height:96px;object-fit:cover";
          if (!m.el.videoWidth) { m.err = "この端末のブラウザでは再生できない形式の動画です（HEVC・HDR など。カメラの設定で「互換性優先」/ H.264 にすると使えます）"; }
          else if (!(await primeVideo(m))) m.noFrame = true;   // 外さない（端末によって確かめ方が効かないことがある）。描けないときは地図を出す
          m.full = m.el.duration && isFinite(m.el.duration) ? m.el.duration : VIDEO_MAX_SEC;
          m.dur = Math.min(VIDEO_MAX_SEC, m.full);
          m.thumb = m.lastCv ? frameThumb(m.lastCv, m.lastCv.width, m.lastCv.height) : frameThumb(m.el, m.el.videoWidth, m.el.videoHeight);
          m.aspect = m.el.videoWidth && m.el.videoHeight ? m.el.videoWidth / m.el.videoHeight : 9 / 16;
          m.q = m.lastCv ? frameScore(m.lastCv, m.lastCv.width, m.lastCv.height) : 0.5;
          analyzeLater(m);
        } else {
          var exRaw = readExif(await f.slice(0, 256 * 1024).arrayBuffer()), ex = exRaw || {};
          m.exif = !!exRaw;
          m.gps = ex.gps || null; m.dir = ex.dir != null ? ex.dir : null; m.local = ex.local != null ? ex.local : null; m.offset = ex.offset != null ? ex.offset : null;
          if (m.local != null && m.offset != null) m.utc = m.local - m.offset;
          m.img = await createImageBitmap(f);
          m.thumb = m.url; m.aspect = m.img.width / m.img.height;
          m.q = frameScore(m.img, m.img.width, m.img.height);
        }
      } catch (e) {
        m.err = String(e && e.message || e);
      }
      if (!m.err) { media.push(m); added++; } else { failed.push(m); bad.push(m); if (m.el) m.el.remove(); }
    }
    place();
    renderList();
    if (!sp.playing) { sp.show = buildShow(); sp.t = posterT(); }
    refreshShow();
    var imgs = media.filter(function (m) { return m.kind === "image"; }), withGps = imgs.filter(function (m) { return m.gps; }).length;
    var withTime = imgs.filter(function (m) { return m.local != null || m.utc != null; }).length;
    status(!added ? "読み込めるファイルがありませんでした。"
      : imgs.length && !withGps
        ? "写真 " + imgs.length + " 枚とも位置情報がありません（スマホのブラウザは写真を渡す前に位置情報を外すことがあります）。"
          + (withTime ? "撮影時刻はあります。" : "") + "写真を押すと場所を合わせられます。"
        : imgs.length ? "置きました（位置情報あり " + withGps + "/" + imgs.length + " 枚）。" : "置きました。");
    var nf = media.filter(function (m) { return m.noFrame && !m.frameOK && !m.dframes; });
    if (nf.length) status($("fly-status").textContent + " " + nf.map(function (m) { return m.name; }).join("、")
      + " は、再生中の絵を取り出せない形式（HDR・HEVC など）のため、ファイルから絵を作っています。");
    if (bad.length) status($("fly-status").textContent + " 使えなかったもの: " + bad.map(function (m) { return m.name + "（" + m.err + "）"; }).join("、"));
  }
  // 動画の「いちばん良い場面」: 0.5 秒ごとに小さく取り出し、ピント（輪郭の強さ）・明るさ・色・動きで点数を付ける。
  // 手ぶれ（画面全体が大きく動く）と、撮り始め・撮り終わり（ポケットの出し入れ）は下げる。点数は動画を足した後で裏で出す
  var analyzing = Promise.resolve();
  function analyzeLater(m) {
    analyzing = analyzing.then(function () { return analyzeVideo(m); }).catch(function () {}).then(function () {
      if (media.indexOf(m) < 0) return;
      if (openIdx === media.indexOf(m)) renderList();
      refreshShow();
    });
  }
  async function analyzeVideo(m) {
    var el = document.createElement("video");
    el.src = m.url; el.muted = true; el.playsInline = true; el.preload = "auto";
    await new Promise(function (ok) { el.onloadeddata = ok; el.onerror = ok; setTimeout(ok, 8000); });
    var full = el.duration && isFinite(el.duration) ? el.duration : 0;
    if (!full || !el.videoWidth) return;
    var n = Math.min(90, Math.max(2, Math.round(full / 0.5))), step = full / n;
    var c = document.createElement("canvas"); c.width = 64; c.height = 36;
    var x = c.getContext("2d", { willReadFrequently: true }), prev = null, raw = [], strip = [];
    for (var i = 0; i < n; i++) {
      var t = Math.min(full - 0.05, (i + 0.5) * step);
      await seek(el, t);
      x.drawImage(el, 0, 0, 64, 36);
      var d = x.getImageData(0, 0, 64, 36).data, Y = new Float32Array(64 * 36), sat = 0, mean = 0;
      for (var q = 0, j = 0; q < d.length; q += 4, j++) {
        var r = d[q] / 255, g = d[q + 1] / 255, b = d[q + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        Y[j] = 0.299 * r + 0.587 * g + 0.114 * b; mean += Y[j]; sat += mx ? (mx - mn) / mx : 0;
      }
      mean /= Y.length; sat /= Y.length;
      var lap = 0, cnt = 0;
      for (var yy = 1; yy < 35; yy++) for (var xx = 1; xx < 63; xx++) {
        var k = yy * 64 + xx; lap += Math.abs(4 * Y[k] - Y[k - 1] - Y[k + 1] - Y[k - 64] - Y[k + 64]); cnt++;
      }
      var motion = 0;
      if (prev) { for (var z = 0; z < Y.length; z++) motion += Math.abs(Y[z] - prev[z]); motion /= Y.length; }
      prev = Y;
      raw.push({ t: t, sharp: lap / cnt, mean: mean, sat: sat, motion: motion });
      if (strip.length < Math.floor((i + 1) * 8 / n)) strip.push(videoThumb(el, 80, 80));
    }
    var maxS = Math.max.apply(null, raw.map(function (o) { return o.sharp; })) || 1;
    var maxC = Math.max.apply(null, raw.map(function (o) { return o.sat; })) || 1;
    m.scores = raw.map(function (o) {
      var sc = 0.45 * o.sharp / maxS + 0.25 * (1 - Math.abs(o.mean - 0.5) * 2) + 0.2 * o.sat / maxC + 0.1 * Math.min(1, o.motion / 0.04);
      if (o.motion > 0.12) sc -= (o.motion - 0.12) * 4;          // 手ぶれ・振り回し
      if (o.t < 0.4 || o.t > full - 0.4) sc -= 0.3;               // 撮り始めと撮り終わり
      return { t: o.t, s: sc };
    });
    m.full = full; m.strip = strip;
    el.removeAttribute("src"); el.load();
  }
  function bestStart(m, len) {   // len 秒を切り出すとき、点数の平均がいちばん高い始まり
    if (!m.scores || !m.full || m.full <= len) return 0;
    var best = 0, bestS = -Infinity, step = m.full / m.scores.length;
    for (var st = 0; st <= m.full - len + 1e-6; st += step / 2) {
      var sum = 0, n = 0;
      m.scores.forEach(function (o) { if (o.t >= st && o.t <= st + len) { sum += o.s; n++; } });
      if (n && sum / n > bestS) { bestS = sum / n; best = st; }
    }
    return Math.round(best * 10) / 10;
  }
  function vstart(m) {   // 動画のどこから使うか: 手で選んだ場面、無ければおすすめ
    if (!m || m.kind !== "video") return 0;
    var room = Math.max(0, (m.full || m.dur || 0) - (m.clipLen || 0));
    return Math.max(0, Math.min(room, m.clipManual != null ? m.clipManual : (m.autoStart || 0)));
  }
  var vbinEl = null;
  function vbin() {
    if (!vbinEl) {
      vbinEl = document.createElement("div");
      vbinEl.setAttribute("aria-hidden", "true");
      // 動画は画面の中（作る動画の絵の裏）に置く。画面外や透明だと、Android の Chrome は再生や絵の更新を止めることがある
      vbinEl.style.cssText = "position:absolute;left:0;top:0;width:96px;height:96px;overflow:hidden;z-index:0;pointer-events:none";
      (document.querySelector(".fly-phone") || document.body).appendChild(vbinEl);
    }
    return vbinEl;
  }
  // 絵を描ける状態か（動画は頭出しが済んで絵があるときだけ）。描けないときは地図を出す（黒い画面や前の絵が残るのを防ぐ）
  // 動画の絵が描けるか: 端末によっては、再生できても絵を取り出すと黒や透明になる（HDR・HEVC をハードウェアで再生するとき）。
  // その絵を描くと写真の枠が白く抜けるので、中身のある絵だけを使う。無いときは地図を出す
  function mediaReady(m) {
    if (!m) return false;
    if (m.kind !== "video") return !!m.img;
    return (vidLive(m) && m.liveOK !== false) || !!(m.lastCv && m.frameOK) || !!(m.dframes && m.dframes.length);   // 頭出し中は、最後に描けた絵で代わりにする
  }
  function vidLive(m) { return m.el.readyState >= 2 && m.el.videoWidth > 0 && !m.el.seeking; }
  // ---- 再生している動画から絵が取れない端末（HDR・HEVC をハードウェアで再生すると黒・透明になる）のために、
  // 動画のファイルを分解して（mp4box）、ブラウザのデコーダー（WebCodecs）で使う場面だけを自分で絵にする
  var mp4boxP = null;
  function loadMp4box() {
    if (window.MP4Box) return Promise.resolve();
    if (!mp4boxP) mp4boxP = new Promise(function (ok, ng) {
      var sc = document.createElement("script"); sc.src = "https://cdn.jsdelivr.net/npm/mp4box@0.5.3/dist/mp4box.all.min.js";
      sc.onload = ok; sc.onerror = function () { mp4boxP = null; ng(new Error("部品を読み込めませんでした")); }; document.head.appendChild(sc);
    });
    return mp4boxP;
  }
  function matRot(mx) {   // 動画の回転（縦で撮った動画は横の絵に回転の印が付いている）
    if (!mx || mx.length < 5) return 0;
    var a = mx[0] / 65536, b = mx[1] / 65536, r = Math.round(Math.atan2(b, a) / rad);
    return ((r % 360) + 360) % 360;
  }
  async function demux(m) {   // サンプルの位置と時刻の一覧（中身はあとで必要な所だけ読む）
    if (m.demux) return m.demux;
    await loadMp4box();
    var file = MP4Box.createFile(), info = null, err = null;
    file.onError = function (e) { err = e; };
    file.onReady = function (inf) { info = inf; };
    var f = m.file, pos = 0, CH = 4 * 1024 * 1024, guard = 0;
    while (!info && !err && pos < f.size && guard++ < 400) {
      var buf = await f.slice(pos, pos + CH).arrayBuffer(); buf.fileStart = pos;
      var next = file.appendBuffer(buf);
      pos = next > pos ? next : pos + CH;   // 映像の中身（mdat）は読み飛ばして、目次（moov）を探す
    }
    if (!info) throw new Error(err ? String(err) : "動画の目次を読めませんでした");
    var tr = info.videoTracks[0]; if (!tr) throw new Error("映像が入っていません");
    var trak = file.getTrackById(tr.id), entry = trak.mdia.minf.stbl.stsd.entries[0];
    var box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C, desc;
    if (box) { var ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN); box.write(ds); desc = new Uint8Array(ds.buffer, 8); }
    m.demux = { codec: tr.codec, w: tr.video.width, h: tr.video.height, desc: desc, rot: matRot(tr.matrix),
      samples: trak.samples.map(function (x) { return { cts: x.cts / x.timescale, dts: x.dts / x.timescale, dur: x.duration / x.timescale, key: x.is_sync, off: x.offset, size: x.size }; }) };
    return m.demux;
  }
  async function decodeClip(m, start, len) {   // start から len 秒を、毎秒 12 コマの絵にする（長い辺 640px、回転も直す）
    var D = await demux(m);
    if (!window.VideoDecoder) throw new Error("このブラウザは動画の分解に対応していません");
    var cfg = { codec: D.codec, codedWidth: D.w, codedHeight: D.h };
    if (D.desc) cfg.description = D.desc;
    var sup = await VideoDecoder.isConfigSupported(cfg);
    if (!sup.supported) throw new Error("この端末は " + D.codec + " を読めません");
    var S = D.samples, i0 = 0;
    for (var i = 0; i < S.length; i++) if (S[i].key && S[i].cts <= start + 0.001) i0 = i;
    var end = start + len + 0.1, frames = [], pend = [], last = -1, rot = D.rot, sc = 640 / Math.max(D.w, D.h);
    var ow = Math.round((rot % 180 ? D.h : D.w) * sc), oh = Math.round((rot % 180 ? D.w : D.h) * sc), failed = null;
    var dec = new VideoDecoder({
      output: function (fr) {
        var t = fr.timestamp / 1e6;
        if (t < start - 0.05 || t > end || t - last < 1 / 12 - 0.005) { fr.close(); return; }
        last = t;
        var c = document.createElement("canvas"); c.width = ow; c.height = oh;
        var x = c.getContext("2d"); x.translate(ow / 2, oh / 2); x.rotate(rot * rad);
        var dw = (rot % 180 ? oh : ow), dh = (rot % 180 ? ow : oh);
        try { x.drawImage(fr, -dw / 2, -dh / 2, dw, dh); } catch (e) { /* 描けない絵は飛ばす */ }
        fr.close();
        frames.push({ t: t - start, cv: c });
      },
      error: function (e) { failed = e; }
    });
    dec.configure(cfg);
    for (var j = i0; j < S.length && S[j].dts <= end + 0.5; j++) {
      if (failed) break;
      var data = await m.file.slice(S[j].off, S[j].off + S[j].size).arrayBuffer();
      dec.decode(new EncodedVideoChunk({ type: S[j].key ? "key" : "delta", timestamp: Math.round(S[j].cts * 1e6), duration: Math.round(S[j].dur * 1e6), data: data }));
      while (dec.decodeQueueSize > 6) await new Promise(function (ok) { setTimeout(ok, 5); });
    }
    if (!failed) await dec.flush().catch(function (e) { failed = e; });
    try { dec.close(); } catch (e) { /* 閉じ済み */ }
    if (failed && !frames.length) throw failed;
    frames.sort(function (a, b) { return a.t - b.t; });
    if (!frames.length || !hasPixels(frames[Math.floor(frames.length / 2)].cv)) throw new Error("分解しても絵が黒いままでした");
    return frames;
  }
  var decoding = {};
  function needDecode(m) { return m.kind === "video" && m.noFrame && !m.frameOK && !m.decodeErr; }
  function queueDecode(m) {   // 使う場面が決まったら（変わったら）作り直す
    if (!needDecode(m) || !m.clipLen) return null;
    var st0 = vstart(m), key = st0.toFixed(2) + ":" + m.clipLen.toFixed(2);
    if (m.dkey === key) return null;
    if (decoding[m.url] && decoding[m.url].key === key) return decoding[m.url].p;
    var pr = decodeClip(m, st0, Math.max(m.clipLen, 1.5)).then(function (fr) {
      m.dframes = fr; m.dkey = key; m.dstart = st0;
      m.thumb = frameThumb(fr[0].cv, fr[0].cv.width, fr[0].cv.height); m.pinCv = null;
      if (!m.lastCv) { m.lastCv = fr[0].cv; }
      renderList(); if (!sp.playing && !busy) renderAt(sp.t, false);
    }).catch(function (e) {
      m.decodeErr = (e && e.message || String(e));
      var D = m.demux;
      status(m.name + " は、この端末では絵にできませんでした（" + m.decodeErr + (D ? "・" + D.codec + "・" + D.w + "×" + D.h : "") + "）。この動画は使わずに作ります。");
      renderList(); if (sp.show) refreshShow();
    }).then(function () { delete decoding[m.url]; });
    decoding[m.url] = { key: key, p: pr };
    return pr;
  }
  function decodedFrame(m) {   // 今の時刻の絵（ファイルから作った絵）
    var F = m.dframes; if (!F || !F.length) return null;
    var lt = (m.localT || 0) + vstart(m) - (m.dstart || 0), best = F[0];
    for (var i = 0; i < F.length && F[i].t <= lt + 0.001; i++) best = F[i];
    return best.cv;
  }
  var probeCv = null;
  function hasPixels(src) {   // 小さく描いて、黒でも透明でもない点があるか
    try {
      // willReadFrequently（CPU の画面）だと、Android でハードウェアで再生した動画の絵が黒になることがあるので使わない
      probeCv = probeCv || Object.assign(document.createElement("canvas"), { width: 16, height: 16 });
      var x = probeCv.getContext("2d");
      x.clearRect(0, 0, 16, 16); x.drawImage(src, 0, 0, 16, 16);
      var d = x.getImageData(0, 0, 16, 16).data;
      // 黒は (16,16,16) 前後で出ることがあるので、それより明るい点が少しでもあるかで見る
      var n = 0;
      for (var i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] + d[i + 1] + d[i + 2] > 75) n++;
      return n >= 3;
    } catch (e) { return false; }
  }
  function keepFrame(m) {   // 動画の今の絵を取っておく（次に頭出しで絵が無くなっても、これを出す）
    var now = performance.now();
    if (m.lastCv && now - (m.lastAt || 0) < 150) return;
    m.lastAt = now;
    m.liveOK = hasPixels(m.el);
    if (!m.liveOK) return;   // 中身の無い絵で、前に取っておいた絵を上書きしない
    var c = m.lastCv || (m.lastCv = document.createElement("canvas")), sc = Math.min(1, 720 / Math.max(m.el.videoWidth, m.el.videoHeight));
    c.width = Math.round(m.el.videoWidth * sc); c.height = Math.round(m.el.videoHeight * sc);
    try { c.getContext("2d").drawImage(m.el, 0, 0, c.width, c.height); m.frameOK = true; } catch (e) { /* まだ描けない */ }
  }
  // 入れたときに少しだけ再生して、絵が取り出せるかを確かめる（止めたままだと、Android では最初の絵が黒のことがある）
  async function primeVideo(m) {
    var el = m.el;
    if (Q.get("noframe") === "1") return false;   // 試験用: 絵が取り出せない端末を真似る
    m.lastAt = 0; keepFrame(m);   // 止めたままで取り出せる端末は、ここで済む
    for (var tries = 0; tries < 2 && !m.frameOK; tries++) {
      if (tries) await seek(el, (el.duration || 2) / 2);   // 2 回目は真ん中で（撮り始めが本当に真っ暗な動画もある）
      var played = el.play();
      if (played && played.catch) played.catch(function () { /* 自動再生できない端末: 止めたままの絵で確かめる */ });
      await new Promise(function (ok) {
        var done = false, fin = function () { if (!done) { done = true; ok(); } };
        if (el.requestVideoFrameCallback) el.requestVideoFrameCallback(function () { setTimeout(fin, 60); }); else el.addEventListener("timeupdate", fin, { once: true });
        setTimeout(fin, 1200);
      });
      el.pause();
      m.lastAt = 0; keepFrame(m);
    }
    try { el.currentTime = 0; } catch (e) { /* そのまま */ }
    return !!m.frameOK;
  }
  function frameThumb(src, sw, sh) {   // 縦横比を保った小さな絵（一覧で縦か横かが分かる）
    try {
      var sc = 200 / Math.max(sw, sh), c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(sw * sc)); c.height = Math.max(1, Math.round(sh * sc));
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.8);
    } catch (e) { return ""; }
  }
  // 1 枚の絵の点数（おまかせで選ぶとき用）: ピント・明るさ・色。動画の場面選びと同じ考え方
  function frameScore(src, sw, sh) {
    try {
      var c = document.createElement("canvas"); c.width = 64; c.height = 48;
      var x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(src, 0, 0, 64, 48);
      var d = x.getImageData(0, 0, 64, 48).data, Y = new Float32Array(64 * 48), sat = 0, mean = 0;
      for (var q = 0, j = 0; q < d.length; q += 4, j++) {
        var r = d[q] / 255, g = d[q + 1] / 255, b = d[q + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        Y[j] = 0.299 * r + 0.587 * g + 0.114 * b; mean += Y[j]; sat += mx ? (mx - mn) / mx : 0;
      }
      mean /= Y.length; sat /= Y.length;
      var lap = 0, n = 0;
      for (var yy = 1; yy < 47; yy++) for (var xx = 1; xx < 63; xx++) { var k = yy * 64 + xx; lap += Math.abs(4 * Y[k] - Y[k - 1] - Y[k + 1] - Y[k - 64] - Y[k + 64]); n++; }
      return 0.45 * Math.min(1, lap / n / 0.25) + 0.3 * (1 - Math.abs(mean - 0.5) * 2) + 0.25 * Math.min(1, sat / 0.45);
    } catch (e) { return 0.5; }
  }
  function videoThumb(el, tw, th) {
    try {
      var c = document.createElement("canvas"); c.width = tw || 96; c.height = th || 96;
      var s = Math.min(el.videoWidth, el.videoHeight) || 1;
      c.getContext("2d").drawImage(el, (el.videoWidth - s) / 2, (el.videoHeight - s) / 2, s, s, 0, 0, c.width, c.height);
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
      if (m.placed === "manual" && m.manualFor === route.id) return;   // 手で合わせた位置はそのまま
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
    var anchors = media.filter(function (m) { return m.d != null && rest.indexOf(m) < 0; }).sort(function (a, b) { return key(a) - key(b); });
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
    // 歩いた時間（前後 1 時間）の外で撮ったものは使わない。手で「使う」にしたものはそのまま
    var T0 = route.times && route.times.find(function (x) { return x != null; }), T1 = route.times && route.times.slice().reverse().find(function (x) { return x != null; });
    media.forEach(function (m) {
      if (m.forceUse || m.skipBy === "user") return;
      var u = m.utc != null ? m.utc : (m.local != null && tz ? m.local - tz.ms : null);
      var out = T0 != null && u != null && (u < T0 - 3600000 || u > T1 + 3600000);
      if (out) { m.skip = true; m.skipBy = "time"; } else if (m.skipBy === "time") { m.skip = false; m.skipBy = null; }
    });
  }
  function usedMedia() { return media.filter(function (m) { return !m.skip && !(m.decodeErr && !m.frameOK); }); }
  // おまかせ: 道を n 区間に分け、各区間でいちばん良い 1 本（★は必ず）。空いた区間の分は、残りから良い順に
  function quality(m) { return (m.q != null ? m.q : 0.5) + (m.kind === "video" ? 0.15 : 0) + (m.dir != null ? 0.05 : 0); }
  function autoPick(n) {
    var cand = media.filter(function (m) { return m.skipBy !== "time" && m.skipBy !== "user"; }), pick = cand.filter(function (m) { return m.star; }).slice(0, 1);
    for (var b = 0; b < n && pick.length < n; b++) {
      var lo = route.len * b / n, hi = route.len * (b + 1) / n + (b === n - 1 ? 1 : 0);
      if (pick.some(function (m) { return m.d >= lo && m.d < hi; })) continue;
      var inBin = cand.filter(function (m) { return pick.indexOf(m) < 0 && m.d >= lo && m.d < hi; }).sort(function (a, c) { return quality(c) - quality(a); });
      if (inBin[0]) pick.push(inBin[0]);
    }
    cand.filter(function (m) { return pick.indexOf(m) < 0; }).sort(function (a, c) { return quality(c) - quality(a); })
      .slice(0, Math.max(0, n - pick.length)).forEach(function (m) { pick.push(m); });
    cand.forEach(function (m) { var on = pick.indexOf(m) >= 0; m.skip = !on; m.skipBy = on ? null : "auto"; if (on) m.forceUse = false; });
  }
  function useAll() { media.forEach(function (m) { if (m.skip) { m.skip = false; m.skipBy = null; m.forceUse = true; } }); }
  function placeText(m) {
    var near = nearestStop(m.d), nearTxt = near && Math.abs(near.d - m.d) < 1500 ? "・" + near.name.ja + "付近" : "";
    if (m.placed === "gps") return "撮影地点（位置情報）" + nearTxt;
    if (m.placed === "time") return "撮影時刻を GPX の時刻と照合" + (m.utc == null && tz ? "（時差 " + fmtOffset(tz.ms) + "）" : "") + nearTxt;
    if (m.placed === "manual") return "手で合わせた位置" + nearTxt;
    var hasTime = m.local != null || m.utc != null;
    var why = m.far ? "位置が道から 3km 以上離れている" : m.kind === "image" && m.exif ? "位置情報が外されている" : "位置情報なし";
    var how = !hasTime ? "撮った順に並べた" : route.times ? "撮影時刻が GPX の時間外" : "撮影時刻の順に並べた（道に時刻が無い）";
    return why + "・" + how + nearTxt;
  }
  function fmtOffset(ms) { var s = ms < 0 ? "-" : "+", a = Math.abs(ms) / 60000; return s + Math.floor(a / 60) + ":" + String(a % 60).padStart(2, "0"); }
  var openIdx = -1;   // 編集欄を開いている写真
  var ICON_CUT = '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="6" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var ICON_EDIT = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  function badgeOf(m) {
    if (m.placed === "gps") return ["位置", ""];
    if (m.placed === "time") return ["時刻", ""];
    if (m.placed === "manual") return ["手動", ""];
    return ["目安", " is-warn"];
  }
  function clipText(m) {
    var a = vstart(m), b = a + (m.clipLen || m.dur || 0);
    var sec = function (x) { return x < 60 ? x.toFixed(1) : fmtT(x); };
    return "使う場面 " + sec(a) + "〜" + sec(Math.min(b, m.full || b)) + " 秒" + (m.clipManual != null ? "（手で選択）" : m.scores ? "（おすすめ）" : "（場面を調べています…）");
  }
  function trimUi(m, i) {
    var box = document.createElement("div"); box.className = "fly-trim";
    var lab = document.createElement("p"); lab.className = "fly-trim-label"; lab.textContent = clipText(m); box.appendChild(lab);
    var strip = document.createElement("div"); strip.className = "fly-strip";
    (m.strip || []).forEach(function (u) { var im = document.createElement("img"); im.alt = ""; im.src = u; strip.appendChild(im); });
    var win = document.createElement("span"); win.className = "fly-win"; strip.appendChild(win);
    box.appendChild(strip);
    var full = m.full || m.dur || 1, len = Math.min(full, m.clipLen || m.dur || 1);
    var place = function () { win.style.left = (vstart(m) / full * 100) + "%"; win.style.width = (len / full * 100) + "%"; };
    place();
    var r = document.createElement("input");
    r.type = "range"; r.className = "fly-clip"; r.dataset.clip = String(i); r.min = "0"; r.step = "0.1";
    r.max = String(Math.max(0, Math.floor((full - len) * 10) / 10)); r.value = String(vstart(m)); r.disabled = full - len < 0.1;
    r.setAttribute("aria-label", "動画の使う場面");
    box.appendChild(r);
    if (m.clipManual != null) {
      var au = document.createElement("button"); au.type = "button"; au.className = "fly-btn fly-btn-ghost fly-clip-auto"; au.dataset.clipAuto = String(i);
      au.textContent = "おすすめに戻す"; box.appendChild(au);
    }
    box._place = place;
    return box;
  }
  function showClip(m) {   // 選んだ場面をすぐ画面で見せる（その動画の場面へ移って止める）
    var e = sp.show && sp.show.ev.find(function (x) { return (x.kind === "photo" || x.kind === "media") && x.m === m; });
    if (!e) return;
    pauseSp();
    sp.t = e.kind === "media" ? e.t0 + Math.min((e.t1 - e.t0) * 0.45, e.sin ? 0.4 : 0.02) : e.t0 + (e.t1 - e.t0) * (e.fin === false ? 0.02 : 0.24);
    renderAt(sp.t, false);
  }
  function renderList() {
    var ol = $("fly-list"); ol.innerHTML = "";
    media.forEach(function (m, i) {
      var li = document.createElement("li");
      if (m.kind === "video") li.className = "is-video";
      if (i === openIdx) li.className += " is-open";
      if (m.skip) li.className += " is-skip";
      var card = document.createElement("button");
      card.type = "button"; card.className = "fly-card"; card.dataset.open = String(i);
      card.setAttribute("aria-label", m.name + (m.kind === "video" ? "（使う場面と場所を直す）" : "（場所を直す）")); card.setAttribute("aria-expanded", String(i === openIdx));
      var im = document.createElement("img"); im.alt = ""; if (m.thumb) im.src = m.thumb; card.appendChild(im);
      var bd = m.skip ? [m.skipBy === "time" ? "時間外" : "使わない", " is-off"] : badgeOf(m), badge = document.createElement("span");
      badge.className = "fly-badge" + bd[1]; badge.textContent = bd[0]; card.appendChild(badge);
      var ico = document.createElement("span"); ico.className = "fly-ico"; ico.setAttribute("aria-hidden", "true");
      ico.innerHTML = m.kind === "video" ? ICON_CUT : ICON_EDIT; card.appendChild(ico);
      if (m.kind === "video") { var du = document.createElement("span"); du.className = "fly-dur"; du.textContent = "▶ " + fmtT(m.full || m.dur || 0); card.appendChild(du); }
      if (m.kind === "video" && m.decodeErr && !m.frameOK) { li.className += " is-noframe is-skip"; badge.textContent = "使えない"; badge.className = "fly-badge is-off"; card.title = m.decodeErr; }
      li.appendChild(card);
      var star = document.createElement("button");
      star.type = "button"; star.className = "fly-star" + (m.star ? " is-on" : ""); star.dataset.star = String(i);
      star.textContent = m.star ? "★" : "☆"; star.setAttribute("aria-label", "最初に出す"); star.setAttribute("aria-pressed", String(!!m.star));
      li.appendChild(star);
      ol.appendChild(li);
      if (i === openIdx) {
        var ed = document.createElement("li"); ed.className = "fly-edit";
        var tx = document.createElement("p"); tx.textContent = placeText(m) + (m.dir != null ? "・撮影方向あり" : ""); ed.appendChild(tx);
        var pos = document.createElement("input");
        pos.type = "range"; pos.min = "0"; pos.max = "1000"; pos.className = "fly-pos"; pos.dataset.pos = String(i);
        pos.value = String(Math.round(m.d / route.len * 1000)); pos.setAttribute("aria-label", "道の上の場所");
        ed.appendChild(pos);
        if (m.kind === "video") ed.appendChild(trimUi(m, i));
        var bx = document.createElement("div"); bx.className = "fly-edit-buttons";
        var use = document.createElement("button"); use.type = "button"; use.className = "fly-btn fly-btn-ghost fly-use"; use.dataset.use = String(i);
        use.textContent = m.skip ? "動画に使う" + (m.skipBy === "time" ? "（歩いた時間の外で撮影）" : "") : "動画に使わない";
        var rm = document.createElement("button"); rm.type = "button"; rm.className = "fly-btn fly-btn-ghost fly-rm-media"; rm.dataset.rmMedia = String(i); rm.textContent = "一覧から消す";
        bx.appendChild(use); bx.appendChild(rm); ed.appendChild(bx);
        ol.appendChild(ed);
      }
    });
    if ($("fly-empty")) $("fly-empty").hidden = media.length > 0 || sp.playing || !$("fly-loading").hidden;
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
      // 毎回コピーを渡す（ベクトルタイルは作業スレッドへ移されて元が空になるので、保存庫の元データは渡さない）
      return getTile(params.url.replace(/^gsic:\/\//, "https://")).then(function (buf) { return { data: buf.slice(0) }; });
    });
  }
  var TILE = { photo: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", dem: "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png",
               eox: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg",
               demw: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
               vec: "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf" };
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
        var n = Math.pow(2, z), tx = ((t[0] + dx) % n + n) % n, ty = t[1] + dy;   // 経度は一周させ、緯度の端の外は読まない
        if (ty < 0 || ty >= n) continue;
        var key = tx + "/" + ty;
        if (seen[key]) continue;
        seen[key] = true;
        var url = TILE[kind].replace("{z}", z).replace("{x}", tx).replace("{y}", ty);
        if (!store.has(url) && queue.indexOf(url) < 0) queue.push(url);
      }
    }
    pump();
  }
  function prefetchBase() {   // ルートを開いたとき: 標高と、下敷きの粗い写真を道全体で（数十枚）
    queue = [];
    var jp = REGION === "jp";
    [9, 10, 11, 12].forEach(function (z) { want(jp ? "dem" : "demw", z, 0, route.len, 1); });
    [10, 11, 12, 13].forEach(function (z) { want(jp ? "photo" : "eox", z, 0, route.len, 1); });
    // 近づいたときに急に細かい写真へ切り替わって見えるのを減らす: z14 は道全体を先に（数十枚）
    want(jp ? "photo" : "eox", 14, 0, route.len, 1);
  }
  var lastAhead = -1e9;
  function prefetchAhead(d) {   // 再生中: 現在地から先 3.5km の細かい写真（500m 進むごとに足す）
    if (Math.abs(d - lastAhead) < 500) return;
    lastAhead = d;
    var ph = REGION === "jp" ? "photo" : "eox";
    want(ph, 14, d, d + 6000, 1);
    want(ph, 15, d, d + 3000, 0);
  }

  // ------------------------------------------------------------------ 地図
  function initMap() {
    map = new maplibregl.Map({
      container: "fly-map", attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      // ちらつき対策: 切り替えをフェードでなめらかにし、細かさの違うタイルを多めに持っておく。画素比は 2 まで（3 だと重くてカクつく）
      // 文字のフェードは切る（「読み込み完了」がフェードの終わりを待つので、書き出しが 1 コマごとに遅くなる）
      maxPitch: 80, fadeDuration: 0, maxTileCacheZoomLevels: 8, pixelRatio: Math.min(2, window.devicePixelRatio || 1),
      style: {
        version: 8,
        // 地理院が配っている日本語フォント（地理院地図 Vector と同じもの）
        glyphs: "https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs/{fontstack}/{range}.pbf",
        sources: {
          // 海外と、地球から寄る場面のための世界の素材。日本では下に敷くだけで、地理院の写真がその上に重なる
          // EOxCloudless は非商用なら無料（CC BY-NC-SA 4.0）。商用で出すときは EOX の有料ライセンスか別の写真に替える
          eox: { type: "raster", tiles: ["gsic://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg"], tileSize: 256, maxzoom: 15,
                   attribution: "EOxCloudless 2025 (Contains modified Copernicus Sentinel data 2025)" },
          "dem-w": { type: "raster-dem", tiles: ["gsic://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 12, encoding: "terrarium",
                     attribution: "Terrain Tiles (AWS Open Data)" },
          "dem-w-hs": { type: "raster-dem", tiles: ["gsic://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 12, encoding: "terrarium" },
          ofm: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
          // 注記は z14 までで足りる（それより細かい段は数が多く、読み込みで書き出しが遅くなる）
          gsiv: { type: "vector", tiles: ["gsic://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf"], minzoom: 4, maxzoom: 14, attribution: "国土地理院" },
          photo: { type: "raster", tiles: ["gsic://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 16,
                   attribution: "国土地理院" },
          // 地理院の標高 PNG: 標高 = (R×2^16 + G×2^8 + B) × 0.01 m
          // 標高は z12 まで（約 30m 格子）。z14 まで使うと動くたびに地形の細かさが切り替わって山がちらつく
          dem: { type: "raster-dem", tiles: ["gsic://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"], tileSize: 256, minzoom: 6, maxzoom: 12,
                 encoding: "custom", redFactor: 655.36, greenFactor: 2.56, blueFactor: 0.01, baseShift: 0 },
          "photo-lo": { type: "raster", tiles: ["gsic://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 13 },
          "dem-hs": { type: "raster-dem", tiles: ["gsic://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"], tileSize: 256, minzoom: 6, maxzoom: 12,
                      encoding: "custom", redFactor: 655.36, greenFactor: 2.56, blueFactor: 0.01, baseShift: 0 },
          world: { type: "geojson", data: { type: "Feature", geometry: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } }
        },
        layers: [
          { id: "eox", type: "raster", source: "eox", paint: { "raster-saturation": 0.1, "raster-contrast": 0.1, "raster-fade-duration": 0 } },
          // 下敷き: 粗い写真（z13 まで）。枚数が少なくすぐ揃うので、細かい写真が届く前も灰色にならない
          // 地理院の航空写真は z13 以下と z14 以上で元の写真が違い、z13 以下はかなり暗い（燕岳付近で平均 RGB 40,75,67 と 103,129,123）。
          // そのままだと細かい写真に切り替わるたびに山の色が変わるので、下敷きを明るく持ち上げて色をそろえる
          { id: "photo-lo", type: "raster", source: "photo-lo", minzoom: 8, paint: { "raster-saturation": -0.05, "raster-contrast": -0.1, "raster-brightness-min": 0.2, "raster-fade-duration": 0 } },
          // 航空写真の色: 少し彩度とコントラストを上げ、くすみを取る（地理院の写真は撮影時期で色がばらつく）
          { id: "photo", type: "raster", source: "photo", minzoom: 8, paint: { "raster-saturation": 0.18, "raster-contrast": 0.14, "raster-brightness-min": 0.02, "raster-fade-duration": 400 } },
          // 日の当たり方: 太陽の方位から影を落とす（地形用とは別の標高ソースを使う。同じソースを共有すると描画が乱れることがある）
          { id: "hs", type: "hillshade", source: "dem-hs", minzoom: 8, paint: { "hillshade-illumination-anchor": "map", "hillshade-illumination-direction": 315, "hillshade-exaggeration": 0.3 } },
          { id: "hs-w", type: "hillshade", source: "dem-w-hs", layout: { visibility: "none" }, paint: { "hillshade-illumination-anchor": "map", "hillshade-illumination-direction": 315, "hillshade-exaggeration": 0.3 } },
          // 朝夕の赤み・夜の暗さを全体に薄く重ねる
          { id: "tint", type: "fill", source: "world", paint: { "fill-color": "#ff9a55", "fill-opacity": 0 } }
        ],
        sky: { "sky-color": "#9cc3e4", "horizon-color": "#e8eef2", "fog-color": "#dde6ea", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.85 }
      },
      center: [137.69, 36.36], zoom: 11, pitch: 0
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
    // 日本の外・海の上などタイルが無い所の 404 はエラーにしない（下の層がそのまま見える）
    map.on("error", function (e) { var m = e && e.error && e.error.message || ""; if (!/HTTP 40[034]/.test(m)) console.error(e && e.error || e); });
    return new Promise(function (ok) { map.on("load", function () { try { map.setProjection({ type: "globe" }); } catch (e) { /* 地球儀の無い版 */ } ok(); }); });
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
  function progressExpr(frac) {
    var fr = Math.min(0.999999, Math.max(0.000001, frac)), pa = paceOn() ? paceArr() : null;
    if (!pa) return ["step", ["line-progress"], DONE, fr, REST];
    if (frac >= 0.9999) return paceInterp(pa);
    // 通った所はペースの色、残りは赤（段で塗る。step は区切りが昇順でないといけない）
    var ex = ["step", ["line-progress"], paceColor(pa[0])];
    for (var i = 1; i < pa.length; i++) { var q = i / (pa.length - 1); if (q >= fr) break; ex.push(q, paceColor(pa[i])); }
    ex.push(fr, REST);
    return ex;
  }
  // ペース: 300m ごとに、標準の速さ（平地 4km/h・登り 300m/h・下り 500m/h）に対して何倍で歩いたか。1 時間を超えて止まった所は前後で埋める
  function paceArr() {
    if (!route || !route.times) return null;
    if (route._pace) return route._pace;
    var N = 160, out = [];
    for (var i = 0; i <= N; i++) {
      var d = route.len * i / N, a = Math.max(0, d - 150), b = Math.min(route.len, d + 150);
      var ta = timeAt(a), tb = timeAt(b), ea = eleAt(a), eb = eleAt(b);
      if (ta == null || tb == null || tb <= ta) { out.push(null); continue; }
      var h = (tb - ta) / 3600000, up = Math.max(0, (eb || 0) - (ea || 0)), dn = Math.max(0, (ea || 0) - (eb || 0));
      var std = (b - a) / 1000 / 4 + up / 300 + dn / 500;
      out.push(h > 1 ? null : std / h);
    }
    for (var j = 0; j < out.length; j++) if (out[j] == null) out[j] = j ? out[j - 1] : null;
    for (var k = out.length - 1; k >= 0; k--) if (out[k] == null) out[k] = k < out.length - 1 ? out[k + 1] : 1;
    route._pace = out.map(function (v, n) { return ((out[n - 1] != null ? out[n - 1] : v) + v + (out[n + 1] != null ? out[n + 1] : v)) / 3; });
    return route._pace;
  }
  var PACE = [[0.6, [47, 107, 255]], [0.85, [34, 184, 207]], [1.0, [60, 196, 107]], [1.2, [242, 194, 48]], [1.45, [242, 140, 40]], [1.7, [232, 69, 44]]];
  function paceColor(r) {
    if (r <= PACE[0][0]) return "rgb(" + PACE[0][1].join(",") + ")";
    for (var i = 1; i < PACE.length; i++) if (r <= PACE[i][0]) {
      var a = PACE[i - 1], b = PACE[i], f = (r - a[0]) / (b[0] - a[0]);
      return "rgb(" + a[1].map(function (v, k) { return Math.round(v + (b[1][k] - v) * f); }).join(",") + ")";
    }
    return "rgb(" + PACE[PACE.length - 1][1].join(",") + ")";
  }
  function paceInterp(pa) {
    var ex = ["interpolate", ["linear"], ["line-progress"]];
    pa.forEach(function (r, i) { ex.push(i / (pa.length - 1), paceColor(r)); });
    return ex;
  }
  function paceOn() { var c = $("fly-pace"); return !!(c && c.checked && route && route.times); }
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
  var markers = [];   // 地図上のピンは使わない（画面にはいつも動画と同じ絵を出す）

  // 日本は地理院（写真・標高・注記）、海外は世界の素材（EOX・AWS・OpenStreetMap）。道の中心がどちらにあるかで決める
  var REGION = "jp";
  function demSrc() { return REGION === "jp" ? "dem" : "dem-w"; }
  function setRegion() {
    var la = route.line.map(function (q) { return q[0]; }), lo = route.line.map(function (q) { return q[1]; });
    var cla = (Math.min.apply(null, la) + Math.max.apply(null, la)) / 2, clo = (Math.min.apply(null, lo) + Math.max.apply(null, lo)) / 2;
    REGION = cla > 24 && cla < 46 && clo > 122 && clo < 154 ? "jp" : "world";
    var vis = function (id, on) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); };
    ["photo-lo", "photo", "hs", "gsi-anno", "gsi-trail"].forEach(function (id) { vis(id, REGION === "jp"); });
    ["hs-w", "ofm-hut"].forEach(function (id) { vis(id, REGION === "world"); });
    var tr = map.getTerrain && map.getTerrain();
    if (tr && tr.source !== demSrc()) { map.setTerrain(null); map.setTerrain({ source: demSrc(), exaggeration: tr.exaggeration }); }
  }
  // 海外の山頂と山小屋: OpenStreetMap（OpenFreeMap のタイル）から、道の近くのものを拾う
  async function worldPlaces() {
    // 地図の画面に出ているかどうかに左右されないよう、道が通るタイルを直接読む（山頂は z13 を道の両側 1 枚まで、山小屋は z14 に
    // しか入っていないので z14 の道が通る所だけ。多くても 60 枚ずつ）
    var src = map.getSource("ofm"), tpl = src && src.tiles && src.tiles[0], id = route.id;
    if (!tpl) return;
    var name = function (pr) { return String(pr["name:ja"] || pr.name_int || pr.name || "").split(/ [-–\/] /)[0].trim(); };
    var read = function (z, r, layer) {
      var keys = {}, step = 40075000 * Math.cos(route.line[0][0] * rad) / Math.pow(2, z) / 2;
      for (var d = 0; d <= route.len + step; d += step) {
        var q = at(route, Math.min(d, route.len)), t = tileXY(q[0], q[1], z);
        for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) keys[(t[0] + dx) + "/" + (t[1] + dy)] = [t[0] + dx, t[1] + dy];
      }
      return Promise.all(Object.keys(keys).slice(0, 60).map(function (k) {
        var t = keys[k];
        return getTile(tpl.replace("{z}", z).replace("{x}", t[0]).replace("{y}", t[1]))
          .then(function (buf) { return vecPoints(buf.slice(0), z, t[0], t[1], layer); }).catch(function () { return []; });
      })).then(function (a) { return [].concat.apply([], a); });
    };
    var got = await Promise.all([read(13, 1, "mountain_peak"), read(14, 0, "poi")]);
    if (!route || route.id !== id) return;
    var seen = {}, peaks = [], hutsW = [];
    got[0].forEach(function (f) {
      var nm = name(f.p), ele = Number(f.p.ele);
      if (!nm || !ele || seen[nm]) return;
      var pj = project([f.lat, f.lon], route); if (pj.off > 2500) return;
      seen[nm] = true;
      peaks.push({ kind: "peak", name: { ja: nm, en: nm }, lat: f.lat, lon: f.lon, elev: Math.round(ele), d: pj.d, off: pj.off });
    });
    got[1].forEach(function (f) {
      if (f.p.subclass !== "alpine_hut" && f.p.subclass !== "wilderness_hut") return;
      var nm = name(f.p); if (!nm || seen[nm]) return;
      var pj = project([f.lat, f.lon], route); if (pj.off > 800) return;
      seen[nm] = true;
      hutsW.push({ id: null, kind: "hut", name: { ja: nm, en: nm }, lat: f.lat, lon: f.lon, elev: null, d: pj.d });
    });
    peaks.sort(function (a, b) { return b.elev - a.elev; });
    route.peaks = peaks.slice(0, 18);
    route.stops = (route.stops || []).filter(function (s) { return s.id != null; }).concat(hutsW);
    setLabelsOnMap();
  }

  async function overview() {   // 道全体を見せ、そのあいだに標高の断面を測る（GPX に標高があればそれを使う）
    map.setTerrain(null);
    var b = new maplibregl.LngLatBounds();
    route.line.forEach(function (p) { b.extend([p[1], p[0]]); });
    map.fitBounds(b, { padding: { top: 90, bottom: 230, left: 40, right: 40 }, duration: 0, pitch: 0, bearing: 0 });
    map.setTerrain({ source: demSrc(), exaggeration: 1 });
    await settle(8000);
    if (REGION === "world") await worldPlaces();
    if (!route.ele) {
      var N = 160, prof = [];
      for (var i = 0; i <= N; i++) {
        var p = at(route, route.len * i / N), e = map.queryTerrainElevation([p[1], p[0]]);
        prof.push(e == null ? null : e);
      }
      route.profile = prof.some(function (x) { return x != null; }) ? prof : null;
    }
    map.setTerrain({ source: demSrc(), exaggeration: EXAG });
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
    ["hs", "hs-w"].forEach(function (id) {
      map.setPaintProperty(id, "hillshade-illumination-direction", s.az);
      map.setPaintProperty(id, "hillshade-exaggeration", ramp(a, [[-6, 0.15], [3, 0.7], [15, 0.45], [50, 0.25]]));
      map.setPaintProperty(id, "hillshade-highlight-color", "rgba(255," + Math.round(lerp(255, 196, warm)) + "," + Math.round(lerp(255, 120, warm)) + "," + (0.18 + 0.25 * warm).toFixed(2) + ")");
      map.setPaintProperty(id, "hillshade-shadow-color", "rgba(" + Math.round(lerp(20, 30, night)) + ",30," + Math.round(lerp(40, 70, night)) + ",0.6)");
    });
    ["eox"].forEach(function (id) { map.setPaintProperty(id, "raster-brightness-max", ramp(a, [[-10, 0.3], [-3, 0.55], [5, 0.92], [20, 1]])); });
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
    return vecPoints(buf, z, x, y, "Anno").map(function (f) {
      return { code: Number(f.p.vt_code), text: f.p.vt_text == null ? "" : String(f.p.vt_text), lat: f.lat, lon: f.lon };
    });
  }
  function vecPoints(buf, z, x, y, want) {   // ベクトルタイルの 1 層から、点（の最初の座標）と属性を取り出す
    var R = pbfReader(buf), out = [];
    R.fields(0, buf.byteLength, function (f, w, layer) {
      if (f !== 3 || w !== 2) return;
      var name = "", keys = [], vals = [], feats = [], extent = 4096;
      R.fields(layer[0], layer[1], function (lf, lw, lv) {
        if (lf === 1) name = R.str(lv);
        else if (lf === 3) keys.push(R.str(lv));
        else if (lf === 4) { var val = null; R.fields(lv[0], lv[1], function (vf, vw, vv) { if (vf === 1) val = R.str(vv); else if (vf === 4 || vf === 5) val = vv; else if (vf === 6) val = vv % 2 ? -(vv + 1) / 2 : vv / 2; }); vals.push(val); }
        else if (lf === 5) extent = lv;
        else if (lf === 2) feats.push(lv);
      });
      if (name !== want) return;
      feats.forEach(function (fr) {
        var tags = [], geom = [];
        R.fields(fr[0], fr[1], function (ff, fw, fv) { if (ff === 2) tags = R.packed(fv); if (ff === 4) geom = R.packed(fv); });
        var props = {}; for (var i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = vals[tags[i + 1]];
        if (geom.length < 3) return;
        var zz = function (n) { return (n >>> 1) ^ -(n & 1); }, px = zz(geom[1]), py = zz(geom[2]), n2 = Math.pow(2, z);
        var lon = (x + px / extent) / n2 * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / extent) / n2))) / rad;
        out.push({ p: props, lat: lat, lon: lon });
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

  // ------------------------------------------------------------------ 動画のプレーヤー（作る動画をそのまま流す・止める・スライドで場面を選ぶ）
  // 記録を残すための「道をたどる再生」はやめ、画面にはいつも書き出す動画と同じ絵を出す
  function localMs(utc) { return utc + (tz ? tz.ms : REGION === "world" && route ? placeTzMs(utc) : -new Date(utc).getTimezoneOffset() * 60000); }
  // 海外で写真に時差の手がかりが無いとき: 歩いた場所の時差を大まかに（端末の時差だと、日本で見ると日本時間になってしまう）
  // 欧州と北米は夏時間も入れる。ほかは経度から。山の多い所（ネパール・インド）は個別に
  function placeTzMs(utc) {
    var la = route.line[0][0], lo = route.line[0][1], H = 3600000, y = new Date(utc).getUTCFullYear();
    var lastSun = function (m) { var d = new Date(Date.UTC(y, m + 1, 0)); return Date.UTC(y, m, d.getUTCDate() - d.getUTCDay()); };
    var nthSun = function (m, n) { var d = new Date(Date.UTC(y, m, 1)); return Date.UTC(y, m, 1 + (7 - d.getUTCDay()) % 7 + 7 * (n - 1)); };
    if (la > 26 && la < 31 && lo > 80 && lo < 88.3) return 5.75 * H;
    if (la > 6 && la < 36 && lo > 68 && lo <= 80) return 5.5 * H;
    if (la > 35 && la < 72 && lo > -11 && lo < 32) {
      var base = (lo < -6 || (la > 49.5 && lo < 2)) ? 0 : lo >= 22 ? 2 : 1;
      return (base + (utc >= lastSun(2) + H && utc < lastSun(9) + H ? 1 : 0)) * H;
    }
    if (la > 24 && la < 70 && lo > -170 && lo < -50) {
      var b = Math.round(lo / 15) * H;
      return b + (utc >= nthSun(2, 2) - b + 2 * H && utc < nthSun(10, 1) - b + H ? H : 0);
    }
    return Math.round(lo / 15) * H;
  }
  function fmtDate(utc) { var d = new Date(localMs(utc)); return d.getUTCFullYear() + "/" + String(d.getUTCMonth() + 1).padStart(2, "0") + "/" + String(d.getUTCDate()).padStart(2, "0") + "(" + JA_DOW[d.getUTCDay()] + ")"; }
  function fmtClock(utc) { var d = new Date(localMs(utc)); return d.getUTCHours() + ":" + String(d.getUTCMinutes()).padStart(2, "0"); }
  function fmtClockNaive(local) { var d = new Date(local); return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + " " + d.getUTCHours() + ":" + String(d.getUTCMinutes()).padStart(2, "0"); }
  function fmtDist(d) { return d < 1000 ? Math.round(d) + " m" : (d / 1000).toFixed(1) + " km"; }
  function fmtT(t) { return Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0"); }

  var sp = { show: null, t: 0, playing: false, last: null };
  function posterT() {   // 最初に見せる場面: ハイライトがあればその中ほど、無ければ線が描き終わった所（題字が見える）
    var ev = sp.show.ev, h = ev[0];
    return h.m ? (h.t0 + h.t1) / 2 : Math.max(0, ev[1].t1 - 0.05);
  }
  function refreshShow() {   // 写真・長さ・★・位置が変わったら組み直し、今の場面を描き直す
    if (!route || !map || busy) return;
    sp.show = buildShow();
    sp.t = Math.min(sp.t, sp.show.total - 0.001);
    renderAt(sp.t, true);
    noteMedia();
  }
  function noteMedia() {   // 本数がおすすめより多いとき・外しているものがあるときだけ、一言とボタン
    var row = $("fly-pick-row"), sh = sp.show;
    if (!row || !sh) return;
    var used = usedMedia().length, rec = sh.rec, T = curLen(), off = media.length - used;
    var byTime = media.filter(function (m) { return m.skip && m.skipBy === "time"; }).length;
    var many = used > rec[1], msg = [];
    if (many) msg.push(T + " 秒には " + used + " 本は多め（おすすめ " + rec[0] + "〜" + rec[1] + " 本）。1 本 約 " + sh.perPhoto.toFixed(1) + " 秒でテンポよく切り替えます。");
    if (off) msg.push(off + " 本を使っていません" + (byTime ? "（歩いた時間の外で撮影 " + byTime + " 本）" : "") + "。");
    row.hidden = !msg.length;
    $("fly-media-note").textContent = msg.join("");
    $("fly-auto-pick").hidden = !many;
    $("fly-auto-pick").textContent = "おまかせで " + rec[1] + " 本に絞る";
    $("fly-use-all").hidden = !off;
  }
  function updateTime() {
    $("fly-seek").value = String(Math.round(sp.t / sp.show.total * 1000));
    $("fly-time").textContent = fmtT(sp.t) + " / " + fmtT(sp.show.total);
  }
  // ---- 撮影地点のピンと、写真の右下の小さな 3D 地図
  function pinLL(m) { var q = m.gps && project(m.gps, route).off < 300 ? m.gps : at(route, m.d); return [q[1], q[0]]; }
  function insetCam(m) {
    var ll = pinLL(m), b = m.dir != null ? m.dir : bearing(railAt(m.d - 800), railAt(m.d + 1600));
    // 周りの山に対してどの辺りかが分かるよう、引いて斜めに見る
    return { center: ll, zoom: 12.6, pitch: 50, bearing: b, elevation: groundAt(ll[0], ll[1], m.d) };
  }
  function pinScreen(m) { var c = map.getCanvas(), q = map.project(pinLL(m)); return [q.x / (c.clientWidth || 360), q.y / (c.clientHeight || 640)]; }
  // 次の描画を待つ。その場で描かせる（map.redraw）と、画像タイルの読み込みの列が壊れて MapLibre の中でエラーになる（v5.24）。
  // そこで上の枠・小さな地図・道の地図は、続くコマで 1 つずつ描く（寄る場面だけコマ数が少し落ちる）
  function renderOnce() { return new Promise(function (ok) { map.once("render", function () { ok(); }); map.triggerRepaint(); }); }
  var topCv = document.createElement("canvas"); topCv.width = W; topCv.height = H;
  var topCx = topCv.getContext("2d"), topPin = null, topFor = null;
  function grabTop(m) { topCx.drawImage(map.getCanvas(), 0, 0, W, H); topPin = pinScreen(m); topFor = m; }
  function grabInset(m, sharp) {
    var c = map.getCanvas(), ps = pinScreen(m), S = Math.round(c.width * 0.66);
    var sx = Math.max(0, Math.min(c.width - S, ps[0] * c.width - S / 2)), sy = Math.max(0, Math.min(c.height - S, ps[1] * c.height - S / 2));
    var cv = m.inset || (m.inset = document.createElement("canvas")); cv.width = cv.height = 300;
    cv.getContext("2d").drawImage(c, sx, sy, S, S, 0, 0, 300, 300);
    m.insetPin = [(ps[0] * c.width - sx) / S * 300, (ps[1] * c.height - sy) / S * 300]; m.insetSharp = !!sharp;
    // 縁をぼかした版（真ん中ははっきり、外へ向かって透ける）
    var f = m.insetF || (m.insetF = document.createElement("canvas")); f.width = f.height = 300;
    var fx = f.getContext("2d"); fx.clearRect(0, 0, 300, 300); fx.drawImage(cv, 0, 0);
    var g = fx.createRadialGradient(150, 150, 112, 150, 150, 150); g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)");
    fx.globalCompositeOperation = "destination-in"; fx.fillStyle = g; fx.fillRect(0, 0, 300, 300); fx.globalCompositeOperation = "source-over";
  }
  function needInset(st) { return false; }   // 右下の小さな 3D 地図はやめた（写真のピンを道の地図に立てる）
  function mapNeeded(st) { return st.photoAlpha < 1 || !mediaReady(st.m); }
  // 読み込みを待たずに 1 コマ（再生・プレビュー・速く作る）。alive() が偽になったら途中でやめる
  async function liveFrame(st, t, playing, show, alive) {
    alive = alive || function () { return true; };
    if (needInset(st)) { map.jumpTo(insetCam(st.m)); setLine(st, "inset"); await renderOnce(); if (!alive()) return false; grabInset(st.m, false); }
    if (st.top) { keepAbove(st.top); setLine(st, "top"); await renderOnce(); if (!alive()) return false; grabTop(st.m); }
    syncVideo(st, t, playing);
    if (mapNeeded(st)) { applyFrame(st, true); await renderOnce(); if (!alive()) return false; }
    compose(st, show);
    return true;
  }
  // 読み込みを待って 1 コマ（書き出し・止めたときの描き直し）。alive() が偽になったら途中でやめる
  async function settledFrame(st, t, show, live, alive) {
    alive = alive || function () { return true; };
    if (st.top) { keepAbove(st.top); setLine(st, "top"); await settle(6000); if (!alive()) return false; grabTop(st.m); }
    if (mapNeeded(st)) {
      if (moving(st)) aim(st.cam, at(route, st.d), live ? 90 : 30 / FPS); else keepAbove(st.cam);
      setLine(st); showProgress(st.d); applyLight(st.d); prefetchAhead(st.d);
      await settle(6000); if (!alive()) return false;
    }
    if (st.m && st.m.kind === "video" && mediaOn(st)) {
      st.m.localT = Math.max(0, st.e.kind === "hook" ? t : t - st.e.t0);
      if (!st.m.dframes) { await seek(st.m.el, vstart(st.m) + st.m.localT); if (!alive()) return false; }
    }
    compose(st, show);
    return true;
  }
  function applyFrame(st, live) {   // 地図をその場面へ（写真が全面のときは地図を動かさない）
    if (st.photoAlpha >= 1) return;
    if (moving(st)) aim(st.cam, at(route, st.d), live ? 1.2 : 90, live ? 6 : 0); else keepAbove(st.cam);
    setLine(st); showProgress(st.d); applyLight(st.d); prefetchAhead(st.d);
  }
  function moving(st) { return st.e.kind === "fly" || st.e.kind === "swoop" || st.e.kind === "media"; }
  function mediaOn(st) { return !!(st.m && (st.photoAlpha > 0 || st.split > 0)); }
  function syncVideo(st, t, playing) {   // 動画の場面では、動画の再生位置を場面の時間に合わせる
    media.forEach(function (m) { if (m.el && m !== st.m && !m.el.paused) m.el.pause(); });
    if (!(st.m && st.m.kind === "video")) return;
    var el = st.m.el;
    // 撮影地点へ寄っている間は、動画を使う場面の頭で止めて待つ（場面に入ってから頭出しすると、絵が出るまで間が空く）
    if (st.e.kind === "approach") {
      if (!el.paused) el.pause();
      if (!el.seeking && Math.abs(el.currentTime - vstart(st.m)) > 0.15) el.currentTime = vstart(st.m);
      return;
    }
    if (!mediaOn(st)) return;
    var want = Math.max(0, Math.min(vstart(st.m) + (st.e.kind === "hook" ? t : t - st.e.t0), (el.duration || 1) - 0.05));
    st.m.localT = want - vstart(st.m);
    if (st.m.dframes) { if (!el.paused) el.pause(); return; }   // ファイルから作った絵を使う動画は、再生しない
    if (playing) {
      // 再生中は動画の速さに任せる。少しのずれで頭出しし直すと、そのたびに絵が消える（遅い端末ほど繰り返す）
      if (el.paused) { if (Math.abs(el.currentTime - want) > 0.3 && !el.seeking) el.currentTime = want; el.play().catch(function () {}); }
      else if (!el.seeking && Math.abs(el.currentTime - want) > 1.5) el.currentTime = want;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want;
    }
  }
  var renderToken = 0;
  function renderAt(t, sharp) {
    var st = showState(sp.show, t), my = ++renderToken, alive = function () { return !sp.playing && my === renderToken; };
    updateTime();
    return liveFrame(st, t, false, sp.show, alive).then(function (ok) {
      if (!ok) return;
      if ($("fly-loading") && !$("fly-loading").hidden) { $("fly-loading").hidden = true; $("fly-empty").hidden = media.length > 0 || sp.playing; }
      // 動画の場面は、動画の頭出しが済んでから描き直す（止めた絵が前の位置のままにならないように）
      if (st.m && st.m.kind === "video" && mediaOn(st) && st.m.el.seeking) {
        st.m.el.addEventListener("seeked", function () { if (alive()) compose(st, sp.show); }, { once: true });
      }
      // 読み込みが済んだら細かい絵で描き直す（その間に場面が変わったらやめる）
      if (sharp && !busy) return settledFrame(st, t, sp.show, true, function () { return alive() && !busy; });
    });
  }
  function playSp() {
    if (!sp.show || busy) return;
    if (sp.t >= sp.show.total - 0.05) sp.t = 0;
    sp.playing = true; sp.last = null; aimPitch = null; aimWant = null; lastAhead = -1e9;
    $("fly-empty").hidden = true;
    $("fly-play").classList.add("is-playing"); $("fly-play").setAttribute("aria-label", "一時停止");
    requestAnimationFrame(tickSp);
  }
  function pauseSp() {
    sp.playing = false;
    $("fly-play").classList.remove("is-playing"); $("fly-play").setAttribute("aria-label", "再生");
    media.forEach(function (m) { if (m.el && !m.el.paused) m.el.pause(); });
    $("fly-empty").hidden = media.length > 0 || busy;
  }
  function tickSp(now) {
    if (!sp.playing) return;
    // 1 コマが重い端末でも実時間に合わせる（大きく飛ぶのは、画面を離れて戻ったときだけ）
    var dt = sp.last == null ? 0 : Math.min(0.5, (now - sp.last) / 1000);
    sp.last = now;
    sp.t = Math.min(sp.show.total, sp.t + dt);
    var st = showState(sp.show, Math.min(sp.t, sp.show.total - 0.001));
    // 動画の場面では、動画の再生位置を時計にする（動画とずれて頭出しし直すことがない）
    if (st.e.kind === "media" && st.m && st.m.kind === "video" && !st.m.el.paused && vidLive(st.m)) {
      var vt = st.e.t0 + st.m.el.currentTime - vstart(st.m);
      if (vt > st.e.t0 && vt < st.e.t1 && Math.abs(vt - sp.t) < 1.5) { sp.t = vt; st = showState(sp.show, sp.t); }
    }
    liveFrame(st, sp.t, true, sp.show, function () { return sp.playing; }).then(function () {
      updateTime();
      if (!sp.playing) return;
      if (sp.t >= sp.show.total) { pauseSp(); return; }
      requestAnimationFrame(tickSp);
    });
  }

  // ------------------------------------------------------------------ エネルギー収支（消費と山ごはん）
  // 消費は山本正嘉の式: コース定数 = 1.8×行動時間(h) + 0.3×距離(km) + 10×登り累積(km) + 0.6×下り累積(km)、
  // 消費(kcal) = コース定数 ×（体重 + 荷物）。疲れないための補給の目安は消費の 7〜8 割（ダイエットとは逆で、山では食べ足りない方が危ない）
  // 食べた量は写真から推定しない（写真を端末の外に送らない）。よくある山の食事から選ぶ。値は目安
  var FOODS = [
    ["hut_dinner", "小屋の夕食", 900], ["hut_breakfast", "小屋の朝食", 600], ["hut_bento", "小屋のお弁当", 700],
    ["cup_noodle", "カップ麺", 350], ["onigiri", "おにぎり 1 個", 180], ["bread", "パン 1 個", 300],
    ["trail_mix", "行動食（ナッツ・チョコ 50g）", 280], ["yokan", "ようかん・エネルギーバー", 170], ["jelly", "ゼリー飲料", 180],
    ["protein_bar", "プロテインバー", 200], ["camp_meal", "山ごはん（自炊）", 600], ["custom", "その他（kcal を入れる）", 0]
  ];
  var foods = [];
  function climbStats() {   // 登り・下りの累積（3m 未満の上下はならす）
    var N = 400, last = null, up = 0, down = 0;
    for (var i = 0; i <= N; i++) {
      var e = eleAt(route.len * i / N); if (e == null) continue;
      if (last == null) { last = e; continue; }
      if (e - last > 3) { up += e - last; last = e; } else if (last - e > 3) { down += last - e; last = e; }
    }
    return { up: up, down: down };
  }
  function movingHours() {   // 行動時間: GPX の時刻（20 分を超える間は休憩・泊まりとして除く）> 公式のコースタイム > 手で入れた時間
    var manual = Number(($("fly-hours") || {}).value);
    if (manual > 0) return { h: manual, how: "入力した時間" };
    if (route.times) {
      var s = 0, T = route.times;
      for (var i = 1; i < T.length; i++) if (T[i] != null && T[i - 1] != null) { var dt = T[i] - T[i - 1]; if (dt > 0 && dt <= 20 * 60000) s += dt; }
      if (s > 0) return { h: s / 3600000, how: "GPX の時刻" };
    }
    if (route.course_min) return { h: route.course_min / 60, how: "コースタイム" };
    return null;
  }
  function numIn(id, def) { var v = Number(($(id) || {}).value); return v > 0 ? v : def; }
  function energy() {
    var mh = movingHours(); if (!mh) return null;
    var c = climbStats(), km = route.len / 1000, w = numIn("fly-weight", 60), pack = numIn("fly-pack", 8);
    var k = 1.8 * mh.h + 0.3 * km + 10 * c.up / 1000 + 0.6 * c.down / 1000;
    var burn = Math.round(k * (w + pack) / 10) * 10;
    var intake = foods.reduce(function (s2, f) { return s2 + f.kcal * f.n; }, 0);
    return { burn: burn, intake: intake, pct: burn ? Math.round(intake / burn * 100) : 0, hours: mh.h, how: mh.how, w: w, pack: pack };
  }
  function renderEnergy() {
    var ol = $("fly-food-list"); if (!ol) return;
    ol.innerHTML = "";
    foods.forEach(function (f, i) {
      var li = document.createElement("li");
      if (f.thumb) { var im = document.createElement("img"); im.alt = ""; im.src = f.thumb; li.appendChild(im); }
      var sel = document.createElement("select"); sel.dataset.food = String(i); sel.setAttribute("aria-label", "食べたもの");
      FOODS.forEach(function (o) { var op = document.createElement("option"); op.value = o[0]; op.textContent = o[1] + (o[2] ? "（" + o[2] + "kcal）" : ""); sel.appendChild(op); });
      sel.value = f.kind; li.appendChild(sel);
      if (f.kind === "custom") {
        var kc = document.createElement("input"); kc.type = "number"; kc.min = "0"; kc.step = "10"; kc.value = String(f.kcal || ""); kc.placeholder = "kcal";
        kc.dataset.kcal = String(i); kc.setAttribute("aria-label", "kcal"); kc.className = "fly-kcal"; li.appendChild(kc);
      }
      var n = document.createElement("input"); n.type = "number"; n.min = "1"; n.max = "9"; n.value = String(f.n); n.dataset.n = String(i); n.className = "fly-n"; n.setAttribute("aria-label", "数");
      li.appendChild(n);
      var rm = document.createElement("button"); rm.type = "button"; rm.className = "fly-rm"; rm.dataset.rm = String(i); rm.textContent = "×"; rm.setAttribute("aria-label", "外す");
      li.appendChild(rm);
      ol.appendChild(li);
    });
    var e = energy(), out2 = $("fly-energy-sum");
    if (!e) { out2.textContent = "行動時間が分からないため計算できません（GPX を読み込むか、行動時間を入れてください）。"; return; }
    out2.textContent = "消費 " + e.burn.toLocaleString() + " kcal（" + e.how + " " + e.hours.toFixed(1) + " 時間・体重 " + e.w + "kg＋荷物 " + e.pack + "kg）"
      + (foods.length ? "／補給 " + e.intake.toLocaleString() + " kcal（" + e.pct + "%）" + (e.pct < 70 ? "　目安の 7〜8 割に足りません" : e.pct <= 85 ? "　目安どおり" : "") : "");
  }
  async function addFoods(files) {
    for (var i = 0; i < files.length; i++) {
      try { var bm = await createImageBitmap(files[i]); foods.push({ kind: "camp_meal", kcal: 600, n: 1, img: bm, thumb: URL.createObjectURL(files[i]) }); }
      catch (e) { /* 読めない画像は飛ばす */ }
    }
    renderEnergy(); refreshShow();
  }
  function bindEnergy() {
    try { ["fly-weight", "fly-pack"].forEach(function (id) { var v = localStorage.getItem("hutsgo-" + id); if (v) $(id).value = v; }); } catch (e) { /* 保存できない環境 */ }
    ["fly-weight", "fly-pack", "fly-hours"].forEach(function (id) {
      $(id).addEventListener("change", function () {
        try { if (id !== "fly-hours") localStorage.setItem("hutsgo-" + id, $(id).value); } catch (e) { /* 保存できない環境 */ }
        renderEnergy(); refreshShow();
      });
    });
    $("fly-food").addEventListener("change", function (e) { addFoods(Array.prototype.slice.call(e.target.files)); e.target.value = ""; });
    $("fly-food-add").addEventListener("click", function () { foods.push({ kind: "trail_mix", kcal: 280, n: 1 }); renderEnergy(); refreshShow(); });
    var ol = $("fly-food-list");
    ol.addEventListener("change", function (e) {
      var t = e.target, i;
      if (t.dataset.food != null) { i = Number(t.dataset.food); var o = FOODS.find(function (x) { return x[0] === t.value; }); foods[i].kind = o[0]; foods[i].kcal = o[2]; }
      else if (t.dataset.kcal != null) { foods[Number(t.dataset.kcal)].kcal = Math.max(0, Number(t.value) || 0); }
      else if (t.dataset.n != null) { foods[Number(t.dataset.n)].n = Math.max(1, Math.min(9, Number(t.value) || 1)); }
      else return;
      renderEnergy(); refreshShow();
    });
    ol.addEventListener("click", function (e) { var b = e.target.closest("[data-rm]"); if (!b) return; foods.splice(Number(b.dataset.rm), 1); renderEnergy(); refreshShow(); });
  }

  // ------------------------------------------------------------------ 地図の文字と登山道（地理院の注記を、重ならないよう地図の上に置く）
  // 山頂は自前の「山名＋標高」（地理院の標高点と組み合わせたもの）。ほかは地理院の注記: 小屋・乗越・平・池・山地名。登山道は破線
  function setLabelsOnMap() {
    var fc = { type: "FeatureCollection", features: (route.peaks || []).filter(function (p) { return p.elev; }).map(function (p) {
      return { type: "Feature", properties: { label: p.name.ja + "\n" + p.elev.toLocaleString() + "m", elev: p.elev }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } };
    }) };
    if (map.getSource("peaks")) { map.getSource("peaks").setData(fc); return; }
    map.addSource("peaks", { type: "geojson", data: fc });
    map.addLayer({ id: "gsi-trail", type: "line", source: "gsiv", "source-layer": "RdCL", minzoom: 12, filter: ["==", ["get", "vt_code"], 2721],
                   paint: { "line-color": "rgba(255,255,255,0.75)", "line-width": 1.3, "line-dasharray": [2, 1.5] } }, "route-halo");
    var halo = { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.7)", "text-halo-width": 1.4, "text-halo-blur": 0.5 };
    map.addLayer({ id: "gsi-anno", type: "symbol", source: "gsiv", "source-layer": "Anno", minzoom: 11,
                   filter: ["in", ["get", "vt_code"], ["literal", [311, 321, 331, 332, 673, 681]]],
                   layout: { "text-field": ["get", "vt_text"], "text-font": ["NotoSansJP-Regular"], "text-size": 11.5, "text-padding": 6,
                             "symbol-sort-key": ["case", ["in", ["get", "vt_code"], ["literal", [673, 681]]], 0, 1] },
                   paint: Object.assign({}, halo, { "text-color": "rgba(255,255,255,0.92)" }) });
    map.addLayer({ id: "ofm-hut", type: "symbol", source: "ofm", "source-layer": "poi", minzoom: 11, layout: { visibility: "none",
                     "text-field": ["coalesce", ["get", "name:ja"], ["get", "name_int"], ["get", "name"]], "text-font": ["NotoSansJP-Regular"], "text-size": 11.5, "text-padding": 6 },
                   filter: ["==", ["get", "subclass"], "alpine_hut"], paint: Object.assign({}, halo, { "text-color": "rgba(255,255,255,0.92)" }) });
    map.addLayer({ id: "peak-label", type: "symbol", source: "peaks",
                   layout: { "text-field": ["concat", "▲ ", ["get", "label"]], "text-font": ["NotoSansJP-Regular"], "text-size": 13, "text-anchor": "bottom",
                             "text-line-height": 1.15, "symbol-sort-key": ["-", 0, ["get", "elev"]], "text-padding": 8 },
                   paint: halo });
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
    var g = gainUp(), custom = ((($("fly-title") || {}).value) || "").trim();
    return { title: custom || (top ? top.name.ja : route.name.ja), sub: !custom && top ? top.elev.toLocaleString() + "m" : "", date: date,
             stats: [fmtDist(route.len), g ? "↑" + g.toLocaleString() + "m" : null, days ? days + "日間" : null].filter(Boolean) };
  }
  function highlight() {
    var u = usedMedia();
    return u.find(function (m) { return m.star; }) || u.find(function (m) { return m.kind === "video"; })
      || u.slice().sort(function (a, b) { return (eleAt(b.d) || 0) - (eleAt(a.d) || 0); })[0] || null;
  }
  // 長さごとのおすすめの本数（1 本 1.5〜2 秒で、道を進む様子も見える数）
  var REC = { 10: [2, 4], 20: [4, 8], 30: [6, 12], 60: [10, 25] };
  function curLen() { return Number(($("fly-len") || {}).value) || 20; }
  function buildShow() {
    var T = curLen(), s = T <= 10 ? 0.7 : T <= 20 ? 0.9 : 1;
    var hl = highlight();
    var en = energy(), hook = (hl ? 1.4 : 1.0) * s, draw = 1.3 * s, swoop = 1.1 * s, outro = (2.2 + (en && foods.length ? 1.3 : 0)) * s;
    var budget = T - hook - 1.8 * s - draw - swoop - outro;
    // 写真・動画は画面の上 2/3、下 1/3 は進み続ける地図（どこを歩いているかが途切れない）。おすすめの本数以内なら、写真の前に
    // 撮影地点へ寄る場面を入れる（上の枠で寄り、下の地図は道を進み続ける）。写真の右下には撮影地点を中心にした小さな 3D 地図
    var chosen = usedMedia().sort(function (a, b) { return a.d - b.d; }), rec = REC[T] || [4, 8];
    var povOK = chosen.length <= rec[1];
    var pw = function (m) { return m.kind === "video" ? Math.min(m.full || m.dur || 3, 3 * s) : 1.5 * s; };
    var pmin = function (m) { return m.kind === "video" ? 1.0 : 0.6; };
    var A = budget * 0.75;
    var need = function (k) { return chosen.reduce(function (a, m) { return a + Math.max(pmin(m), pw(m) * k) + (povOK ? 0.9 * s * k : 0); }, 0); };
    var k = 1;
    if (need(1) > A) { var lo = 0.05, hi = 1; for (var it = 0; it < 30; it++) { var mid = (lo + hi) / 2; if (need(mid) <= A) lo = mid; else hi = mid; } k = lo; }
    var durOf = function (m) { return Math.max(pmin(m), pw(m) * k); };
    var F = Math.max(budget * 0.25, budget - need(k));
    var v = route.len / (F + 0.5 * need(k));   // 写真を出している間も半分の速さで進む
    var ev = [], t = 0, push = function (o, dur) { o.t0 = t; o.t1 = t + dur; ev.push(o); t += dur; return o; };
    push({ kind: "hook", m: hl }, hook);
    push({ kind: "globe" }, 1.8 * s);   // 宇宙から、その山へ一気に寄る
    push({ kind: "draw" }, draw);
    push({ kind: "swoop" }, swoop);
    var d = 0, last = null;
    chosen.forEach(function (m) {
      var dur = durOf(m), target = Math.max(m.d, d), dt = (target - d) / v;
      if (m.kind === "video") { m.clipLen = dur; m.autoStart = bestStart(m, dur); queueDecode(m); }
      if (last && dt < 0.6) { last.d1 = target; last.t1 += dt; t += dt; }   // 近い写真のあいだは、画面を分けたまま進む
      else if (dt > 0.05) push({ kind: "fly", d0: d, d1: target }, dt);
      d = target;
      if (povOK) {
        var ad = 0.9 * s * k;
        last = push({ kind: "approach", m: m, d0: d, d1: Math.min(route.len, d + 0.5 * v * ad) }, ad);
        d = last.d1;
      }
      last = push({ kind: "media", m: m, d0: d, d1: Math.min(route.len, d + 0.5 * v * dur) }, dur);
      d = last.d1;
    });
    if (route.len - d > 1) push({ kind: "fly", d0: d, d1: route.len }, Math.max(0.3, (route.len - d) / v));
    push({ kind: "outro" }, outro);
    // 足し合わせで選んだ長さを超えたら、飛ぶ区間を縮めて合わせる
    if (t > T) {
      var over = t - T, flys = ev.filter(function (e) { return e.kind === "fly"; }), ft = flys.reduce(function (a, e) { return a + e.t1 - e.t0; }, 0);
      var kf = Math.max(0.2, (ft - over) / (ft || 1)); t = 0;
      ev.forEach(function (e) { var dur = (e.t1 - e.t0) * (e.kind === "fly" ? kf : 1); e.t0 = t; e.t1 = t + dur; t += dur; });
    }
    // 写真がとても多いとき（下限まで縮めても入らない）は、全体を選んだ長さに収める
    if (t > T + 0.01) { var sq = T / t; t = 0; ev.forEach(function (e) { var dur = (e.t1 - e.t0) * sq; e.t0 = t; e.t1 = t + dur; t += dur; }); }
    // 画面を分ける場面の出入り（続いている間は分けたまま、上の枠だけ切り替える）
    var splitK = function (e) { return e && (e.kind === "media" || e.kind === "approach"); };
    ev.forEach(function (e, i) {
      if (!splitK(e)) return;
      e.sin = !splitK(ev[i - 1]); e.sout = !splitK(ev[i + 1]);
      e.afterApproach = e.kind === "media" && ev[i - 1] && ev[i - 1].kind === "approach" && ev[i - 1].m === e.m;
    });
    var shown = ev.filter(function (e) { return e.kind === "media"; });
    var info = titleInfo(); info.energy = en;
    return { ev: ev, total: t, info: info, chosen: chosen, rec: rec, pov: povOK,
             perPhoto: shown.length ? shown.reduce(function (a, e) { return a + e.t1 - e.t0; }, 0) / shown.length : 0 };
  }

  // カメラ: 道中は「ならした軌道」の上を進む（細かいくねりを追わない）。写真では撮影地点に立って撮った向きを見る
  var overviewCamCache = null, outroCamCache = null, flyBearing = null;
  function outroCam(spin) {   // 締め: 道を画面の下半分に収める（上半分は題字と数字）
    if (!outroCamCache) {
      var b = new maplibregl.LngLatBounds();
      route.line.forEach(function (q) { b.extend([q[1], q[0]]); });
      var c = map.cameraForBounds(b, { padding: { top: 260, bottom: 40, left: 36, right: 36 }, pitch: 0, bearing: 0 }) || { center: b.getCenter(), zoom: 11 };
      outroCamCache = { center: [c.center.lng != null ? c.center.lng : c.center[0], c.center.lat != null ? c.center.lat : c.center[1]], zoom: c.zoom - 0.05 };
      outroCamCache.elevation = groundAt(outroCamCache.center[0], outroCamCache.center[1], route.len / 2);
    }
    return { center: outroCamCache.center, zoom: outroCamCache.zoom, pitch: 35, bearing: -20 + (spin || 0), elevation: outroCamCache.elevation };
  }
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
    // 向きは前後に広く取ったならした軌道から決める（時間でならさない。スライドでどこへ飛んでも同じ絵になる）
    var c = railAt(d), b = bearing(railAt(d - 1500), railAt(d + 2500));
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
    else if (e.kind === "globe") {
      // 地球全体からその山の上空へ。ズームは対数なので、線形に動かすと寄るほど速く感じる
      var oc = overviewCam(0), k2 = ease(f);
      st.cam = { center: oc.center, zoom: lerp(1.4, oc.zoom, k2), pitch: lerp(0, oc.pitch, k2 * k2), bearing: lerp(30, oc.bearing, k2), elevation: lerp(0, oc.elevation || 0, k2) };
      st.line = 0; st.drawing = true; st.space = 1 - k2;
    }
    else if (e.kind === "draw") { st.cam = overviewCam(8 * f); st.line = easeOut(f); st.drawing = true; }
    // 降りる場面: 題字は前半で消え、標高の数字は後半で出る（同じ場所で重ならないように）
    else if (e.kind === "swoop") { var k = ease(f); st.cam = mixCam(overviewCam(8), flyCam(0, false), k); st.hud = Math.max(0, (f - 0.5) * 2); }
    else if (e.kind === "fly") { st.d = e.d0 + (e.d1 - e.d0) * f; st.cam = flyCam(st.d, true); st.hud = 1; }
    else if (e.kind === "approach") {
      // 上の枠: 道の上から撮影地点の視点へ寄る（ピンを立てる）。下の地図: 道を進み続ける
      st.d = e.d0 + (e.d1 - e.d0) * f; st.cam = flyCam(st.d, true); st.hud = 1;
      // 撮影地点の視点の手前（85%）で止める。地面すれすれまで寄ると景色が流れて灰色になる
      st.top = mixCam(flyCam(e.m.d, false), povCam(e.m), 0.85 * ease(f));
      st.split = e.sin ? ease(Math.min(1, f / 0.35)) : 1;
      st.pin = Math.min(1, f / 0.3);
    }
    else if (e.kind === "photo") {
      st.d = e.d0; var pc = povCam(e.m);
      st.cam = { center: pc.center, zoom: pc.zoom, pitch: pc.pitch, bearing: pc.bearing + 3 * f, elevation: pc.elevation };
      st.photoAlpha = Math.min(1, e.fin === false ? 1 : f / 0.22, e.fout === false ? 1 : (1 - f) / 0.18);   // 3D から本物の写真へ溶け、最後に 3D へ戻る
    }
    else if (e.kind === "back") { st.d = e.d0; st.cam = mixCam(povCam(e.m), flyCam(e.d0, false), ease(f)); st.hud = f; }
    else if (e.kind === "media") {
      // 画面の上 2/3 に写真が滑り込み、下 1/3 の地図は進み続ける
      st.d = e.d0 + (e.d1 - e.d0) * f; st.cam = flyCam(st.d, true); st.hud = 1;
      var tin = Math.min(0.35, (e.t1 - e.t0) * 0.3);
      var kin = e.sin ? (t - e.t0) / tin : 1, kout = e.sout ? (e.t1 - t) / tin : 1;
      st.split = ease(Math.max(0, Math.min(1, kin, kout))); st.exit = kout < kin;
      st.fromTop = e.afterApproach ? 1 - Math.min(1, (t - e.t0) / Math.min(0.4, (e.t1 - e.t0) * 0.4)) : 0;   // 寄った絵から写真へ溶ける
    }
    else { st.d = route.len; st.cam = mixCam(flyCam(route.len, false), outroCam(8 + 25 * f), ease(f)); st.outro = true; }
    return st;
  }
  function setLine(st, mode) {   // 描かれていく線（冒頭）／通った所と残り（道中）。mode: "top"（寄る枠）・"inset"（小さな地図）
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
    var pov = mode === "top" || (!mode && (st.e.kind === "photo" || st.e.kind === "back"));
    map.setPaintProperty("route", "line-opacity", pov ? 0.35 : 1);
    map.setPaintProperty("route-halo", "line-opacity", pov ? 0 : 0.85);
    var showDot = !(mode || st.drawing || st.e.kind === "hook" || st.outro || pov);
    if (st.outro && paceOn()) map.setPaintProperty("route", "line-gradient", progressExpr(1));
    // 冒頭と締めは大きな文字を重ねるので、地図の文字（山名・注記）は消す
    var labelsOn = !(st.e.kind === "hook" || st.e.kind === "globe" || st.outro);
    ["peak-label", REGION === "jp" ? "gsi-anno" : "ofm-hut"].forEach(function (id) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", labelsOn ? "visible" : "none"); });
    ["here", "here-halo"].forEach(function (id) { map.setLayoutProperty(id, "visibility", showDot ? "visible" : "none"); });
  }

  // 合成（地図＋本物の写真＋文字）
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function text(s, x, y, size, weight, color, align) {
    ctx.font = (weight || 600) + " " + size + "px system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif";
    ctx.textAlign = align || "left"; ctx.fillStyle = color || "#fff";
    ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 12; ctx.fillText(s, x, y); ctx.shadowBlur = 0;
  }
  // 写真・動画を枠に入れる（ゆっくり寄る）。枠より大幅に横長なもの（横で撮った写真を縦の画面へ）は、切り落とさずに全体を見せ、
  // 余白は同じ写真をぼかして埋める
  function drawMedia(m, x, y, w, h, alpha, k) {
    var live = m.kind === "video" && !m.dframes && vidLive(m);
    if (live) { keepFrame(m); if (m.liveOK === false) live = false; }
    var src = m.kind === "video" ? (m.dframes ? decodedFrame(m) : live ? m.el : (m.frameOK ? m.lastCv : null)) : m.img;
    if (!src) return;
    var sw = m.kind === "video" ? (live ? m.el.videoWidth : src.width) : m.img.width, sh = m.kind === "video" ? (live ? m.el.videoHeight : src.height) : m.img.height;
    if (!sw || !sh || alpha <= 0) return;
    ctx.save(); ctx.globalAlpha = alpha; ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    if (sw / sh > (w / h) * 1.35) {
      var c0 = Math.max(w / sw, h / sh) * 1.15, blur = "filter" in ctx;
      if (blur) ctx.filter = "blur(26px) brightness(0.72)";
      ctx.drawImage(src, x + (w - sw * c0) / 2, y + (h - sh * c0) / 2, sw * c0, sh * c0);
      if (blur) ctx.filter = "none"; else { ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fillRect(x, y, w, h); }
      var c1 = Math.min(w / sw, h / sh) * (1 + 0.05 * k);
      ctx.drawImage(src, x + (w - sw * c1) / 2, y + (h - sh * c1) / 2, sw * c1, sh * c1);
    } else {
      var sc = Math.max(w / sw, h / sh) * (1.02 + 0.08 * k);
      ctx.drawImage(src, x + (w - sw * sc) / 2, y + (h - sh * sc) / 2, sw * sc, sh * sc);
    }
    ctx.restore();
  }
  // 写真のピン（YAMAP のような丸いサムネイル）: 出し終えた写真・動画のピンを道の地図に立てていく。今の写真は青い縁で少し大きく
  function pinThumb(m) {
    if (m.pinCv) return m.pinCv;
    var src = m.kind === "video" ? m.lastCv : m.img; if (!src) return null;
    var c = document.createElement("canvas"); c.width = c.height = 120;
    var sw = src.width, sh = src.height, sc = Math.max(120 / sw, 120 / sh);
    c.getContext("2d").drawImage(src, (120 - sw * sc) / 2, (120 - sh * sc) / 2, sw * sc, sh * sc);
    return (m.pinCv = c);
  }
  var pinsDrawn = 0;
  function drawMapPins(st, show, top, sy) {
    var i = show.ev.indexOf(st.e), k = st.e.kind;
    if (i < 0 || k === "hook" || k === "globe" || k === "draw" || k === "swoop") return;
    var c = map.getCanvas(), cw = c.clientWidth || 360, ch = c.clientHeight || 640, CH = c.height, seen = [], list = [];
    for (var j = 0; j <= i; j++) {
      var e = show.ev[j];
      if (e.kind !== "media" || seen.indexOf(e.m) >= 0) continue;
      seen.push(e.m);
      var cur = j === i, q = map.project(pinLL(e.m)), px = q.x / cw * W, py = top > 0 ? top + (q.y / ch * CH - sy) * H / CH : q.y / ch * H;
      if (px < -60 || px > W + 60 || py < top + 30 || py > H + 60) continue;
      list.push({ x: px, y: py, m: e.m, cur: cur, sc: cur ? 1.15 * easeOut(Math.min(1, st.f * 4)) : 0.9 });
    }
    list.sort(function (a, b) { return (a.cur - b.cur) || (a.y - b.y); });   // 手前（下）と今の写真を上に重ねる
    pinsDrawn = list.length;
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, W, H - top); ctx.clip();
    list.forEach(function (p2) { drawPhotoPin(p2.x, p2.y, p2.m, p2.sc, p2.cur); });
    ctx.restore();
  }
  function drawPhotoPin(x, y, m, sc, cur) {
    var th = pinThumb(m); if (!th || sc <= 0) return;
    var R2 = 30 * sc, cy = y - 14 * sc - R2;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
    ctx.fillStyle = cur ? "#1FB5E8" : "#fff";
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 11 * sc, cy + R2 * 0.7); ctx.lineTo(x + 11 * sc, cy + R2 * 0.7); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(x, cy, R2 + 4.5 * sc, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.save(); ctx.beginPath(); ctx.arc(x, cy, R2, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(th, x - R2, cy - R2, 2 * R2, 2 * R2); ctx.restore();
    if (m.kind === "video") {   // 動画のしるし
      var bx = x + R2 * 0.72, by = cy + R2 * 0.72;
      ctx.beginPath(); ctx.arc(bx, by, 11 * sc, 0, Math.PI * 2); ctx.fillStyle = "rgba(22,36,29,.85)"; ctx.fill();
      ctx.beginPath(); ctx.moveTo(bx - 3.5 * sc, by - 5.5 * sc); ctx.lineTo(bx + 5.5 * sc, by); ctx.lineTo(bx - 3.5 * sc, by + 5.5 * sc);
      ctx.closePath(); ctx.fillStyle = "#fff"; ctx.fill();
    }
    ctx.restore();
  }
  function drawPin(x, y, sc, a) {   // 撮影地点のピン（カメラのしるし）
    if (a <= 0) return;
    ctx.save(); ctx.globalAlpha = a; ctx.translate(x, y); ctx.scale(sc, sc);
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.bezierCurveTo(-8, -14, -24, -24, -24, -42); ctx.arc(0, -42, 24, Math.PI, 0); ctx.bezierCurveTo(24, -24, 8, -14, 0, 0); ctx.closePath();
    ctx.fillStyle = "#E4572E"; ctx.fill(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#fff"; rr(-13, -51, 26, 18, 4); ctx.fill(); ctx.fillRect(-6, -55, 10, 5);
    ctx.beginPath(); ctx.arc(0, -42, 5.5, 0, Math.PI * 2); ctx.fillStyle = "#E4572E"; ctx.fill();
    ctx.restore();
  }
  function dotY() {   // 地図の上での現在地の高さ（0〜1）。画面を分けたとき、下の地図をここを中心に切り出す
    if (!lastHere) return 0.6;
    var c = map.getCanvas(), q = map.project(lastHere);
    return Math.max(0, Math.min(1, q.y / (c.clientHeight || 640)));
  }
  // 標高の断面（道中の下の方）。通った所を塗り、今いる所に丸
  function profPts() {
    if (route._prof !== undefined) return route._prof;
    var N = 150, e = [];
    for (var i = 0; i <= N; i++) e.push(eleAt(route.len * i / N));
    var ok = e.filter(function (v) { return v != null; });
    route._prof = ok.length > N / 2 ? { e: e.map(function (v, i) { return v != null ? v : ok[0]; }), min: Math.min.apply(null, ok), max: Math.max.apply(null, ok), n: N } : null;
    return route._prof;
  }
  function drawProfile(d, a) {
    var P = profPts(); if (!P || a <= 0) return;
    // 海抜 0m を画面のいちばん下（出典の高さ）に置き、高さはそこから測る（山の高さがそのまま見える）
    var x0 = 0, x1 = W, yb = H - 6, hh = 200, top = Math.max(1000, Math.ceil(P.max / 500) * 500);
    var X = function (i) { return x0 + (x1 - x0) * i / P.n; }, Y = function (v) { return yb - Math.max(0, v) / top * hh; };
    var path = function () { ctx.beginPath(); ctx.moveTo(x0, yb); P.e.forEach(function (v, i) { ctx.lineTo(X(i), Y(v)); }); ctx.lineTo(x1, yb); ctx.closePath(); };
    ctx.save(); ctx.globalAlpha = a;
    var g = ctx.createLinearGradient(0, yb - hh - 30, 0, H); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.3)");
    ctx.fillStyle = g; ctx.fillRect(0, yb - hh - 30, W, H - (yb - hh - 30));
    path(); ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.fill();
    var xd = x0 + (x1 - x0) * Math.max(0, Math.min(1, d / route.len));
    ctx.save(); ctx.beginPath(); ctx.rect(x0, yb - hh - 4, xd - x0, hh + 8); ctx.clip(); path(); ctx.fillStyle = "rgba(31,181,232,.3)"; ctx.fill(); ctx.restore();
    ctx.beginPath(); P.e.forEach(function (v, i) { if (i) ctx.lineTo(X(i), Y(v)); else ctx.moveTo(X(i), Y(v)); });
    ctx.lineWidth = 2.5; ctx.strokeStyle = "rgba(255,255,255,.92)"; ctx.stroke();
    var ed = eleAt(d);
    if (ed != null) { ctx.beginPath(); ctx.arc(xd, Y(ed), 8, 0, Math.PI * 2); ctx.fillStyle = "#1E88E5"; ctx.fill(); ctx.lineWidth = 3.5; ctx.strokeStyle = "#fff"; ctx.stroke(); }
    ctx.restore();
  }
  function paceLegend(a, yy) {   // ペースの色の見方（締めで道をペースで塗ったとき）。題字のかたまりの下に置く（道に重ねない）
    var x0 = W / 2 - 170, x1 = W / 2 + 170, y = yy || SAFE_BOTTOM - 46, g = ctx.createLinearGradient(x0, 0, x1, 0);
    PACE.forEach(function (p, i) { g.addColorStop(i / (PACE.length - 1), "rgb(" + p[1].join(",") + ")"); });
    ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = g; rr(x0, y, x1 - x0, 12, 6); ctx.fill();
    text("ゆっくり", x0 - 14, y + 12, 22, 700, "#fff", "right"); text("速い", x1 + 14, y + 12, 22, 700, "#fff", "left");
    text("ペース（標準タイムと比べて）", W / 2, y + 48, 20, 600, "rgba(255,255,255,.85)", "center");
    ctx.restore();
  }
  function shade(top, bottom) {
    var g = ctx.createLinearGradient(0, 0, 0, 420); g.addColorStop(0, "rgba(0,0,0," + top + ")"); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, 420);
    g = ctx.createLinearGradient(0, H * 0.45, 0, H); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0," + bottom + ")");
    ctx.fillStyle = g; ctx.fillRect(0, H * 0.45, W, H * 0.55);
  }
  function compose(st, show) {
    var info = show.info, ok = mediaReady(st.m);
    // 写真・動画の絵がまだ無いとき（動画の頭出し中など）は地図を出す。前のコマの絵を残さない
    var isAppr = st.e.kind === "approach" && topFor === st.m, isMedia = st.e.kind === "media" && ok;
    var pa = ok ? st.photoAlpha : 0, sk = isAppr || isMedia ? (st.split || 0) : 0;
    // 上の枠と下の地図の境目: 入るときは画面の下から 2/3 の高さへ上がり、抜けるときは 2/3 から上端へ上がる
    var top = sk > 0 ? (st.exit ? lerp(0, H * 2 / 3, sk) : lerp(H, H * 2 / 3, sk)) : 0;
    if (pa < 1) {
      var sky = ctx.createLinearGradient(0, 0, 0, H * 0.55);
      sky.addColorStop(0, skyPaint.top); sky.addColorStop(1, skyPaint.bottom);
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      if (st.space) { ctx.save(); ctx.globalAlpha = Math.min(1, st.space * 1.5); ctx.fillStyle = "#05080d"; ctx.fillRect(0, 0, W, H); ctx.restore(); }   // 宇宙
      var sySrc = 0;
      if (sk > 0) {   // 下の地図: 現在地を中心に切り出す（縦横比は変えない）
        var mc = map.getCanvas(), CH = mc.height, sh2 = (H - top) / H * CH;
        sySrc = Math.max(0, Math.min(CH - sh2, dotY() * CH - sh2 / 2));
        if (sh2 >= 1) ctx.drawImage(mc, 0, sySrc, mc.width, sh2, 0, top, W, H - top);
      } else ctx.drawImage(map.getCanvas(), 0, 0, W, H);
      drawMapPins(st, show, sk > 0 ? top : 0, sySrc);
    }
    if (pa > 0) drawMedia(st.m, 0, 0, W, H, pa, st.f);
    if (isAppr && sk > 0) {   // 上の枠: 撮影地点へ寄る絵（ピンを中心に切り出す）
      var ty = Math.max(0, Math.min(H - top, (topPin ? topPin[1] * H : H / 2) - top / 2));
      ctx.drawImage(topCv, 0, ty, W, top, 0, 0, W, top);
      if (topPin) drawPin(topPin[0] * W, topPin[1] * H - ty, 1.25, st.pin);
      ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.fillRect(0, top - 2, W, 3);
    }
    if (isMedia && sk > 0) {   // 上の写真（寄る場面の後は、寄った絵から溶ける）。抜けるときは上へ
      var ph = st.exit ? H * 2 / 3 : top, y0 = top - ph;
      if (st.fromTop > 0 && topFor === st.m) {
        var fy = Math.max(0, Math.min(H - ph, (topPin ? topPin[1] * H : H / 2) - ph / 2));
        ctx.drawImage(topCv, 0, fy, W, ph, 0, y0, W, ph);
      }
      drawMedia(st.m, 0, y0, W, ph, 1 - (st.fromTop > 0 && topFor === st.m ? st.fromTop : 0), st.f);
      var gs = ctx.createLinearGradient(0, top, 0, top + 28); gs.addColorStop(0, "rgba(0,0,0,.45)"); gs.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gs; ctx.fillRect(0, top, W, 28);
      ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.fillRect(0, top - 2, W, 3);
    }
    var k = st.e.kind;
    if (k === "hook") {
      shade(0.35, 0.75);
      ctx.save();
      var z = 1 + 0.06 * (1 - easeOut(Math.min(1, st.f * 2)));
      ctx.translate(W / 2, H * 0.6); ctx.scale(z, z); ctx.translate(-W / 2, -H * 0.6);
      text(info.date, W / 2, H * 0.50, 30, 600, "#fff", "center");
      text(info.title, W / 2, H * 0.50 + 92, info.title.length > 7 ? 70 : 92, 800, "#fff", "center");
      if (info.sub) text(info.sub, W / 2, H * 0.50 + 150, 44, 700, "#fff", "center");
      text(info.stats.join("  ·  "), W / 2, H * 0.50 + 214, 34, 700, "#fff", "center");
      ctx.restore();
    } else if (k === "draw" || k === "swoop") {
      shade(0.4, 0.3);
      ctx.save(); ctx.globalAlpha = k === "draw" ? 1 : Math.max(0, 1 - st.f * 2);
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
    } else if (k === "media" && sk > 0) {
      // 写真の下端に、撮った時刻と場所
      var mm = st.m, tm = mm.utc != null ? mm.utc : (mm.local != null && tz ? mm.local - tz.ms : timeAt(mm.d)), nr = nearestStop(mm.d), em = eleAt(mm.d);
      var gc = ctx.createLinearGradient(0, top - 200, 0, top); gc.addColorStop(0, "rgba(0,0,0,0)"); gc.addColorStop(1, "rgba(0,0,0,.5)");
      ctx.fillStyle = gc; ctx.fillRect(0, top - 200, W, 200);
      if (tm != null) text(fmtClock(tm), 44, top - 66, 52, 800, "#fff", "left");
      text((nr && Math.abs(nr.d - mm.d) < 1500 ? nr.name.ja + "  " : "") + (em != null ? Math.round(em).toLocaleString() + "m" : ""), 46, top - 24, 28, 700, "#fff", "left");
      if (false && mm.insetF) {   // （やめた）右下: 撮影地点を中心にした 3D 地図
        var S2 = 270, ix = W - S2 - 6, iy = top - S2 - 10, ia = 0.9 * Math.min(1, 1 - (st.fromTop || 0)), cx2 = ix + S2 / 2, cy2 = iy + S2 / 2;
        ctx.save(); ctx.globalAlpha = ia;
        var sg = ctx.createRadialGradient(cx2, cy2 + 22, 20, cx2, cy2 + 22, S2 * 0.5);   // 下に落ちる影（浮いて見える）
        sg.addColorStop(0, "rgba(0,0,0,.35)"); sg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = sg; ctx.fillRect(ix - 20, iy, S2 + 40, S2 + 40);
        ctx.drawImage(mm.insetF, ix, iy, S2, S2);
        if (mm.insetPin) drawPin(ix + mm.insetPin[0] / 300 * S2, iy + mm.insetPin[1] / 300 * S2, 0.75, 1);
        ctx.restore();
      }
    } else if (st.outro) {
      // 締め: 上半分に題字と数字（暗い帯の上）、下半分に道。文字は道に重ねない
      var o = Math.min(1, st.f * 3), en = info.energy, withFood = en && foods.length, y0 = SAFE_TOP + 74;
      var gt = ctx.createLinearGradient(0, 0, 0, H * 0.52); gt.addColorStop(0, "rgba(0,0,0," + (0.7 * o) + ")"); gt.addColorStop(0.75, "rgba(0,0,0," + (0.45 * o) + ")"); gt.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gt; ctx.fillRect(0, 0, W, H * 0.52);
      shade(0, 0.45);
      ctx.save(); ctx.globalAlpha = o;
      text(info.title + (info.sub ? " " + info.sub : ""), W / 2, y0, info.title.length > 8 ? 46 : 54, 800, "#fff", "center");
      text(info.stats.join("  ·  "), W / 2, y0 + 64, 36, 800, "#fff", "center");
      var y1 = y0 + 64;
      if (info.date) { text(info.date, W / 2, y1 + 46, 26, 600, "rgba(255,255,255,.9)", "center"); y1 += 46; }
      if (en) {
        // エネルギー収支: 消費と補給（山では食べ足りない方が危ない。目安は消費の 7〜8 割）
        text("消費 " + en.burn.toLocaleString() + " kcal" + (withFood ? "  ·  補給 " + en.intake.toLocaleString() + " kcal（" + en.pct + "%）" : ""), W / 2, y1 + 58, withFood ? 30 : 34, 800, withFood && en.pct < 70 ? "#FFD6A0" : "#fff", "center");
        if (withFood) {
          var pics = foods.filter(function (f) { return f.img; }).slice(0, 4), sz = 96, gap = 12, x0 = (W - (pics.length * sz + (pics.length - 1) * gap)) / 2;
          pics.forEach(function (f, i) {
            var x = x0 + i * (sz + gap), y = y1 + 84, im = f.img, r = Math.max(sz / im.width, sz / im.height);
            ctx.save(); rr(x, y, sz, sz, 16); ctx.clip();
            ctx.drawImage(im, x + (sz - im.width * r) / 2, y + (sz - im.height * r) / 2, im.width * r, im.height * r);
            ctx.restore();
            ctx.save(); rr(x, y, sz, sz, 16); ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.stroke(); ctx.restore();
          });
        }
      }
      ctx.restore();
      if (paceOn()) paceLegend(o, y1 + (withFood ? 214 : en ? 104 : 50));
    }
    if (st.hud > 0) {   // 道中: 標高と距離（音なしでも伝わる数字）。画面を分けているときは下の地図の左上に小さく
      var e2 = eleAt(st.d), t2 = timeAt(st.d), hy = sk > 0 ? Math.max(SAFE_TOP + 52, top + 64) : SAFE_TOP + 52, big = sk > 0 ? 44 : 58;
      if (!sk) shade(0.35 * st.hud, 0);
      ctx.save(); ctx.globalAlpha = st.hud * (sk > 0 && !st.exit ? Math.min(1, (H - top) / (H / 3)) : 1);
      if (e2 != null) text(Math.round(e2).toLocaleString() + "m", 44, hy, big, 800, "#fff", "left");
      text(fmtDist(st.d) + (t2 != null ? "  ·  " + fmtClock(t2) : ""), 46, hy + (sk > 0 ? 38 : 46), sk > 0 ? 24 : 28, 700, "#fff", "left");
      ctx.restore();
      // 断面は道を進む場面だけ（画面を分けている間は下の地図が狭いので消す）
      if (k === "fly" || k === "media" || k === "swoop") drawProfile(st.d, st.hud * (1 - sk));
    }
    ctx.save(); ctx.globalAlpha = 0.8;
    text("HutsGo", W - 40, SAFE_TOP - 22, 24, 800, "#fff", "right");
    ctx.restore();
    // 出典は画面のいちばん下に小さく（SNS の画面では文字の下に隠れても、動画には残る）
    ctx.save(); ctx.globalAlpha = 0.6;
    text(REGION === "jp" ? "地図: 国土地理院・EOxCloudless 2025（Copernicus Sentinel）" : "EOxCloudless 2025（Copernicus Sentinel）・© OpenStreetMap・AWS Terrain Tiles",
         24, H - 16, 13, 500, "#fff", "left");
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
  function exportMode() { var r = document.querySelector('input[name="fly-mode"]:checked'); return r ? r.value : "fast"; }
  async function prepareTiles(show, fast) {
    var waits = show.chosen.map(queueDecode).concat(Object.keys(decoding).map(function (k) { return decoding[k].p; })).filter(Boolean);
    if (waits.length) { progress("動画を用意しています", 0, null); await Promise.all(waits); }
    queue = [];
    var ph = REGION === "jp" ? "photo" : "eox";
    [2, 3, 4, 5, 6, 7, 8, 9].forEach(function (z) { want("eox", z, 0, 0, 1); });   // 地球から寄る場面
    want(ph, 14, 0, route.len, 1);
    want(ph, 15, 0, route.len, 0);
    if (REGION === "jp") [11, 12, 13, 14].forEach(function (z) { want("vec", z, 0, route.len, 1); });   // 地図の文字（注記）
    show.chosen.forEach(function (m) { want(ph, 15, Math.max(0, m.d - 500), m.d + 2500, 1); });
    var t0 = Date.now(), total = queue.length + inflight || 1, cap = fast ? 15000 : 30000;
    while ((queue.length || inflight) && Date.now() - t0 < cap) {
      if (exportCancel) throw new Error("cancel");
      progress("地図を用意しています", (1 - (queue.length + inflight) / total) * 0.8, null);
      await new Promise(function (ok) { setTimeout(ok, 250); });
    }

  }
  function stageMap(on) {   // 書き出し・プレビューの間だけ、地図を 360×640 の 2 倍（720×1280）に固定する
    map.setPixelRatio(on ? W / 360 : Math.min(2, window.devicePixelRatio || 1)); map.resize();
    // 全体を見せたときの余白（fitBounds）が残ると画面の中心がずれる。書き出し中は上にだけ余白を付け、現在地を画面の下寄りに置く（前方が見える）
    map.setPadding(on ? { top: 170, bottom: 0, left: 0, right: 0 } : { top: 0, bottom: 0, left: 0, right: 0 });
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
    // 書き出し中は写真の切り替えフェードを切る（「読み込み完了」がフェードの終わりまで待つので、1 コマごとに遅くなる）
    map.setPaintProperty("photo", "raster-fade-duration", 0);
    var N = Math.ceil(show.total * FPS);
    for (var i = 0; i < N; i++) {
      var t = i / FPS, st = showState(show, t);
      await settledFrame(st, t, show, false);
      var vf = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: i % (FPS * 2) === 0 });
      vf.close();
      if (failedEnc) throw failedEnc;
      if (enc.encodeQueueSize > 8) await new Promise(function (ok) { setTimeout(ok, 0); });
      if (exportCancel) throw new Error("cancel");
      if (i % 3 === 0) progress("動画を作っています", (i + 1) / N, t0);
    }
    await enc.flush();
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), sec: show.total, frames: N, timeouts: timeouts, took: (Date.now() - t0) / 1000,
             mime: "video/mp4（" + FPS + "fps）" + (timeouts ? "・読み込み待ちを打ち切ったコマ " + timeouts : "") };
  }
  async function encodeLive(show) {
    if (!window.VideoEncoder || !window.VideoFrame || !window.Mp4Muxer) return null;
    var config = null, codecs = ["avc1.640028", "avc1.4d0028", "avc1.42001f"];
    for (var c = 0; c < codecs.length && !config; c++) {
      var cfg = { codec: codecs[c], width: W, height: H, bitrate: 8e6, framerate: 30 };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) config = cfg; } catch (e) { /* 次の候補へ */ }
    }
    if (!config) return null;
    var muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: "avc", width: W, height: H }, fastStart: "in-memory" });
    var failedEnc = null, wall = Date.now();
    var enc = new VideoEncoder({ output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); }, error: function (e) { failedEnc = e; } });
    enc.configure(config);
    media.forEach(function (m) { if (m.el) m.el.pause(); m.pov = null; });
    flyBearing = null; aimPitch = null; aimWant = null; lastAhead = -1e9;
    var n = 0, lastT = -1;
    await new Promise(function (resolve, reject) {
      var start = null;
      async function tick(now) {
        if (exportCancel) { reject(new Error("cancel")); return; }
        if (failedEnc) { reject(failedEnc); return; }
        if (start === null) start = now;
        var t = Math.min((now - start) / 1000, show.total - 0.001), st = showState(show, t);
        await liveFrame(st, t, true, show);
        if (lastT < 0 || t - lastT >= 1 / 30 - 0.004) {   // 30 コマ/秒まで
          var vf = new VideoFrame(out, { timestamp: Math.round(t * 1e6) });
          enc.encode(vf, { keyFrame: n % 60 === 0 }); vf.close(); n++; lastT = t;
        }
        if (n % 6 === 0) progress("動画を作っています（再生と同じ時間）", t / show.total, wall);
        if ((now - start) / 1000 >= show.total) { resolve(); return; }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    media.forEach(function (m) { if (m.el && !m.el.paused) m.el.pause(); });
    await enc.flush();
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), sec: show.total, frames: n, took: (Date.now() - wall) / 1000, mime: "video/mp4（再生しながら作成・" + n + " コマ）" };
  }
  function playShow(show, rec) {   // 実時間で流す（プレビュー、または WebCodecs の無い端末での録画）
    return new Promise(function (resolve) {
      var start = null;
      media.forEach(function (m) { m.pov = null; });
      flyBearing = null; aimPitch = null; aimWant = null;
      async function tick(now) {
        if (start === null) start = now;
        var t = (now - start) / 1000, st = showState(show, Math.min(t, show.total - 0.001));
        await liveFrame(st, t, true, show);
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
  async function previewVideo() {   // 画面の中央に動画を出して、頭から流す
    if (busy) return;
    var stage = document.querySelector(".fly-stage");
    stage.scrollIntoView({ behavior: "smooth", block: "center" });
    pauseSp(); sp.t = 0; refreshShow();
    setTimeout(playSp, 500);
  }
  var exportCancel = false, lastExport = null;
  function progress(label, frac, t0) {   // 動画の上に進み具合と残りの目安
    $("fly-progress-label").textContent = label;
    var pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    $("fly-bar-fill").style.transform = "scaleX(" + (pct / 100) + ")";
    $("fly-progress").querySelector(".fly-bar").setAttribute("aria-valuenow", String(pct));
    if (t0 && frac > 0.04) {
      var left = (Date.now() - t0) / 1000 * (1 - frac) / frac;
      $("fly-progress-sub").textContent = pct + "%・あと約 " + (left < 60 ? Math.max(5, Math.round(left / 5) * 5) + " 秒" : Math.round(left / 60) + " 分") + "（画面を開いたままにしてください）";
    } else {
      $("fly-progress-sub").textContent = pct + "%（画面を開いたままにしてください）";
    }
  }
  async function exportVideo() {
    if (busy) return;
    pauseSp(); busy = true; exportCancel = false; setButtons(false);
    $("fly-empty").hidden = true; $("fly-progress").hidden = false; progress("地図を用意しています", 0, null);
    var lock = null;
    try { if (navigator.wakeLock) lock = await navigator.wakeLock.request("screen"); } catch (e) { lock = null; }   // 書き出し中に画面が消えると止まるため
    try {
      var show = buildShow(), tPrep = Date.now(), fast = exportMode() === "fast";
      await prepareTiles(show, fast);
      tPrep = (Date.now() - tPrep) / 1000;
      var res = fast ? await encodeLive(show) : await encodeFrames(show);
      if (!res) { progress("この端末では実時間で録画します", 0, null); res = await recordRealtime(show); }
      res.prep = tPrep;
      var ext = /mp4/.test(res.mime) ? "mp4" : "webm", name = "hutsgo-" + (route.source === "gpx" ? "yama" : route.id) + "." + ext;
      if (lastExport) URL.revokeObjectURL(lastExport.url);
      lastExport = { blob: res.blob, name: name, url: URL.createObjectURL(res.blob), type: res.blob.type || (ext === "mp4" ? "video/mp4" : "video/webm") };
      $("fly-video").src = lastExport.url;
      $("fly-download").href = lastExport.url; $("fly-download").download = name;
      var file = null;
      try { file = new File([res.blob], name, { type: lastExport.type }); } catch (e) { file = null; }
      var canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
      $("fly-share").hidden = !canShare;
      document.querySelector(".fly-result-buttons").classList.toggle("is-single", !canShare);
      $("fly-format").textContent = Math.round(res.sec) + " 秒・" + (res.blob.size / 1048576).toFixed(1) + "MB" + (res.took ? "・作成 " + Math.round(res.took + (res.prep || 0)) + " 秒" : "")
        + (res.timeouts ? "・地図の読み込みが間に合わなかったコマ " + res.timeouts : "")
        + (ext === "webm" ? "（MP4 で作れませんでした。Instagram などでは変換が要ることがあります）" : "");
      $("fly-result").hidden = false;
      status("");
      track("flyover_export");
    } catch (e) {
      status(String(e && e.message) === "cancel" ? "やめました。" : "うまく作れませんでした: " + (e && e.message || e));
    }
    if (lock) try { lock.release(); } catch (e) { /* もう外れている */ }
    map.setPaintProperty("photo", "raster-fade-duration", 400);
    $("fly-progress").hidden = true;
    busy = false; setButtons(true);
    renderAt(sp.t, true);
    $("fly-empty").hidden = media.length > 0 || !$("fly-loading").hidden;
  }
  // 3D の全体図を 1 枚撮る（道はペースの色、現在地の丸や山名は出さない）。撮ったら元の場面に戻す
  async function shot3d() {
    var b = new maplibregl.LngLatBounds(); route.line.forEach(function (q) { b.extend([q[1], q[0]]); });
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    var c0 = map.cameraForBounds(b, { padding: { top: 150, bottom: 300, left: 40, right: 40 }, pitch: 0, bearing: 0 });
    var ctr = [c0.center.lng != null ? c0.center.lng : c0.center[0], c0.center.lat != null ? c0.center.lat : c0.center[1]];
    map.jumpTo({ center: ctr, zoom: c0.zoom - 0.2, pitch: 50, bearing: -18, elevation: groundAt(ctr[0], ctr[1], route.len / 2) });
    var st = showState(sp.show, sp.show.total - 0.01);
    setLine(st, "inset"); map.setPaintProperty("route", "line-gradient", progressExpr(1)); map.setPaintProperty("route", "line-width", 6);
    ["peak-label", "gsi-anno", "ofm-hut"].forEach(function (id) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none"); });
    await settle(8000);
    var mc = map.getCanvas(), cv = document.createElement("canvas"); cv.width = mc.width; cv.height = mc.height; cv.getContext("2d").drawImage(mc, 0, 0);
    map.setPaintProperty("route", "line-width", 4);
    stageMap(true); renderAt(sp.t, true);
    return cv;
  }
  function makeCard(bg) {
    var CW = 1080, CH = 1350, c = document.createElement("canvas"); c.width = CW; c.height = CH;
    var x = c.getContext("2d"), hl = highlight();
    if (bg) return makeCard3d(c, x, bg, hl);
    var cover = function (src, sw, sh) { var sc = Math.max(CW / sw, CH / sh); x.drawImage(src, (CW - sw * sc) / 2, (CH - sh * sc) / 2, sw * sc, sh * sc); };
    x.fillStyle = "#16241d"; x.fillRect(0, 0, CW, CH);
    var hs = hl && mediaSrc(hl);
    if (hs) cover(hs[0], hs[1], hs[2]);
    else { var mc = map.getCanvas(); cover(mc, mc.width, mc.height); }
    var g = x.createLinearGradient(0, CH * 0.3, 0, CH); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.82)");
    x.fillStyle = g; x.fillRect(0, 0, CW, CH);
    var g2 = x.createLinearGradient(0, 0, 0, 220); g2.addColorStop(0, "rgba(0,0,0,.45)"); g2.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g2; x.fillRect(0, 0, CW, 220);
    var T = function (s2, px, py, size, weight, color, align) {
      x.font = weight + " " + size + "px system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif"; x.textAlign = align || "left";
      x.fillStyle = color || "#fff"; x.shadowColor = "rgba(0,0,0,.5)"; x.shadowBlur = 14; x.fillText(s2, px, py); x.shadowBlur = 0;
    };
    // 道の形（北が上）
    var la = route.line.map(function (q) { return q[0]; }), lo = route.line.map(function (q) { return q[1]; });
    var mla = (Math.min.apply(null, la) + Math.max.apply(null, la)) / 2, kx = Math.cos(mla * rad);
    var bx0 = Math.min.apply(null, lo) * kx, bx1 = Math.max.apply(null, lo) * kx, by0 = Math.min.apply(null, la), by1 = Math.max.apply(null, la);
    var boxW = 640, boxH = 470, sc = Math.min(boxW / ((bx1 - bx0) || 1e-6), boxH / ((by1 - by0) || 1e-6)), ox = 80, oy = 560;
    var P = function (q) { return [ox + (q[1] * kx - bx0) * sc, oy + boxH - (q[0] - by0) * sc]; };
    var pa = paceOn() ? paceArr() : null;
    x.lineJoin = "round"; x.lineCap = "round";
    x.beginPath(); route.line.forEach(function (q, i) { var pt = P(q); if (i) x.lineTo(pt[0], pt[1]); else x.moveTo(pt[0], pt[1]); });
    x.lineWidth = 16; x.strokeStyle = "rgba(255,255,255,.95)"; x.stroke();
    var cum = 0;
    for (var i = 1; i < route.line.length; i++) {
      cum += dist(route.line[i - 1], route.line[i]);
      var a = P(route.line[i - 1]), b = P(route.line[i]);
      x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.lineWidth = 9;
      x.strokeStyle = pa ? paceColor(pa[Math.min(pa.length - 1, Math.round(cum / route.len * (pa.length - 1)))]) : REST; x.stroke();
    }
    var info = titleInfo(), mh = movingHours(), g3 = gainUp();
    T("HutsGo", CW - 60, 92, 40, 800, "#fff", "right");
    if (info.date) T(info.date, 60, 92, 34, 700, "#fff");
    T(info.title + (info.sub ? "  " + info.sub : ""), 60, 1130, info.title.length > 9 ? 56 : 68, 800, "#fff");
    var stats = [["距離", fmtDist(route.len)], ["登り", g3 ? g3.toLocaleString() + " m" : "—"], ["行動時間", mh ? Math.floor(mh.h) + ":" + String(Math.round(mh.h % 1 * 60)).padStart(2, "0") : "—"]];
    stats.forEach(function (st2, j) { var px = 60 + j * 330; T(st2[0], px, 1210, 30, 600, "rgba(255,255,255,.8)"); T(st2[1], px, 1280, 54, 800, "#fff"); });
    return c;
  }
  async function shareCard() {
    var c = cardCanvas || makeCard(), blob = await new Promise(function (ok) { c.toBlob(ok, "image/jpeg", 0.92); });
    var name = "hutsgo-" + (route.source === "gpx" ? "yama" : route.id) + ".jpg", file = null;
    try { file = new File([blob], name, { type: "image/jpeg" }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "山ムービー" }); track("flyover_card"); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    track("flyover_card");
  }
  var cardCanvas = null;
  function mediaSrc(m) {   // 今描ける絵（写真・再生中の動画・取っておいた絵・ファイルから作った絵）
    if (m.kind !== "video") return m.img ? [m.img, m.img.width, m.img.height] : null;
    if (m.dframes && m.dframes.length) { var d = m.dframes[0].cv; return [d, d.width, d.height]; }
    if (vidLive(m) && m.liveOK !== false) return [m.el, m.el.videoWidth, m.el.videoHeight];
    if (m.lastCv && m.frameOK) return [m.lastCv, m.lastCv.width, m.lastCv.height];
    return null;
  }
  async function openShareSheet() {
    if (busy) return;
    pauseSp(); busy = true; setButtons(false);
    $("fly-sheet").hidden = false;
    // 画像は開いたときに作る（作る前は img を置かない）
    var box = $("fly-card-box"), img = $("fly-card-img");
    if (!img) { img = document.createElement("img"); img.id = "fly-card-img"; img.className = "fly-card-preview"; img.alt = "共有用の画像（3D の地図に歩いた道と記録）"; box.appendChild(img); }
    img.alt = "共有用の画像（写真に歩いた道と記録を重ねたもの）"; img.removeAttribute("src"); box.classList.add("is-loading");
    cardCanvas = makeCard();
    img.src = cardCanvas.toDataURL("image/jpeg", 0.85); box.classList.remove("is-loading");
    busy = false; setButtons(true);
  }
  // 道を立体で描く（地図は使わず、写真の上に浮かべる）: 道の広がりの主軸を横にし、斜め上から見た形に。標高は強調する。
  // 足元の影と、道から地面へ降りる細い線で高さを見せる
  function drawRoute3d(x, bx, by, bw, bh) {
    var L = route.line, n = L.length, step = Math.max(1, Math.floor(n / 700)), la0 = L[0][0], lo0 = L[0][1];
    var kx = Math.cos(la0 * rad) * 111320, ky = 110540, pts = [], cum = 0, prev = null;
    for (var i = 0; i < n; i += step) {
      var q = L[i]; if (prev) cum += dist(prev, q); prev = q;
      pts.push({ x: (q[1] - lo0) * kx, y: (q[0] - la0) * ky, z: eleAt(Math.min(cum, route.len)), d: cum });
    }
    var zs = pts.map(function (p2) { return p2.z; }).filter(function (v) { return v != null; });
    var zmin = zs.length ? Math.min.apply(null, zs) : 0, zmax = zs.length ? Math.max.apply(null, zs) : 1;
    pts.forEach(function (p2) { if (p2.z == null) p2.z = zmin; });
    var mx = 0, my = 0; pts.forEach(function (p2) { mx += p2.x; my += p2.y; }); mx /= pts.length; my /= pts.length;
    var sxx = 0, syy = 0, sxy = 0; pts.forEach(function (p2) { var a = p2.x - mx, b = p2.y - my; sxx += a * a; syy += b * b; sxy += a * b; });
    var th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ct = Math.cos(-th), st2 = Math.sin(-th), tilt = 58 * rad;
    var ext = Math.sqrt(Math.max(sxx, syy) / pts.length) * 4 || 1, zex = Math.min(4, 0.3 * ext / Math.max(1, zmax - zmin));
    var V = pts.map(function (p2) {
      var a = p2.x - mx, b = p2.y - my, xr = a * ct - b * st2, yr = a * st2 + b * ct;
      return { X: xr, Y: -yr * Math.cos(tilt) - (p2.z - zmin) * zex * Math.sin(tilt), G: -yr * Math.cos(tilt), d: p2.d, z: p2.z };
    });
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    V.forEach(function (v) { x0 = Math.min(x0, v.X); x1 = Math.max(x1, v.X); y0 = Math.min(y0, v.Y, v.G); y1 = Math.max(y1, v.Y, v.G); });
    var sc = Math.min(bw / ((x1 - x0) || 1), bh / ((y1 - y0) || 1)), ox = bx + (bw - (x1 - x0) * sc) / 2 - x0 * sc, oy = by + (bh - (y1 - y0) * sc) / 2 - y0 * sc;
    var P = function (v, g) { return [ox + v.X * sc, oy + (g ? v.G : v.Y) * sc]; };
    var line = function (g) { x.beginPath(); V.forEach(function (v, i) { var q = P(v, g); if (i) x.lineTo(q[0], q[1]); else x.moveTo(q[0], q[1]); }); };
    x.save(); x.lineJoin = "round"; x.lineCap = "round";
    line(true); x.strokeStyle = "rgba(0,0,0,.35)"; x.lineWidth = 10; x.shadowColor = "rgba(0,0,0,.5)"; x.shadowBlur = 16; x.stroke(); x.shadowBlur = 0;   // 足元の影
    x.strokeStyle = "rgba(255,255,255,.22)"; x.lineWidth = 2;   // 高さの線
    for (var j = 0; j < V.length; j += Math.max(1, Math.round(V.length / 90))) { var a2 = P(V[j], true), b2 = P(V[j], false); x.beginPath(); x.moveTo(a2[0], a2[1]); x.lineTo(b2[0], b2[1]); x.stroke(); }
    line(false); x.strokeStyle = "#fff"; x.lineWidth = 15; x.shadowColor = "rgba(0,0,0,.45)"; x.shadowBlur = 14; x.stroke(); x.shadowBlur = 0;
    var pa = paceOn() ? paceArr() : null;
    for (var k2 = 1; k2 < V.length; k2++) {
      var u = P(V[k2 - 1], false), w2 = P(V[k2], false);
      x.beginPath(); x.moveTo(u[0], u[1]); x.lineTo(w2[0], w2[1]); x.lineWidth = 8;
      x.strokeStyle = pa ? paceColor(pa[Math.min(pa.length - 1, Math.round(V[k2].d / route.len * (pa.length - 1)))]) : REST; x.stroke();
    }
    var s0 = P(V[0], false), s1 = P(V[V.length - 1], false);
    [[s0, "#3CC46B"], [s1, "#E4572E"]].forEach(function (q) { x.beginPath(); x.arc(q[0][0], q[0][1], 13, 0, Math.PI * 2); x.fillStyle = q[1]; x.fill(); x.lineWidth = 5; x.strokeStyle = "#fff"; x.stroke(); });
    var hi = V.reduce(function (a, v) { return v.z > a.z ? v : a; }, V[0]), hp = P(hi, false);   // いちばん高い所
    x.beginPath(); x.moveTo(hp[0], hp[1] - 40); x.lineTo(hp[0] - 15, hp[1] - 14); x.lineTo(hp[0] + 15, hp[1] - 14); x.closePath(); x.fillStyle = "#fff"; x.fill();
    x.restore();
  }
  function makeCardPhoto(c, x, hl) {
    var CW = c.width, CH = c.height, src = hl.kind === "video" ? hl.el : hl.img;
    var sw = hl.kind === "video" ? hl.el.videoWidth : hl.img.width, sh = hl.kind === "video" ? hl.el.videoHeight : hl.img.height, sc = Math.max(CW / sw, CH / sh);
    x.drawImage(src, (CW - sw * sc) / 2, (CH - sh * sc) / 2, sw * sc, sh * sc);
    var g = x.createLinearGradient(0, CH * 0.25, 0, CH); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(0.45, "rgba(0,0,0,.3)"); g.addColorStop(1, "rgba(0,0,0,.85)");
    x.fillStyle = g; x.fillRect(0, 0, CW, CH);
    var g2 = x.createLinearGradient(0, 0, 0, 240); g2.addColorStop(0, "rgba(0,0,0,.5)"); g2.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g2; x.fillRect(0, 0, CW, 240);
    drawRoute3d(x, 90, 470, CW - 180, 520);
    cardText(c, x);
    return c;
  }
  function cardText(c, x) {
    var CW = c.width, T = function (s2, px, py, size, weight, color, align) {
      x.font = weight + " " + size + "px system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif"; x.textAlign = align || "left";
      x.fillStyle = color || "#fff"; x.shadowColor = "rgba(0,0,0,.55)"; x.shadowBlur = 14; x.fillText(s2, px, py); x.shadowBlur = 0;
    };
    var info = titleInfo(), mh = movingHours(), g3 = gainUp();
    T("HutsGo", CW - 56, 92, 40, 800, "#fff", "right");
    if (info.date) T(info.date, 56, 92, 34, 700, "#fff");
    T(info.title + (info.sub ? "  " + info.sub : ""), 56, 1110, info.title.length > 9 ? 56 : 70, 800, "#fff");
    var stats = [["距離", fmtDist(route.len)], ["登り", g3 ? g3.toLocaleString() + " m" : "—"], ["行動時間", mh ? Math.floor(mh.h) + ":" + String(Math.round(mh.h % 1 * 60)).padStart(2, "0") : "—"]];
    stats.forEach(function (st2, j) { var px2 = 56 + j * 330; T(st2[0], px2, 1196, 30, 600, "rgba(255,255,255,.8)"); T(st2[1], px2, 1268, 56, 800, "#fff"); });
    if (paceOn()) {   // ペースの凡例
      var lx = CW - 56 - 260, ly = 1312, lg = x.createLinearGradient(lx, 0, lx + 260, 0);
      PACE.forEach(function (q, i) { lg.addColorStop(i / (PACE.length - 1), "rgb(" + q[1].join(",") + ")"); });
      x.fillStyle = lg; x.beginPath(); x.roundRect(lx, ly - 10, 260, 10, 5); x.fill();
      T("ゆっくり", lx - 10, ly, 20, 600, "rgba(255,255,255,.85)", "right"); T("速い", lx + 270, ly, 20, 600, "rgba(255,255,255,.85)", "left");
    }
  }
  function makeCard3d(c, x, bg, hl) {
    var CW = c.width, CH = c.height;
    // 3D の全体図を 4:5 に切り出す（道は上寄りに撮ってある）
    var bh = bg.width * CH / CW, by = Math.max(0, Math.min(bg.height - bh, bg.height * 0.36 - bh / 2));
    x.drawImage(bg, 0, by, bg.width, bh, 0, 0, CW, CH);
    var g = x.createLinearGradient(0, CH * 0.55, 0, CH); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.85)");
    x.fillStyle = g; x.fillRect(0, 0, CW, CH);
    var g2 = x.createLinearGradient(0, 0, 0, 240); g2.addColorStop(0, "rgba(0,0,0,.5)"); g2.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g2; x.fillRect(0, 0, CW, 240);
    var T = function (s2, px, py, size, weight, color, align) {
      x.font = weight + " " + size + "px system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif"; x.textAlign = align || "left";
      x.fillStyle = color || "#fff"; x.shadowColor = "rgba(0,0,0,.55)"; x.shadowBlur = 14; x.fillText(s2, px, py); x.shadowBlur = 0;
    };
    if (hl && mediaReady(hl)) {   // ★ の写真を右上に小さく
      var src = hl.kind === "video" ? hl.el : hl.img, sw = hl.kind === "video" ? hl.el.videoWidth : hl.img.width, sh = hl.kind === "video" ? hl.el.videoHeight : hl.img.height;
      var S = 230, px = CW - S - 56, py = 130, sc = Math.max(S / sw, S / sh);
      x.save(); x.shadowColor = "rgba(0,0,0,.5)"; x.shadowBlur = 24; x.beginPath(); x.roundRect(px, py, S, S, 24); x.fillStyle = "#fff"; x.fill(); x.shadowBlur = 0;
      x.beginPath(); x.roundRect(px + 6, py + 6, S - 12, S - 12, 19); x.clip();
      x.drawImage(src, px + 6 + (S - 12 - sw * sc) / 2, py + 6 + (S - 12 - sh * sc) / 2, sw * sc, sh * sc); x.restore();
    }
    var info = titleInfo(), mh = movingHours(), g3 = gainUp();
    T("HutsGo", CW - 56, 92, 40, 800, "#fff", "right");
    if (info.date) T(info.date, 56, 92, 34, 700, "#fff");
    T(info.title + (info.sub ? "  " + info.sub : ""), 56, 1110, info.title.length > 9 ? 56 : 70, 800, "#fff");
    var stats = [["距離", fmtDist(route.len)], ["登り", g3 ? g3.toLocaleString() + " m" : "—"], ["行動時間", mh ? Math.floor(mh.h) + ":" + String(Math.round(mh.h % 1 * 60)).padStart(2, "0") : "—"]];
    stats.forEach(function (st2, j) { var px2 = 56 + j * 330; T(st2[0], px2, 1196, 30, 600, "rgba(255,255,255,.8)"); T(st2[1], px2, 1268, 56, 800, "#fff"); });
    if (paceOn()) {   // ペースの凡例
      var lx = CW - 56 - 260, ly = 1312, lg = x.createLinearGradient(lx, 0, lx + 260, 0);
      PACE.forEach(function (q, i) { lg.addColorStop(i / (PACE.length - 1), "rgb(" + q[1].join(",") + ")"); });
      x.fillStyle = lg; x.beginPath(); x.roundRect(lx, ly - 10, 260, 10, 5); x.fill();
      T("ゆっくり", lx - 10, ly, 20, 600, "rgba(255,255,255,.85)", "right"); T("速い", lx + 270, ly, 20, 600, "rgba(255,255,255,.85)", "left");
    }
    return c;
  }
  async function shareVideo() {
    if (!lastExport) return;
    try { await navigator.share({ files: [new File([lastExport.blob], lastExport.name, { type: lastExport.type })], title: "山ムービー" }); }
    catch (e) { if (e && e.name !== "AbortError") status("共有できませんでした。「保存する」から保存してください。"); }
  }
  function setButtons(on) { ["fly-record", "fly-preview", "fly-play"].forEach(function (id) { var b = $(id); if (b) b.disabled = !on; }); }
  function track(ev) {
    var api = (document.querySelector('meta[name="hutsgo-api"]') || {}).content;
    if (api && navigator.sendBeacon) {
      navigator.sendBeacon(api + "/track.php", new Blob([JSON.stringify({ ev: ev, lang: "ja", hut: "", trail: route.source === "gpx" ? "" : route.id, page: location.pathname, ref: "" })], { type: "text/plain" }));
    }
  }

  // ------------------------------------------------------------------ 起動
  async function useRoute(r) {
    pauseSp(); sp.t = 0;
    route = prepRoute(r); route._pv = null; route.profile = null; lastLight = null; overviewCamCache = null; outroCamCache = null;
    await loadHuts();
    await nearbyHuts();
    setRouteOnMap();
    if (Q.get("nolabels") !== "1") setLabelsOnMap();   // 試験用: 文字なしで速さを比べる
    setRegion();
    prefetchBase(); lastAhead = -1e9;
    try { route.peaks = REGION === "jp" ? await loadPeaks() : []; } catch (e) { route.peaks = []; }
    if (map.getSource("peaks")) setLabelsOnMap();
    place(); renderList(); renderEnergy();
    status("地形を読み込んでいます…");
    await overview();
    stageMap(true);
    renderEnergy();   // 登り下りは標高の断面を測った後でないと出せない
    sp.show = buildShow(); sp.t = posterT();
    refreshShow();
    $("fly-empty").hidden = media.length > 0;
    $("fly-pace-row").hidden = !route.times;
    $("fly-title").placeholder = titleInfo().title;   // 空欄なら自動（いちばん高い山の名前）
    media.forEach(function (m) { m.inset = null; m.insetSharp = false; });
    status(route.source === "gpx"
      ? "GPX を読み込みました（" + fmtDist(route.len) + (route.times ? "・時刻あり" : "・時刻なし") + (route.ele ? "・標高あり" : "") + "）。"
      : "");
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
    // 隠したファイル選択を、見た目の整ったボタンから開く
    document.addEventListener("click", function (e) { var b = e.target.closest("[data-pick]"); if (b) $(b.dataset.pick).click(); });
    // 長さ: ボタンで選ぶ（中身は隠した select）
    var chips = document.querySelectorAll(".fly-chips [data-len]");
    var markLen = function () { chips.forEach(function (c) { c.setAttribute("aria-checked", String(c.dataset.len === $("fly-len").value)); }); };
    chips.forEach(function (c) { c.addEventListener("click", function () { $("fly-len").value = c.dataset.len; markLen(); $("fly-len").dispatchEvent(new Event("change")); }); });
    markLen();
    $("fly-cancel").addEventListener("click", function () { exportCancel = true; });
    $("fly-share").addEventListener("click", shareVideo);
    $("fly-share-open").addEventListener("click", openShareSheet);
    $("fly-card-share").addEventListener("click", shareCard);
    $("fly-card-video").addEventListener("click", function () { $("fly-sheet").hidden = true; exportVideo(); });
    $("fly-sheet-close").addEventListener("click", function () { $("fly-sheet").hidden = true; });
    $("fly-auto-pick").addEventListener("click", function () { autoPick(sp.show.rec[1]); renderList(); sp.show = buildShow(); sp.t = posterT(); refreshShow(); });
    $("fly-use-all").addEventListener("click", function () { useAll(); renderList(); sp.show = buildShow(); sp.t = posterT(); refreshShow(); });
    $("fly-pace").addEventListener("change", function () { renderAt(sp.t, true); });
    var titleTimer = null;
    $("fly-title").addEventListener("input", function () { clearTimeout(titleTimer); titleTimer = setTimeout(function () { sp.show = buildShow(); renderAt(sp.t, false); }, 250); });
    $("fly-result-close").addEventListener("click", function () { $("fly-result").hidden = true; $("fly-video").pause(); });
    $("fly-play").addEventListener("click", function () { if (sp.playing) pauseSp(); else playSp(); });
    var seekTimer = null, posPending = false;
    $("fly-seek").addEventListener("input", function (e) {
      pauseSp(); sp.t = Number(e.target.value) / 1000 * sp.show.total;
      renderAt(sp.t, false);
      clearTimeout(seekTimer); seekTimer = setTimeout(function () { renderAt(sp.t, true); }, 250);
    });
    $("fly-len").addEventListener("change", function () { pauseSp(); sp.show = buildShow(); sp.t = posterT(); refreshShow(); });
    // 動画の使う場面を手で選ぶ（動かすとすぐ画面に出す）
    $("fly-list").addEventListener("input", function (e) {
      var c = e.target.closest("[data-clip]"); if (!c) return;
      var m = media[Number(c.dataset.clip)];
      m.clipManual = Number(c.value);
      var box = c.closest(".fly-trim"); box.querySelector(".fly-trim-label").textContent = clipText(m); box._place && box._place();
      showClip(m);
    });
    $("fly-list").addEventListener("change", function (e) {
      if (!e.target.closest("[data-clip]")) return;
      renderList();
    });
    // 道の上の位置を手で合わせる
    $("fly-list").addEventListener("input", function (e) {
      var r = e.target.closest("[data-pos]"); if (!r) return;
      var m = media[Number(r.dataset.pos)];
      m.d = Number(r.value) / 1000 * route.len; m.placed = "manual"; m.manualFor = route.id; m.pov = null; m.inset = null; m.insetSharp = false;
      r.closest(".fly-edit").querySelector("p").textContent = placeText(m) + (m.dir != null ? "・撮影方向あり" : "");
      // 動かしている間も、その写真の場面を画面に出す（組み直しは 1 コマに 1 回まで）
      if (posPending) return;
      posPending = true;
      requestAnimationFrame(function () { posPending = false; sp.show = buildShow(); showClip(m); });
    });
    $("fly-list").addEventListener("change", function (e) {
      if (!e.target.closest("[data-pos]")) return;
      var m = media[Number(e.target.dataset.pos)];
      media.sort(function (a, b) { return a.d - b.d; }); openIdx = media.indexOf(m); renderList(); refreshShow();
    });
    // 写真を押すと場所の編集欄を開く／外す
    $("fly-list").addEventListener("click", function (e) {
      var o = e.target.closest("[data-open]"), r = e.target.closest("[data-rm-media]"), au = e.target.closest("[data-clip-auto]");
      if (au) { var mm = media[Number(au.dataset.clipAuto)]; mm.clipManual = null; renderList(); showClip(mm); return; }
      var us = e.target.closest("[data-use]");
      if (us) {
        var mu = media[Number(us.dataset.use)];
        if (mu.skip) { mu.skip = false; mu.skipBy = null; mu.forceUse = true; } else { mu.skip = true; mu.skipBy = "user"; mu.forceUse = false; }
        renderList(); sp.show = buildShow(); refreshShow(); if (!mu.skip) showClip(mu);
        return;
      }
      if (o) { var i = Number(o.dataset.open); openIdx = openIdx === i ? -1 : i; renderList(); return; }
      if (r) {
        var m = media.splice(Number(r.dataset.rmMedia), 1)[0];
        if (m && m.url) URL.revokeObjectURL(m.url);
        if (m && m.el) m.el.remove();
        openIdx = -1; renderList(); refreshShow();
      }
    });
    $("fly-record").addEventListener("click", exportVideo);
    bindEnergy();
    $("fly-preview").addEventListener("click", previewVideo);
    // ★: 冒頭（フック）に使う写真・動画を選ぶ
    $("fly-list").addEventListener("click", function (e) {
      var b = e.target.closest("[data-star]"); if (!b) return;
      var m = media[Number(b.dataset.star)]; var on = !m.star;
      media.forEach(function (x) { x.star = false; }); m.star = on; renderList(); sp.show = buildShow(); sp.t = posterT(); refreshShow();
    });
    window.HutsGoFlyover = {
      map: map, play: playSp, pause: pauseSp, seekT: function (t) { pauseSp(); sp.t = t; renderAt(t, true); },
      // 試験用: 道の d の地点を指定の傾きで狙い、遮られたまま残ったかを返す
      sun: function (ms, lat, lon) { return sunPos(ms, lat, lon); },
      timeline: function () { var sh = buildShow(); return { total: sh.total, kinds: sh.ev.map(function (e) { return e.kind; }), ts: sh.ev.map(function (e) { return [e.t0, e.t1]; }), info: sh.info, chosen: sh.chosen.length }; },
      pov: function (i) { var m = media[i]; m.pov = null; return povCam(m); },
      flyDebug: async function (d) {
        var cam = flyCam(d, true); map.jumpTo(cam); await settle(15000);
        var dot = at(route, d), rl = railAt(d), q = map.project([dot[1], dot[0]]), c = map.project(map.getCenter());
        var res = { railOff: Math.round(dist(dot, rl)), dotY: Math.round(q.y), centerY: Math.round(c.y), h: map.getContainer().clientHeight,
                    padding: map.getPadding(), pitch: map.getPitch(), zoom: map.getZoom() };
        return res;
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
        return { route: route.id, region: REGION, pins: pinsDrawn, source: route.source, len: route.len, t: sp.t, total: sp.show && sp.show.total, playing: sp.playing, tz: tz && tz.ms,
                 hutsNear: (route.stops || []).filter(function (s) { return s.kind === "hut"; }).map(function (s) { return s.id != null ? s.id : s.name.ja; }),
                 media: media.map(function (m) { return { name: m.name, placed: m.placed, d: m.d, exif: !!m.exif, clip: m.kind === "video" ? vstart(m) : null, scored: !!m.scores, decoded: m.dframes ? m.dframes.length : 0, decodeErr: m.decodeErr || null, rot: m.demux ? m.demux.rot : null }; }), profile: !!(route.ele || route.profile),
                 time: $("fly-time").textContent, list: $("fly-list").textContent, energy: energy(), foods: foods.length,
                 energyText: $("fly-energy-sum").textContent,
                 peaks: (route.peaks || []).map(function (p) { return p.name.ja + (p.elev ? ":" + p.elev : ""); }), light: lastLight,
                 dirs: media.map(function (m) { return m.dir == null ? null : Math.round(m.dir); }), highlight: (highlight() || {}).name || null,
                 tiles: { stored: store.size, queued: queue.length, inflight: inflight } };
      }
    };
  }
  boot();
})();
