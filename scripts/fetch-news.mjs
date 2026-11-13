// 世界ニュースをRSSから集めて news.json を更新するスクリプト（GitHub Actions から定期実行）
// 必要なもの: Node.js 20 以上（追加パッケージ不要）
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 取り込むRSS。増やしたいときはここに追加する（日本語の見出しのフィードが対象）
export const FEEDS = [
  { name: "NHK", url: "https://www.nhk.or.jp/rss/news/cat6.xml" },
  { name: "BBC News Japan", url: "https://feeds.bbci.co.uk/japanese/rss.xml" },
  { name: "CNN.co.jp", url: "http://feeds.cnn.co.jp/rss/cnn/cnn.rdf" },
  { name: "AFPBB News", url: "http://feeds.afpbb.com/rss/afpbb/afpbbnews" },
];
const KEEP_RSS_HOURS = 48, KEEP_OTHER_DAYS = 7, MAX_RSS = 60, PER_PLACE = 3;

const KW = [
  ["disaster", /地震|津波|洪水|台風|ハリケーン|噴火|山火事|墜落|崩落|爆発事故|土砂|豪雨|感染|事故/],
  ["conflict", /空爆|攻撃|戦闘|侵攻|ミサイル|砲撃|無人機|ドローン|停戦|戦争|軍事|死亡|殺害|テロ|銃撃|衝突|占領|人質/],
  ["diplomacy", /会談|協議|首脳|外相|サミット|交渉|合意|制裁|条約|訪問|国連|大使/],
  ["politics", /選挙|大統領|首相|議会|政権|辞任|就任|デモ|抗議|判決|法案|与党|野党/],
  ["economy", /経済|関税|株|市場|金利|インフレ|原油|貿易|GDP|通貨|物価|企業|輸出/],
];
export const classify = (t) => { for (const [k, re] of KW) if (re.test(t)) return k; return "other"; };
const h32 = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const jit = (id, v, amp) => v + ((h32(id + "x" + amp) % 1000) / 1000 - 0.5) * amp;

// 見出しに出てくる地名から場所を推定する（places.json は長い名前順）
export function geotag(title, places) {
  let t = title, best = null;
  for (const p of places) {
    const i = t.indexOf(p.n);
    if (i < 0) continue;
    t = t.split(p.n).join("\u0001".repeat(p.n.length));
    if (!best || p.w < best.p.w || (p.w === best.p.w && i < best.i)) best = { p, i };
  }
  return best && best.p;
}
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml); return m ? decode(m[1]) : ""; };
export function parseRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const it = m[0], title = tag(it, "title"), link = tag(it, "link"), date = tag(it, "pubDate") || tag(it, "dc:date");
    if (title && /^https?:\/\//.test(link)) out.push({ title, link, at: Date.parse(date) || Date.now() });
  }
  return out;
}
export function toItems(entries, source, places) {
  const out = [];
  for (const e of entries) {
    const p = geotag(e.title, places);
    if (!p) continue; // 場所が分からない見出しは地図に出せないので除く
    const id = "rss-" + h32(e.link);
    out.push({ id, title: e.title.slice(0, 140), summary: "報道機関の見出しを自動で取り込み、見出しの地名から場所を推定しています。",
      lat: +jit(id, p.lat, 1.2).toFixed(3), lon: +jit(id, p.lon, 1.6).toFixed(3), cat: classify(e.title),
      at: new Date(Math.min(e.at, Date.now())).toISOString(), source, url: e.link, place: p.label });
  }
  return out;
}
export function merge(oldItems, fresh, now = Date.now()) {
  const keep = oldItems.filter((x) => { const age = now - Date.parse(x.at); return String(x.id).startsWith("rss-") ? age < KEEP_RSS_HOURS * 36e5 : age < KEEP_OTHER_DAYS * 864e5; });
  const ids = new Set(keep.map((x) => x.id)), titles = new Set(keep.map((x) => x.title.slice(0, 14)));
  for (const x of fresh) { if (ids.has(x.id) || titles.has(x.title.slice(0, 14)) || now - Date.parse(x.at) > KEEP_RSS_HOURS * 36e5) continue; ids.add(x.id); titles.add(x.title.slice(0, 14)); keep.push(x); }
  keep.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const per = {}; let rss = 0;
  return keep.filter((x) => { if (!String(x.id).startsWith("rss-")) return true; per[x.place] = (per[x.place] || 0) + 1; if (per[x.place] > PER_PLACE || rss >= MAX_RSS) return false; rss++; return true; });
}
async function main() {
  const places = JSON.parse(await readFile(path.join(ROOT, "places.json"), "utf8"));
  const file = path.join(ROOT, "news.json");
  let old = { items: [] };
  try { old = JSON.parse(await readFile(file, "utf8")); } catch {}
  let fresh = [], okFeeds = 0;
  for (const f of FEEDS) {
    try {
      const r = await fetch(f.url, { headers: { "user-agent": "world-civ-map news fetcher" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const items = toItems(parseRss(await r.text()), f.name, places);
      console.log(`${f.name}: ${items.length} 件`); fresh = fresh.concat(items); okFeeds++;
    } catch (e) { console.log(`${f.name}: 取得失敗 (${e.message})`); }
  }
  const items = merge(old.items || [], fresh);
  const changed = JSON.stringify(items) !== JSON.stringify(old.items || []);
  if (!changed) { console.log("変更なし"); return; }
  await writeFile(file, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 1) + "\n");
  console.log(`news.json を更新: ${items.length} 件（取得できたフィード ${okFeeds}/${FEEDS.length}）`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
