// Add the four new lightweight built-in templates to templates.json.
import { readFile, writeFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile("assets/templates/templates.json", "utf8"));
const ids = new Set(catalog.templates.map((t) => t.id));
const add = [
  { id: "ctexrep", name: "中文报告 ctexrep", category: "通用", repo: "", desc: "中文报告模板（ctexrep，内置）", stars: 0, size_kb: 1, mode: "builtin", builtin: true },
  { id: "ctexbook", name: "中文书籍 ctexbook", category: "通用", repo: "", desc: "中文书籍模板（ctexbook，内置）", stars: 0, size_kb: 1, mode: "builtin", builtin: true },
  { id: "letter", name: "英文信件 letter", category: "通用", repo: "", desc: "信件模板（letter，内置）", stars: 0, size_kb: 1, mode: "builtin", builtin: true },
  { id: "poster", name: "学术海报 poster", category: "通用", repo: "", desc: "学术海报模板（beamer 幻灯片式，内置）", stars: 0, size_kb: 1, mode: "builtin", builtin: true },
];
for (const t of add) {
  if (!ids.has(t.id)) catalog.templates.push(t);
}
await writeFile("assets/templates/templates.json", JSON.stringify(catalog, null, 2), "utf8");
console.log(`catalog now ${catalog.templates.length}`);
