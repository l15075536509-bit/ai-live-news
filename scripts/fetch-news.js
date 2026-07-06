const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// --- 中文 AI 新闻 RSS 源 ---
const FEEDS = [
  { url: "https://www.jiqizhixin.com/rss", source: "机器之心" },
  { url: "https://feedx.net/rss/36kr-ai.xml", source: "36氪AI" },
  { url: "https://sspai.com/feed", source: "少数派" },
];

// --- 抓取单个 RSS ---
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(
      url,
      { headers: { "User-Agent": "AI-News-Bot/1.0" }, timeout: 15000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrl(res.headers.location).then(resolve).catch(reject);
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", (e) => {
      console.warn(`  fetch failed: ${url} - ${e.message}`);
      resolve(null);
    });
    req.on("timeout", () => {
      req.destroy();
      console.warn(`  timeout: ${url}`);
      resolve(null);
    });
  });
}

// --- 简单 RSS 解析（提取 title / link / description / pubDate） ---
function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1]?.trim() || "";
    const link = (block.match(/<link>([^<]+)<\/link>/i) || [])[1]?.trim() || "#";
    const descRaw = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) || [])[1] || "";
    const summary = descRaw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
    const pubDate = (block.match(/<pubDate>([^<]+)<\/pubDate>/i) || [])[1]?.trim() || "";
    if (title && !title.includes("Copyright")) items.push({ title, link, summary, pubDate });
  }
  return items;
}

// --- 分类器 ---
const CATEGORIES = ["模型发布", "产品动态", "行业资本", "开源工具", "论文研究", "观点洞察"];
function guessCategory(item) {
  const t = item.title + " " + item.summary;
  if (/模型|发布|开源|权重|参数|架构|训练/i.test(t)) return "模型发布";
  if (/产品|上线|推出|发布|更新|功能|App|应用/i.test(t)) return "产品动态";
  if (/融资|投资|IPO|收购|资本|财报|营收/i.test(t)) return "行业资本";
  if (/开源|GitHub|框架|代码|库|SDK|API|工具/i.test(t)) return "开源工具";
  if (/论文|研究|学术|Idea|State.of.the.Art|benchmark/i.test(t)) return "论文研究";
  if (/观点|思考|趋势|展望|建议|总结|评论|未来/i.test(t)) return "观点洞察";
  return "行业资本";
}

// --- 去重 ---
function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.title.slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- 主流程 ---
(async () => {
  console.log(`[${new Date().toISOString()}] 开始抓取新闻...`);

  let allItems = [];

  for (const feed of FEEDS) {
    console.log(`  抓取: ${feed.source} (${feed.url})`);
    const xml = await fetchUrl(feed.url);
    if (!xml) continue;
    const parsed = parseRss(xml);
    console.log(`    获取 ${parsed.length} 条`);
    allItems.push(
      ...parsed.map((item) => ({
        ...item,
        source: feed.source,
      }))
    );
  }

  // 去重、排序、加热度
  allItems = dedupe(allItems);
  allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  allItems = allItems.slice(0, 30).map((item, index) => ({
    id: index + 1,
    title: item.title,
    url: item.link,
    source: item.source,
    summary: item.summary,
    category: guessCategory(item),
    heat: Math.max(40, 98 - index * 2),
    time: item.pubDate ? timeAgo(item.pubDate) : "最近",
  }));

  // 如果抓取数量太少则保留上次数据
  if (allItems.length < 4) {
    console.log("  抓取数量过少，保留旧数据");
    const oldData = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "news.json"), "utf-8"));
    if (Array.isArray(oldData) && oldData.length > 4) {
      allItems = oldData;
    }
  }

  // 写文件
  fs.writeFileSync(
    path.join(__dirname, "..", "news.json"),
    JSON.stringify(allItems, null, 2),
    "utf-8"
  );

  console.log(`[完成] 共 ${allItems.length} 条新闻`);
})().catch((err) => {
  console.error("抓取失败:", err.message);
  process.exit(1);
});

// --- 时间转换 ---
function timeAgo(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "最近";
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}
