// node probe.mjs "<js body>"   or   node probe.mjs -f body.js
import { readFileSync } from "node:fs";
import { connect } from "./lib.mjs";
const args = process.argv.slice(2);
const body = args[0] === "-f" ? readFileSync(args[1], "utf8") : args.join(" ");
const c = await connect();
try {
  const v = await c.js(body, 300000);
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
} catch (e) {
  console.log("ERROR", e.message);
}
c.close();
process.exit(0);
