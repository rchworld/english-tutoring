// 수집기 — 소스에서 새 글의 "메타데이터"를 모으고, 요약용 원문을 임시로 받아 둔다.
//
// 저장 정책
//   data/inbox.json   제목·URL·날짜만. 영구 보관.
//   data/raw/*.md     원문 텍스트. 요약이 끝나면 지운다(scripts/cleanup.mjs).
//   data/articles.json 완성된 요약. 원문은 담지 않는다.
//
// 로그인이 필요한 글은 건드리지 않는다.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const RAW = path.join(DATA, "raw");

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "sources.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

async function get(url) {
  const res = await fetch(url, {
    headers: { "user-agent": cfg.userAgent, accept: "*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return { body: await res.text(), type: res.headers.get("content-type") || "", url: res.url };
}

/* ---------- 파싱 ---------- */

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .trim();
}
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};

function parseFeed(body) {
  const out = [];
  const blocks = body.match(/<item[\s>][\s\S]*?<\/item>/gi)
              || body.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    let link = tag(b, "link");
    if (!link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? m[1] : "";
    }
    const title = tag(b, "title");
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || "";
    if (title && link) out.push({ title, url: link, published: date });
  }
  return out;
}

function parseSitemap(body) {
  const locs = [...body.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => decode(m[1]));
  const mods = [...body.matchAll(/<lastmod>([\s\S]*?)<\/lastmod>/gi)].map((m) => decode(m[1]));
  return locs.map((url, i) => ({ title: "", url, published: mods[i] || "" }));
}

function parseListing(body, pattern) {
  const re = new RegExp(pattern);
  const hrefs = [...body.matchAll(/href="([^"]+)"/gi)].map((m) => decode(m[1]));
  const uniq = [...new Set(hrefs)].filter((h) => re.test(h));
  return uniq.map((url) => ({ title: "", url, published: "" }));
}

/* ---------- 본문 추출 ---------- */

const PAYWALL = /members?\s*only|sign in to (?:read|continue)|log ?in to (?:read|continue)|subscribe to (?:read|continue)|premium content/i;

function extractText(html) {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");

  const main = h.match(/<article[\s>][\s\S]*?<\/article>/i)
            || h.match(/<main[\s>][\s\S]*?<\/main>/i);
  if (main) h = main[0];

  const text = h
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decode(text)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function titleOf(html) {
  const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
  if (og) return decode(og[1]);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return decode(h1[1].replace(/<[^>]+>/g, " "));
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? decode(t[1]) : "";
}

function dateOf(html) {
  const m = html.match(/<meta[^>]+property="article:published_time"[^>]+content="([^"]+)"/i)
         || html.match(/<time[^>]+datetime="([^"]+)"/i);
  return m ? m[1] : "";
}

const slugOf = (url) =>
  url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop().slice(0, 80) || "article";

/* ---------- 실행 ---------- */

const inbox = readJson(path.join(DATA, "inbox.json"), []);
const articles = readJson(path.join(DATA, "articles.json"), []);
const seen = new Set([...inbox, ...articles].map((a) => a.url));

let added = 0;

for (const src of cfg.sources) {
  if (!src.enabled) continue;
  console.log(`\n=== ${src.name}`);

  // 1) 피드 → 2) 사이트맵 → 3) 목록 페이지 순으로 시도
  let found = [];
  for (const url of src.feeds || []) {
    try {
      const { body } = await get(url);
      const items = parseFeed(body);
      if (items.length) { console.log(`  피드 ${url} → ${items.length}건`); found = items; break; }
      console.log(`  피드 ${url} → 항목 없음`);
    } catch (e) { console.log(`  피드 ${url} → ${e.message}`); }
    await sleep(cfg.politeDelayMs);
  }
  if (!found.length) for (const url of src.sitemaps || []) {
    try {
      const { body } = await get(url);
      const items = parseSitemap(body).filter((i) => new RegExp(src.articlePattern).test(i.url));
      if (items.length) { console.log(`  사이트맵 ${url} → ${items.length}건`); found = items.slice(-60).reverse(); break; }
      console.log(`  사이트맵 ${url} → 해당 없음`);
    } catch (e) { console.log(`  사이트맵 ${url} → ${e.message}`); }
    await sleep(cfg.politeDelayMs);
  }
  if (!found.length) for (const url of src.listings || []) {
    try {
      const { body } = await get(url);
      const items = parseListing(body, src.articlePattern);
      if (items.length) { console.log(`  목록 ${url} → ${items.length}건`); found = items; break; }
      console.log(`  목록 ${url} → 해당 없음`);
    } catch (e) { console.log(`  목록 ${url} → ${e.message}`); }
    await sleep(cfg.politeDelayMs);
  }

  if (!found.length) { console.log("  수집 실패 — 소스 구조 확인 필요"); continue; }

  const fresh = found.filter((i) => !seen.has(i.url)).slice(0, cfg.maxNewPerRun);
  console.log(`  신규 ${fresh.length}건 (전체 ${found.length}건 중)`);

  for (const item of fresh) {
    await sleep(cfg.politeDelayMs);
    let page;
    try { page = await get(item.url); }
    catch (e) { console.log(`  ✗ ${item.url} → ${e.message}`); continue; }

    const text = extractText(page.body);

    if (text.length < 800) { console.log(`  ✗ 본문 짧음(${text.length}자) — 건너뜀: ${item.url}`); continue; }
    if (PAYWALL.test(text.slice(0, 4000))) { console.log(`  ✗ 로그인 필요 — 건너뜀: ${item.url}`); continue; }

    const id = `${src.id}-${slugOf(item.url)}`;
    const entry = {
      id,
      source: src.id,
      sourceName: src.name,
      title: item.title || titleOf(page.body),
      url: item.url,
      published: (item.published || dateOf(page.body) || "").slice(0, 10),
      collectedAt: new Date().toISOString().slice(0, 10),
      status: "pending",       // pending → 요약 후 done
      raw: `data/raw/${id}.md`,
      chars: text.length,
    };

    fs.mkdirSync(RAW, { recursive: true });
    fs.writeFileSync(path.join(RAW, `${id}.md`),
      `<!-- 요약용 임시 원문. 요약 완료 후 삭제한다. 저장소에 영구 보관하지 않는다. -->\n` +
      `<!-- ${entry.url} -->\n\n# ${entry.title}\n\n${text.slice(0, 40000)}\n`);

    inbox.unshift(entry);
    seen.add(item.url);
    added++;
    console.log(`  ✓ ${entry.title.slice(0, 60)}  (${text.length}자)`);
  }
}

writeJson(path.join(DATA, "inbox.json"), inbox);
if (!fs.existsSync(path.join(DATA, "articles.json"))) writeJson(path.join(DATA, "articles.json"), articles);

console.log(`\n신규 ${added}건 수집. 대기 중 ${inbox.filter((a) => a.status === "pending").length}건.`);
