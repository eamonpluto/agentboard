import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpawnPrompt, buildRespawnBrief } from "../bin/lib/spawn.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// --- buildSpawnPrompt carries the blocked-approval step ---
const prompt = buildSpawnPrompt({
  name: "w",
  from: "lead",
  body: "b",
  replyId: "msg-1",
  cwd: "/tmp",
  root: "/tmp/.crewbus",
});

check("spawn prompt: approval subject line", prompt.includes('subject "approval:'));
check("spawn prompt: high priority ask", prompt.includes("send --priority high"));
check("spawn prompt: threaded on brief id", prompt.includes("--reply msg-1"));
check("spawn prompt: body keys", ["command:", "cwd:", "why:", "tried-instead:"].every((k) => prompt.includes(k)));
check("spawn prompt: listen 300s fail-closed", prompt.includes("listen --timeout 300000") && prompt.includes("300s") && prompt.includes("fail-closed"));
check("spawn prompt: verdict outcomes", prompt.includes("approved") && prompt.includes("denied"));
check("spawn prompt: lead-only verdicts", prompt.includes("only from lead"));
check("spawn prompt: secrets never approvable", prompt.includes("never approvable"));

// --- buildRespawnBrief points at the same protocol ---
const brief = buildRespawnBrief({
  name: "w",
  attempt: 2,
  origPromptPath: "/l/w.prompt.md",
  briefId: "msg-1",
  harnessSessionId: "SID",
  harness: "claude",
  lead: "boss",
});

check("respawn brief: points at approval protocol", brief.includes("approval:") && brief.includes("300000"));

// --- docs/APPROVALS.md carries the normatives ---
const doc = fs.readFileSync(path.join(HERE, "..", "docs", "APPROVALS.md"), "utf8");
const docLow = doc.toLowerCase();

check("docs: request subject schema", doc.includes("approval: <short action>"));
check("docs: body keys", ["command:", "cwd:", "why:", "tried-instead:"].every((k) => doc.includes(k)));
check("docs: 300s fail-closed default", doc.includes("300s") && doc.includes("fail-closed") && doc.includes("300000"));
check("docs: 500-char reason cap", doc.includes("500 chars"));
check("docs: context modes", ["oneshot", "headless", "default-deny", "persistent", "may-ask"].every((k) => docLow.includes(k)));
check("docs: sender authentication", doc.includes("ONLY from the lead"));
check("docs: non-approvables", doc.includes("secrets") && doc.includes("exfiltration") && doc.includes("isolation escape"));
check("docs: mining-ready note", doc.includes("approvals suggest"));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\napproval-protocol: all green");
