import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ---- harness contract: 7 drivers, required fields ----
const harness = readJson("packages/contracts/harness.json");
check("harness: version 1 frozen", harness.version === 1);
const drivers = harness.drivers || [];
const got = drivers.map((d) => d.driver).sort();
check(
  "harness: all 7 drivers",
  JSON.stringify(got) === JSON.stringify(["antigravity", "claude", "codex", "cursor", "generic", "grok", "opencode"])
);
for (const d of drivers) {
  for (const f of ["driver", "displayName", "briefDelivery", "sessionCapture", "resume", "capabilities", "permissionMap", "spawnArgs", "resumeArgs"]) {
    check(`harness ${d.driver}: has ${f}`, d[f] !== undefined);
  }
  check(`harness ${d.driver}: brief enum`, ["file", "stdin", "inline"].includes(d.briefDelivery));
  check(`harness ${d.driver}: capture enum`, ["preassigned", "log", "none"].includes(d.sessionCapture));
  for (const p of ["supervised", "autoEdits", "auto", "full"]) {
    check(`harness ${d.driver}: permissionMap.${p}`, typeof (d.permissionMap || {})[p] === "string");
  }
  if (!d.resume) {
    check(`harness ${d.driver}: resume=false carries honest note`, typeof d.resumeNote === "string" && d.resumeNote.length > 0);
  }
}

// every COMPATIBILITY matrix row has a contract entry
const compat = read("docs/COMPATIBILITY.md");
for (const name of ["opencode", "claude", "codex", "antigravity", "grok", "cursor"]) {
  check(`compat row ${name} in contracts`, got.includes(name) && compat.includes(name));
}

// cross-check spawn sources of truth still agree with contract brief channels
const spawn = read("bin/lib/spawn.js");
check("spawn: claude stdin brief (contract stdin)", spawn.includes("stdinPath") && drivers.find((d) => d.driver === "claude").briefDelivery === "stdin");
check("spawn: opencode file brief (contract file)", drivers.find((d) => d.driver === "opencode").briefDelivery === "file");

// ---- launch contract ----
const launch = readJson("packages/contracts/launch.json");
check("launch: version 1 frozen", launch.version === 1);
check("launch: endpoint POST /api/launch", launch.endpoint === "POST /api/launch");
for (const f of ["harness", "body"]) check(`launch: required ${f}`, (launch.request.required || []).includes(f));
for (const f of ["count", "prefix", "permission", "target", "dryRun"]) check(`launch: optional ${f}`, (launch.request.optional || []).includes(f));
check("launch: body cap 8000", String(JSON.stringify(launch.request.constraints)).includes("8000"));
for (const p of ["supervised", "autoEdits", "auto", "full"]) {
  check(`launch: permissionMapping.${p}`, typeof (launch.request.permissionMapping || {})[p] === "string");
}
check("launch: full needs --i-understand-danger", launch.request.permissionMapping.full.includes("--i-understand-danger"));

// ---- pairing contract: fragment secret, narrow-only scopes ----
const pairing = readJson("packages/contracts/pairing.json");
check("pairing: version 1 frozen", pairing.version === 1);
check("pairing: url shape crewbus://pair with #secret", pairing.pairUrl.startsWith("crewbus://pair?") && pairing.pairUrl.includes("#"));
check("pairing: secret in fragment never query", !pairing.pairUrl.split("#")[0].includes("abp-") && pairing.pairUrl.split("#")[1].includes("abp-"));
check("pairing: rules forbid query secret", pairing.pairUrlRules.some((r) => r.includes("FRAGMENT")));
check("pairing: exchange narrow-only", JSON.stringify(pairing.endpoints.exchange).includes("narrow-only") || JSON.stringify(pairing).includes("narrow-only"));
for (const s of ["launch:spawn", "mail:send", "fleet:read", "admin:pair"]) {
  check(`pairing: scope ${s}`, (pairing.scopes || []).includes(s));
}
// local PAIRING.md agrees: relay-local, never synced/exported
const pairDoc = read("docs/PAIRING.md");
check("pairing doc: relay-local trust", pairDoc.includes("never synced") && pairDoc.includes("never"));

// ---- board caps: degrade wording, never 500 ----
const caps = readJson("packages/contracts/board-caps.json");
check("caps: version 1 frozen", caps.version === 1);
for (const c of ["hlc", "tombstones", "channels", "revoked", "holds", "standby"]) {
  check(`caps: relay cap ${c}`, (caps.relayCaps || []).includes(c));
}
check("caps: launch is control-plane cap", (caps.controlPlaneCaps || []).includes("launch"));
check("caps: launch degrade names CLI spawn fallback", String(caps.subCap.launch).includes("CLI spawn"));
const sync = read("bin/lib/sync.js");
check("caps: SUB_CAP_NOTE source still the downgrade voice", sync.includes("SUB_CAP_NOTE"));

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall control-plane contract tests passed");
