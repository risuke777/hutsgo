/* 地理院の標高 PNG（dem_png）の「データ無し」を埋める。行程ボードの 3D・ルートページの 3D・山ムービーで共通。
   湖・海などの「データ無し」（RGB = 128,0,0）は、そのまま読むと +83,886m の突起になって空に縦の縞が立つ。
   同じ行のいちばん近い左右の値のうち低い方（だいたい岸の高さ）で埋める。行ぜんぶが無し（海）は 0m。
     HutsGoGsiDem.fill(arrayBuffer) → Promise<arrayBuffer>（埋める所が無ければ元のまま）
     HutsGoGsiDem.register()        → MapLibre に gsidem://〜 を足す（https:// に読み替えて取り、埋めて渡す） */
(function () {
  function hole(d, k) { return d[k] === 128 && d[k + 1] === 0 && d[k + 2] === 0; }
  // 地理院の標高 PNG の値（m）。2^23 以上は負の値
  function val(d, k) { var v = d[k] * 65536 + d[k + 1] * 256 + d[k + 2]; return (v >= 8388608 ? v - 16777216 : v) * 0.01; }

  function fill(buf) {
    if (!window.OffscreenCanvas || !window.createImageBitmap) return Promise.resolve(buf);
    return createImageBitmap(new Blob([buf], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" }).then(function (bm) {
      var w = bm.width, h = bm.height, c = new OffscreenCanvas(w, h), g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(bm, 0, 0);
      var im = g.getImageData(0, 0, w, h), d = im.data, any = false, i;
      for (i = 0; i < d.length; i += 4) if (hole(d, i)) { any = true; break; }
      if (!any) return buf;
      for (var y = 0; y < h; y++) {
        var row = y * w * 4, left = new Array(w), last = null, x, k;
        for (x = 0; x < w; x++) { k = row + x * 4; if (!hole(d, k)) last = k; left[x] = last; }
        var right = null;
        for (x = w - 1; x >= 0; x--) {
          k = row + x * 4;
          if (!hole(d, k)) { right = k; continue; }
          var a = left[x], b = right, src = a == null ? b : b == null ? a : (val(d, a) <= val(d, b) ? a : b);
          if (src == null) { d[k] = 0; d[k + 1] = 0; d[k + 2] = 0; }
          else { d[k] = d[src]; d[k + 1] = d[src + 1]; d[k + 2] = d[src + 2]; }
        }
      }
      g.putImageData(im, 0, 0);
      return c.convertToBlob({ type: "image/png" }).then(function (b) { return b.arrayBuffer(); });
    }).catch(function () { return buf; });
  }

  function register() {
    if (!window.maplibregl || maplibregl.__hgGsiDem) return;
    maplibregl.__hgGsiDem = true;
    maplibregl.addProtocol("gsidem", function (params, abort) {
      var url = params.url.replace(/^gsidem:\/\//, "https://");
      return fetch(url, { signal: abort && abort.signal }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      }).then(fill).then(function (out) { return { data: out }; });
    });
  }

  window.HutsGoGsiDem = { fill: fill, register: register };
})();
