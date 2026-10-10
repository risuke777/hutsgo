// トップのルートカードの絵（3D の静止画）を作る。山ムービーの埋め込み表示で、道が描き終わった場面を正方形に切り出す。
//
//   python build.py                         # 先に dist/ を作る
//   node tools/route_posters.mjs            # 全ルート → static/img/routes/<id>.jpg（720×720）
//   node tools/route_posters.mjs kisokoma   # 1 ルートだけ
//
// 要るもの: Google Chrome と puppeteer-core（npm i puppeteer-core。リポジトリには入れていない）。
// 地図は国土地理院・EOxCloudless（Copernicus Sentinel）。カードの上に出典を重ねて表示する（index.html）。
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "static", "img", "routes");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 8840;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
const all = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "lab", "flyover", "routes.json"), "utf8")).map((r) => r.id);
const ids = process.argv.slice(2).length ? process.argv.slice(2) : all;
const srv = spawn("python", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", path.join(ROOT, "dist")], { stdio: "ignore" });
await sleep(1500);
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  for (const id of ids) {
    const p = await b.newPage();
    await p.setViewport({ width: 540, height: 960 });
    await p.goto(`http://127.0.0.1:${PORT}/lab/flyover/?embed=1&route=${id}`, { waitUntil: "domcontentloaded" });
    await p.waitForFunction(() => window.HutsGoFlyover && window.HutsGoFlyover.state().total > 0, { timeout: 180000, polling: 500 });
    // 道が描き終わった場面（draw の終わり）。無ければ 1 秒目
    const t = await p.evaluate(() => {
      const tl = window.HutsGoFlyover.timeline();
      const i = tl.kinds.indexOf("draw");
      return i >= 0 ? tl.ts[i][1] - 0.05 : 1;
    });
    await p.evaluate((t) => window.HutsGoFlyover.seekT(t), t);
    await sleep(6000);
    await p.evaluate((t) => window.HutsGoFlyover.seekT(t), t);   // タイルが揃ってからもう一度描く
    await sleep(2500);
    const data = await p.evaluate(() => {
      const src = document.getElementById("fly-out"), s = Math.min(src.width, src.height), c = document.createElement("canvas");
      c.width = c.height = 720;
      c.getContext("2d").drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, 720, 720);
      return c.toDataURL("image/jpeg", 0.8);
    });
    fs.writeFileSync(path.join(OUT, `${id}.jpg`), Buffer.from(data.split(",")[1], "base64"));
    console.log(id, "ok");
    await p.close();
  }
} finally {
  await b.close();
  srv.kill();
}
