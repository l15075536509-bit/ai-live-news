const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// AI 相关 RSS 源（避免综合性内容源污染）
const FEEDS = [
  { url: "https://www.jiqizhixin.com/rss", source: "机器之心" },
  { url: "https://www.qbitai.com/feed", source: "量子位" },
  { url: "https://rsshub.app/36kr/information/AI", source: "36氪AI" },
  { url: "https://rsshub.app/huxiu/channel/ai", source: "虎嗅AI" }
];

// AI 关键词白名单：标题或摘要中必须出现至少一个
const AI_KEYWORDS = [
  "AI", "人工智能", "机器学习", "深度学习", "神经网络", "大模型", "LLM",
  "GPT", "Claude", "Gemini", "Llama", "Qwen", "通义", "文心", "盘古",
  "智能体", "Agent", "AGI", "NLP", "多模态", "生成式", "AIGC",
  "训练", "推理", "预训练", "微调", "提示词", "Transformer",
  "扩散", "diffusion", "具身智能", "通用人工智能",
  "OpenAI", "Anthropic", "DeepMind", "Hugging Face", "PyTorch",
  "TensorFlow", "H100", "H200", "A100", "B200", "DeepSeek",
  "Sora", "Midjourney", "Stable Diffusion", "ChatGPT",
  "Prompt", "RAG", "向量", "embedding", "扩散模型"
];

// 抓取单个 URL
function fetchUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0 AI-News-Bot/1.0" }, timeout: 15000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrl(res.headers.location).then(resolve);
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// RSS 解析
function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1]?.trim() || "";
    const link = (block.match(/<link>([^<]+)<\/link>/i) || [])[1]?.trim()
              || (block.match(/<guid[^>]*>([^<]+)<\/guid>/i) || [])[1]?.trim() || "#";
    const descRaw = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) || [])[1] || "";
    const contentRaw = (block.match(/<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/i) || [])[1] || descRaw;
    const pubDate = (block.match(/<pubDate>([^<]+)<\/pubDate>/i) || [])[1]?.trim() || "";
    if (title && !title.includes("Copyright")) {
      items.push({ title, link, summary: cleanText(descRaw), content: cleanText(contentRaw), pubDate });
    }
  }
  return items;
}

// 清洗文本：去 HTML、去实体、去 RSS 后缀、去 "查看全文" 等
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/查看全文[.…]*$/, "")
    .replace(/阅读全文[.…]*$/, "")
    .replace(/点击查看[.…]*$/, "")
    .replace(/原文链接[.…]*$/, "")
    .replace(/本文来自[^\n。]*$/, "")
    .replace(/来源：[^\n。]*$/, "")
    .replace(/【[^】]*】/g, "")
    .replace(/[\s…]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 提取首句作为 TL;DR
function extractTldr(text, maxLen) {
  if (!text) return "";
  // 按中文/英文句号、问号、感叹号切分
  const sentences = text.split(/(?<=[。！？!?\.])\s*/);
  let tldr = "";
  for (const s of sentences) {
    tldr += s;
    if (tldr.length >= 30) break;
  }
  if (!tldr) tldr = text.slice(0, maxLen);
  if (tldr.length > maxLen) tldr = tldr.slice(0, maxLen) + "…";
  return tldr;
}

// 抽取关键看点：从内容里挑 3 句有信息密度的句子
function extractKeyPoints(text) {
  if (!text) return [];
  const sentences = text.split(/(?<=[。！？!?\.])\s*/).filter(s => s.length >= 20 && s.length <= 100);
  if (sentences.length === 0) return [];
  return sentences.slice(0, 3);
}

// AI 相关性判断
function isAIArticle(item) {
  const text = item.title + " " + item.summary + " " + (item.content || "");
  return AI_KEYWORDS.some((kw) => text.includes(kw));
}

// 分类
const CATEGORIES = ["模型发布", "产品动态", "行业资本", "开源工具", "论文研究", "观点洞察"];
function guessCategory(item) {
  const t = item.title + " " + item.summary;
  if (/论文|研究|arxiv|发布.*模型|推出.*模型|模型.*发布|发布.*架构/i.test(t)) return "模型发布";
  if (/开源|框架|代码|库|SDK|Toolkit|GitHub|Hugging.?Face|发布.*工具/i.test(t)) return "开源工具";
  if (/上线|推出|发布|功能|App|插件|助手|Chatbot|chatbot|体验/i.test(t)) return "产品动态";
  if (/融资|投资|估值|上市|收购|资本|财报|营收|合并|ipo/i.test(t)) return "行业资本";
  if (/论文|研究|学术|benchmark|评测|方法/i.test(t)) return "论文研究";
  return "行业资本";
}

// 去重
function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = it.title.slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "最近";
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
  return Math.floor(diff / 86400) + " 天前";
}

(async () => {
  console.log("[" + new Date().toISOString() + "] 开始抓取 AI 新闻...");

  let all = [];
  for (const feed of FEEDS) {
    console.log("  抓取: " + feed.source);
    const xml = await fetchUrl(feed.url);
    if (!xml) { console.log("    失败"); continue; }
    const parsed = parseRss(xml);
    console.log("    解析 " + parsed.length + " 条");
    parsed.forEach((p) => { p.source = feed.source; });
    all = all.concat(parsed);
  }

  // AI 关键词过滤
  all = all.filter(isAIArticle);
  console.log("  AI 关键词过滤后: " + all.length + " 条");

  // 去重 + 排序
  all = dedupe(all);
  all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  all = all.slice(0, 25);

  // 构建输出
  const out = all.map((item, i) => {
    const summary = (item.content || item.summary).slice(0, 240);
    return {
      id: i + 1,
      title: item.title,
      url: item.link,
      source: item.source,
      summary: summary,
      tldr: extractTldr(item.content || item.summary, 90),
      keyPoints: extractKeyPoints(item.content || item.summary),
      worthReading: "本文聚焦" + guessCategory(item) + "方向，与 AI 行业趋势相关。",
      category: guessCategory(item),
      heat: Math.max(50, 98 - i * 2),
      time: item.pubDate ? timeAgo(item.pubDate) : "最近"
    };
  });

  // 如果抓取数量不足，保留旧数据
  if (out.length < 3) {
    console.log("  数据过少，保留旧数据");
    try {
      const old = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "news.json"), "utf-8"));
      if (Array.isArray(old) && old.length > out.length) {
        fs.writeFileSync(path.join(__dirname, "..", "news.json"), JSON.stringify(old, null, 2), "utf-8");
        console.log("  保留 " + old.length + " 条旧数据");
        return;
      }
    } catch (e) { /* 忽略 */ }
  }

  fs.writeFileSync(path.join(__dirname, "..", "news.json"), JSON.stringify(out, null, 2), "utf-8");
  console.log("[完成] 共 " + out.length + " 条 AI 新闻");
})().catch((e) => { console.error("抓取失败:", e.message); process.exit(1); });
