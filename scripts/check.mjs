import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
for (const name of readdirSync("public").filter(n => n.endsWith(".js"))) execFileSync(process.execPath, ["--check", `public/${name}`]);
for (const name of readdirSync("src").filter(n => n.endsWith(".ts"))) {
  const source = readFileSync(`src/${name}`, "utf8");
  assert(!/setInterval\s*\(|setTimeout\s*\(|Deno\.|\.watch\(/.test(source), `Persistent server timer or legacy storage in ${name}`);
}
assert(!/EventSource|sendBeacon|\/presence|\/state/.test(readFileSync("public/transport.js", "utf8")), "Legacy transport retained");
console.log("Browser syntax and no-persistent-server-loop checks passed");
