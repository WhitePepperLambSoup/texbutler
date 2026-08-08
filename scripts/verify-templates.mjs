// Verify every built-in template in assets/templates/: structure check
// (a .tex with \documentclass exists) + real compile with the system
// TeX Live (xelatex) in a temp copy. Usage: node scripts/verify-templates.mjs
import { readdir, readFile, cp, rm, mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const TPL_DIR = "assets/templates";
const IGNORE = new Set(["templates.json", "candidates.json"]);

function findRootTex(dir, files) {
  // prefer files whose content declares \documentclass; among those,
  // main.tex / thesis.tex naming wins
  const withClass = files.filter((f) => {
    try {
      return readFileSync(join(dir, f), "utf8").includes("\\documentclass");
    } catch (e) {
      console.error(`  read error ${f}: ${e.message}`);
      return false;
    }
  });
  if (withClass.length === 0) return null;
  for (const pref of ["main.tex", "thesis.tex", "thesis_main.tex", "sample.tex", "demo.tex", "report.tex", "book.tex"]) {
    const hit = withClass.find((f) => f.toLowerCase().endsWith("/" + pref) || f === pref);
    if (hit) return hit;
  }
  return withClass[0];
}

function compile(dir, mainFile, timeoutMs = 120000) {
  return new Promise((resolve) => {
    // honor the template's magic comment: `% !TeX program = pdflatex`
    let engine = "xelatex";
    try {
      const head = readFileSync(join(dir, mainFile), "utf8").slice(0, 800);
      const m = head.match(/!TeX program\s*=\s*([a-z]+)/i);
      if (m && ["pdflatex", "xelatex", "lualatex", "latex"].includes(m[1].toLowerCase())) {
        engine = m[1].toLowerCase();
      }
    } catch {
      /* keep xelatex */
    }
    const args = ["-interaction=nonstopmode", "-halt-on-error", "-output-directory=build", mainFile];
    const child = spawn(engine, args, { cwd: dir, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, reason: "timeout: " + out.split("\n").filter(Boolean).slice(-3).join(" | ") });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const pdfOk = out.includes("Output written");
      const reason = code === 0 || pdfOk
        ? "ok"
        : out.split("\n").filter(Boolean).slice(-4).join(" | ");
      resolve({ ok: code === 0 || pdfOk, reason });
    });
  });
}

async function main() {
  const entries = (await readdir(TPL_DIR, { withFileTypes: true })).filter(
    (e) => e.isDirectory() && !IGNORE.has(e.name)
  );
  console.log(`Verifying ${entries.length} built-in templates...`);
  const results = [];
  for (const e of entries) {
    const dir = join(TPL_DIR, e.name);
    const all = [];
    const walk = async (d, rel) => {
      for (const f of await readdir(join(dir, d), { withFileTypes: true })) {
        if (f.name.startsWith(".")) continue;
        const p = rel ? `${rel}/${f.name}` : f.name;
        if (f.isDirectory()) await walk(p, p);
        else all.push(p);
      }
    };
    await walk("", "");
    const tex = all.filter((f) => f.endsWith(".tex"));
    const root = findRootTex(dir, tex);
    const hasDocClass = tex.some((f) => {
      try {
        return readFile(join(dir, f), "utf8").then((s) => s.includes("\\documentclass"));
      } catch {
        return false;
      }
    });
    if (!root || !hasDocClass) {
      results.push({ tpl: e.name, structure: "FAIL", compile: "n/a", root: root ?? "none" });
      console.log(`[FAIL-structure] ${e.name} (root=${root ?? "none"})`);
      continue;
    }
    // compile in a temp copy so the template dir stays clean
    const tmp = await mkdtemp(join(tmpdir(), "tb-tpl-"));
    await cp(dir, tmp, { recursive: true });
    await rm(join(tmp, "build"), { recursive: true, force: true }).catch(() => {});
    const res = await compile(tmp, root);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    results.push({ tpl: e.name, structure: "ok", compile: res.ok ? "PASS" : "FAIL", reason: res.reason ?? "", root });
    if (res.ok) {
      console.log(`[PASS] ${e.name} (${root})`);
    } else {
      let errs = "";
      try {
        const log = await readFile(join(tmp, "build", "main.log"), "utf8");
        errs = log.split("\n").filter((l) => l.startsWith("!")).slice(0, 3).join(" | ");
      } catch {
        /* no log */
      }
      console.log(`[FAIL] ${e.name} (${root}) ${errs || res.reason || "unknown"}`);
    }
  }
  const pass = results.filter((r) => r.structure === "ok" && r.compile === "PASS").length;
  const fail = results.filter((r) => r.structure === "FAIL" || r.compile === "FAIL").length;
  console.log(`\nSUMMARY: ${pass} pass, ${fail} fail (of ${results.length})`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error("VERIFY-FAIL", e); process.exit(1); });
