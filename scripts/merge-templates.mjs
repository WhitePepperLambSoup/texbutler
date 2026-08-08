// Merge high-quality candidates into templates.json (dedupe by repo, cap
// per category, mark verified:"unknown" — download-time structure checks
// promote them to "ok").
import { readFile, writeFile } from "node:fs/promises";

const candidates = JSON.parse(await readFile("assets/templates/candidates.json", "utf8"));
const catalog = JSON.parse(await readFile("assets/templates/templates.json", "utf8"));
const existing = new Set(catalog.templates.map((t) => t.repo));
const ids = new Set(catalog.templates.map((t) => t.id));

// category inference per query key
const CAT = {
  "thesis-cn": "985", "thesis-cn-2": "985", buaa: "985", hit: "985", nwpu: "985",
  seu: "985", tju: "985", hust2: "985", hnu: "985", csu: "985", cqu: "985",
  neu: "985", uestc: "985", nankai: "985", bnuj: "985", ruc: "985", buaa2: "985",
  harbin: "985", njust: "211", nuaa: "211", bit: "985", ecnu: "985", scut: "985",
  lzu: "985", cau: "985", muc: "985", ouc: "985", nwafu: "985", hdu: "双一流",
  gzhu: "双一流", ouc2: "985",
  "cambridge-thesis": "海外QS100", "oxford-thesis": "海外QS100", "mit-thesis": "海外QS100",
  "stanford-thesis": "海外QS100", "berkeley-thesis": "海外QS100", "harvard-thesis": "海外QS100",
  "princeton-thesis": "海外QS100", "caltech-thesis": "海外QS100", "eth-thesis": "海外QS100",
  "imperial-thesis": "海外QS100", "ucl-thesis": "海外QS100", "edinburgh-thesis": "海外QS100",
  "manchester-thesis": "海外QS100", "toronto-thesis": "海外QS100", "mcgill-thesis": "海外QS100",
  "ubc-thesis": "海外QS100", "melbourne-thesis": "海外QS100", "sydney-thesis": "海外QS100",
  "unsw-thesis": "海外QS100", "nus-thesis": "海外QS100", "ntu-thesis": "海外QS100",
  "hku-thesis": "海外QS100", "cuhk-thesis": "海外QS100", "hkust-thesis": "海外QS100",
  "kaist-thesis": "海外QS100", "kth-thesis": "海外QS100", "tudelft-thesis": "海外QS100",
  "tum-thesis": "海外QS100", "paris-thesis": "海外QS100", "epfl-thesis": "海外QS100",
  "cambridge2": "海外QS100",
  "ieee-paper": "期刊", "acm-paper": "期刊", "nature-paper": "期刊",
  "elsevier-paper": "期刊", "prl-paper": "期刊",
  "beamer-theme": "幻灯片", "beamer-tsinghua": "幻灯片", poster: "海报",
  cv: "简历", "awesome-cv": "简历", letter: "信件", "report-cn": "报告", coursework: "课程作业",
};

function slug(repo) {
  // derive a stable id from the repo path: owner-name truncated
  const base = repo.split("/").pop().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return base.slice(0, 40);
}

const picks = [];
for (const [key, list] of Object.entries(candidates)) {
  const cat = CAT[key] ?? "通用";
  for (const it of list) {
    if (existing.has(it.repo)) continue;
    if (it.stars < 8) continue; // quality bar: reasonably known repos
    const id = slug(it.repo);
    if (ids.has(id)) continue;
    ids.add(id);
    picks.push({
      id,
      name: it.desc?.slice(0, 40) || id,
      category: cat,
      repo: it.repo,
      desc: (it.desc || "").slice(0, 100),
      stars: it.stars,
      size_kb: it.size_kb,
      mode: "remote",
      builtin: false,
      verified: "unknown",
    });
  }
}

// per-category cap so the catalog stays browsable (thesis-heavy already)
const caps = { "985": 60, "211": 20, "双一流": 25, "科研院所": 10, "海外QS100": 45, "期刊": 10, "幻灯片": 5, "海报": 3, "简历": 3, "信件": 3, "报告": 3, "课程作业": 3, "通用": 5 };
const byCat = {};
for (const p of picks) {
  (byCat[p.category] ??= []).push(p);
}
const finalPicks = [];
for (const [cat, list] of Object.entries(byCat)) {
  list.sort((a, b) => b.stars - a.stars);
  finalPicks.push(...list.slice(0, caps[cat] ?? 5));
}

catalog.templates.push(...finalPicks);
await writeFile("assets/templates/templates.json", JSON.stringify(catalog, null, 2), "utf8");
console.log(`added ${finalPicks.length} templates (catalog now ${catalog.templates.length})`);
for (const [cat, list] of Object.entries(byCat)) {
  console.log(`  ${cat}: +${list.slice(0, caps[cat] ?? 5).length}`);
}
