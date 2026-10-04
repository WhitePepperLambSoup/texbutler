// Visual check: screenshots of the main surfaces in every theme.
// node scripts/e2e/shots.mjs [theme ...]
import { connect, sleep } from "./lib.mjs";
import { makeFixture, PROJ_FWD } from "./fixture.mjs";

const themes = process.argv.slice(2).length ? process.argv.slice(2) : ["light", "dark", "liquid"];
const c = await connect();
const { js, waitFor, shot } = c;

await waitFor("return !!window.__tb", { timeout: 60000 });
await makeFixture();
await js("if (T.project.getState().root) await T.project.getState().closeProject(); return true");
for (const theme of themes) {
  await js(`T.ui.getState().setTheme('${theme}'); return true`);
  await sleep(300);
  console.log(await shot(`welcome-${theme}`));
}
await js(`await T.project.getState().openProject(${JSON.stringify(PROJ_FWD)}); return true`);
await js("await T.project.getState().openFile('main.tex'); return true");
await js("await T.compile.getState().compile(); return true");
await waitFor("return !T.compile.getState().running", { timeout: 120000 });
await waitFor("return document.querySelectorAll('.pdf-canvas').length > 0", { timeout: 30000 }).catch(() => null);
for (const theme of themes) {
  await js(`T.ui.getState().setTheme('${theme}'); return true`);
  await sleep(500);
  console.log(await shot(`workbench-${theme}`));
  await js("T.ui.getState().openModal({ kind: 'settings', section: 'general' }); return true");
  await sleep(400);
  console.log(await shot(`settings-${theme}`));
  await js("T.ui.getState().closeModal(); return true");
  await sleep(200);
}
c.close();
process.exit(0);
