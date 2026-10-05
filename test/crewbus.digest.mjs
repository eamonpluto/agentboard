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

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const template = read("AGENTS.template.md");
check(
  "template: digest-first polling line",
  template.includes("inbox --from <you> --unacked --digest") &&
    template.includes("--grep") &&
    template.includes("--priority")
);

const skill = read("claude-plugin/skills/crewbus/SKILL.md");
check(
  "skill: Poll cheap section",
  skill.includes("## Poll cheap") &&
    skill.includes("dm_inbox({ agent:") &&
    skill.includes("unacked") &&
    skill.includes("digest") &&
    skill.includes("grep") &&
    skill.includes("priority")
);

const delivery = read("docs/DELIVERY.md");
check(
  "delivery: Poll discipline (long runs) ladder",
  delivery.includes("## Poll discipline (long runs)") &&
    delivery.includes("inbox --from <you> --unacked --digest") &&
    delivery.includes("--grep") &&
    delivery.includes("--priority") &&
    delivery.includes("thread") &&
    delivery.includes("gather") &&
    delivery.includes("[checkpoint]") &&
    /push wakes you/i.test(delivery)
);

const mail = read("bin/lib/mail.js");
check(
  "mail: digest printer marks checkpoints (read-only)",
  mail.includes("printDigest") && mail.includes("[checkpoint]")
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall digest tests passed");
