// Template discovery: search GitHub for LaTeX thesis/other templates,
// verify each candidate repo actually contains LaTeX sources, and emit
// candidate JSON entries for the marketplace catalog.
// Usage: node scripts/find-templates.mjs > assets/templates/candidates.json
import { writeFile } from "node:fs/promises";

const TOKEN = process.env.GH_TOKEN || "";
const AUTH = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

async function ghSearch(query, perPage = 30) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`;
  const r = await fetch(url, { headers: { Accept: "application/vnd.github+json", ...AUTH } });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.items ?? []).map((it) => ({
    repo: it.full_name,
    stars: it.stargazers_count,
    desc: (it.description || "").slice(0, 120),
    size_kb: it.size,
    html: it.html_url,
  }));
}

async function repoHasLatex(repo) {
  // cheap check: does the default branch contain any .tex/.cls/.sty files?
  const r = await fetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, {
    headers: { Accept: "application/vnd.github+json", ...AUTH },
  });
  if (!r.ok) return false;
  const j = await r.json();
  const paths = (j.tree ?? []).map((t) => t.path);
  return paths.some((p) => /\.(tex|cls|sty|dtx)$/i.test(p));
}

const QUERIES = [
  // --- Chinese thesis templates (985 coverage + key institutes) ---
  ["thesis-cn", 'language:TeX "论文" latex 模板'],
  ["thesis-cn-2", 'language:TeX "学位论文" template'],
  ["buaa", "北航 论文 latex 模板"],
  ["hit", "哈尔滨工业大学 论文 latex 模板"],
  ["nwpu", "西北工业大学 论文 latex 模板"],
  ["seu", "东南大学 论文 latex 模板"],
  ["tju", "天津大学 论文 latex 模板"],
  ["hust2", "华科 latex 论文"],
  ["hnu", "湖南大学 论文 latex 模板"],
  ["csu", "中南大学 论文 latex 模板"],
  ["cqu", "重庆大学 论文 latex 模板"],
  ["neu", "东北大学 论文 latex 模板"],
  ["uestc", "电子科技大学 论文 latex 模板"],
  ["nankai", "南开大学 论文 latex 模板"],
  ["bnuj", "北京师范大学 论文 latex 模板"],
  ["ruc", "中国人民大学 论文 latex 模板"],
  ["buaa2", "北航 学位论文"],
  ["harbin", "哈工大 thesis"],
  ["njust", "南京理工大学 论文"],
  ["nuaa", "南京航空航天大学 论文"],
  ["bit", "北京理工大学 论文 latex"],
  ["ecnu", "华东师范大学 论文 latex"],
  ["scut", "华南理工大学 论文 latex"],
  ["lzu", "兰州大学 论文 latex"],
  ["cau", "中国农业大学 论文 latex"],
  ["muc", "中央民族大学 论文 latex"],
  ["ouc", "中国海洋大学 论文 latex"],
  ["nwafu", "西北农林科技大学 论文 latex"],
  ["hdu", "杭州电子科技大学 论文"],
  ["gzhu", "广州大学 论文 latex"],
  ["ouc2", "中国海洋大学 thesis"],
  // --- overseas thesis templates ---
  ["cambridge-thesis", "cambridge university thesis latex template"],
  ["oxford-thesis", "oxford university thesis latex"],
  ["mit-thesis", "mit thesis latex template"],
  ["stanford-thesis", "stanford university thesis latex"],
  ["berkeley-thesis", "berkeley thesis latex"],
  ["harvard-thesis", "harvard university thesis latex"],
  ["princeton-thesis", "princeton university thesis latex"],
  ["caltech-thesis", "caltech thesis latex"],
  ["eth-thesis", "eth zurich thesis latex"],
  ["imperial-thesis", "imperial college thesis latex"],
  ["ucl-thesis", "ucl thesis latex template"],
  ["edinburgh-thesis", "edinburgh university thesis latex"],
  ["manchester-thesis", "manchester university thesis latex"],
  ["toronto-thesis", "toronto university thesis latex"],
  ["mcgill-thesis", "mcgill thesis latex"],
  ["ubc-thesis", "ubc thesis latex"],
  ["melbourne-thesis", "melbourne university thesis latex"],
  ["sydney-thesis", "sydney university thesis latex"],
  ["unsw-thesis", "unsw thesis latex"],
  ["nus-thesis", "nus thesis latex"],
  ["ntu-thesis", "ntu thesis latex singapore"],
  ["hku-thesis", "hku thesis latex"],
  ["cuhk-thesis", "cuhk thesis latex"],
  ["hkust-thesis", "hkust thesis latex"],
  ["kaist-thesis", "kaist thesis latex"],
  ["kth-thesis", "kth thesis latex"],
  ["tudelft-thesis", "tudelft thesis latex"],
  ["tum-thesis", "tum thesis latex"],
  ["paris-thesis", "paris thesis latex"],
  ["epfl-thesis", "epfl thesis latex"],
  ["cambridge2", "cam-thesis latex"],
  // --- other template types ---
  ["ieee-paper", "ieee paper latex template"],
  ["acm-paper", "acm paper latex template"],
  ["nature-paper", "nature latex template"],
  ["elsevier-paper", "elsevier latex template"],
  ["prl-paper", "physical review letters latex"],
  ["beamer-theme", "beamer theme metropolis"],
  ["beamer-tsinghua", "beamer 清华大学"],
  ["poster", "academic poster latex beamerposter"],
  ["cv", "latex resume template moderncv"],
  ["awesome-cv", "awesome-cv latex"],
  ["letter", "latex letter template"],
  ["report-cn", "中文 实验报告 latex"],
  ["coursework", "latex coursework template"],
];

const out = {};
const seen = new Set();
for (const [key, q] of QUERIES) {
  try {
    const items = await ghSearch(q, 20);
    const kept = [];
    for (const it of items) {
      if (seen.has(it.repo)) continue;
      seen.add(it.repo);
      if (await repoHasLatex(it.repo)) kept.push(it);
    }
    out[key] = kept;
    console.error(`[${key}] ${kept.length} verified (of ${items.length})`);
  } catch (e) {
    console.error(`[${key}] ERROR ${e.message}`);
  }
}
await writeFile("assets/templates/candidates.json", JSON.stringify(out, null, 2), "utf8");
console.error("done -> assets/templates/candidates.json");
