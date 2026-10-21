// 行程ボードの地図で小屋を押したときの絵（3D の静止画）を作る。小屋の写真が無い小屋に使う。
// 小屋を真ん中に置き、まわりでいちばん高い方角を向いて斜めに見下ろす（山が奥に入る）。
//
//   python build.py                        # 先に dist/data/huts.json と huts-osm.json を作る
//   node tools/hut_posters.mjs             # まだ絵の無い小屋 → static/img/huts/<id>.jpg（640×400）
//   node tools/hut_posters.mjs --all       # 全部作り直す
//   node tools/hut_posters.mjs lavaredo    # 指定した小屋だけ
//
// 要るもの: Google Chrome と puppeteer-core（npm i puppeteer-core。リポジトリには入れていない）。
// 写真と標高: 日本は国土地理院（航空写真・標高）、日本の外は EOxCloudless 2025（非商用）と Terrain Tiles（AWS）。
// 日本の外の小屋の位置は OpenStreetMap（ODbL）。絵は Produced Work なので、出す所に出典を添える（plan.js）。
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const ROOT = "C:/Users/tubam/projects/hutsgo-site/hutsgo";
const OUT = path.join(ROOT, "static", "img", "huts");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const W = 640, H = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
const huts = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "data", "huts.json"), "utf8"));
const osm = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "data", "huts-osm.json"), "utf8")).huts || {};
const args = process.argv.slice(2), all = args.includes("--all"), only = args.filter((a) => !a.startsWith("--"));
const todo = huts.map((h) => {
  const o = osm[h.id] || {}, l = h.location || {};
  return { id: h.id, jp: (h.country || "JP") === "JP", lat: l.lat ?? o.lat, lon: l.lon ?? o.lon };
}).filter((h) => h.lat != null && h.lon != null)
  .filter((h) => only.length ? only.some((s) => h.id.includes(s)) : all || !fs.existsSync(path.join(OUT, `${h.id}.jpg`)));
console.log("huts to draw:", todo.length);

const PAGE = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css">
<style>html,body,#m{margin:0;width:${W}px;height:${H}px;overflow:hidden}</style>
<div id="m"></div>
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script>
<script>${fs.readFileSync(path.join(ROOT, "static", "plan3d.js"), "utf8")}</script>
<script>HutsGoMap3D.gsiDem();</script>`;

function style(jp) {
  const GSI = "https://cyberjapandata.gsi.go.jp/xyz/";
  const dem = jp
    ? { type: "raster-dem", tiles: ["gsidem://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 12, encoding: "custom", redFactor: 655.36, greenFactor: 2.56, blueFactor: 0.01, baseShift: 0 }
    : { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 12, encoding: "terrarium" };
  const photo = jp
    ? { type: "raster", tiles: [GSI + "seamlessphoto/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 18 }
    : { type: "raster", tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg"], tileSize: 256, maxzoom: 15 };
  return { version: 8, sources: { photo, dem, hsdem: { ...dem } },
    layers: [{ id: "photo", type: "raster", source: "photo", paint: { "raster-saturation": 0.15, "raster-contrast": 0.1, "raster-fade-duration": 0 } },
             { id: "hs", type: "hillshade", source: "hsdem", paint: { "hillshade-exaggeration": 0.25 } }],
    terrain: { source: "dem", exaggeration: 1.3 },
    sky: { "sky-color": "#9cc3e4", "horizon-color": "#e8eef2", "fog-color": "#dde6ea", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.85 } };
}

const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let ok = 0, ng = [];
try {
  const p = await b.newPage();
  await p.setViewport({ width: W, height: H });
  await p.setContent(PAGE, { waitUntil: "load" });
  for (const h of todo) {
    try {
      const data = await p.evaluate(async (h, st) => {
        const wait = (m, ev, ms) => new Promise((r) => { const t = setTimeout(r, ms); m.once(ev, () => { clearTimeout(t); r(); }); });
        if (window.__m) window.__m.remove();
        const m = window.__m = new maplibregl.Map({ container: "m", style: st, center: [h.lon, h.lat], zoom: 13, pitch: 0, maxPitch: 75, interactive: false,
          attributionControl: false, fadeDuration: 0, canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true } });
        await wait(m, "idle", 30000);
        // まわり 1.5〜3.5km の高さを 12 方角で見て、いちばん高い方を向く（山を奥に入れる）
        const rad = Math.PI / 180, best = { b: 0, e: -1e9 };
        for (let i = 0; i < 12; i++) {
          const br = i * 30; let e = 0;
          for (const d of [1500, 2500, 3500]) {
            const dy = d * Math.cos(br * rad) / 111320, dx = d * Math.sin(br * rad) / (111320 * Math.cos(h.lat * rad));
            e += m.queryTerrainElevation([h.lon + dx, h.lat + dy]) || 0;
          }
          if (e > best.e) { best.e = e; best.b = br; }
        }
        m.jumpTo({ center: [h.lon, h.lat], zoom: h.jp ? 13.8 : 13.3, pitch: 64, bearing: best.b, padding: { top: 70, bottom: 0, left: 0, right: 0 } });
        await wait(m, "idle", 40000);
        await new Promise((r) => setTimeout(r, 400));
        // 小屋の印は絵の上に描く（地図の層の点は、山頂や斜面の小屋だと地形に埋もれて見えない）
        const gl = m.getCanvas(), c = document.createElement("canvas");
        c.width = gl.width; c.height = gl.height;
        const g = c.getContext("2d"), k = gl.width / gl.clientWidth, q = m.project([h.lon, h.lat]);
        g.drawImage(gl, 0, 0);
        g.beginPath(); g.arc(q.x * k, q.y * k, 13 * k, 0, 7); g.fillStyle = "rgba(255,255,255,.4)"; g.fill();
        g.beginPath(); g.arc(q.x * k, q.y * k, 7 * k, 0, 7); g.fillStyle = "#E4572E"; g.fill();
        g.lineWidth = 2.5 * k; g.strokeStyle = "#fff"; g.stroke();
        return c.toDataURL("image/jpeg", 0.8);
      }, h, style(h.jp));
      fs.writeFileSync(path.join(OUT, `${h.id}.jpg`), Buffer.from(data.split(",")[1], "base64"));
      ok++;
      if (ok % 10 === 0) console.log(ok, "/", todo.length);
    } catch (e) {
      ng.push(h.id); console.log(h.id, "NG", String(e.message || e).slice(0, 120));
    }
    await sleep(300);   // タイルの配信元に続けて負荷をかけない
  }
} finally {
  await b.close();
}
console.log("done", ok, "ng", ng.length, ng.join(" "));
