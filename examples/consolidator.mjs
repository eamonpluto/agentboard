#!/usr/bin/env node
/**
 * consolidator.mjs — reference cross-group consolidator worker (§4.2.4).
 *
 * Reads one gather batch (briefs + all replies), writes an extractive
 * summary, and hands it to the lead: threaded DM reply + post to the
 * group's channel. Zero dependencies, Node 18+.
 *
 * Usage:
 *   node examples/consolidator.mjs --from gateway --to lead \
 *     --batch batch-261002-180609-ff1df6ae [--group team] [--board <path>]
 *
 * The lead hands this summary to the next group (group A's findings
 * seed group B's brief).
 * Auth via --token or CREWBUS_TOKEN, same as the CLI.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "crewbus.js");

function arg(flag, def = undefined) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
}
function fail(msg) {
  process.stderr.write(`consolidator: ${msg}\n`);
  process.exit(1);
}

const from = arg("--from") || process.env.CREWBUS_AGENT;
const to = arg("--to");
const batch = arg("--batch");
const group = arg("--group");
const board = arg("--board") || process.env.CREWBUS_DIR;
if (!from) fail("missing --from <worker-name>");
if (!to) fail("missing --to <lead-name>");
if (!batch) fail("missing --batch <batch-id> (from the send echo)");

const run = (args) =>
  execFileSync("node", [CLI, ...args, ...(board ? ["--board", board] : [])], { encoding: "utf8" });
// First send as a new name mints its token (printed once). Harvest it so
// follow-up calls as the same name authenticate.
let selfToken = process.env.CREWBUS_TOKEN;
const harvest = (echo) => {
  const m = String(echo || "").match(/token (abt-[0-9a-f]+)/);
  if (m) selfToken = m[1];
};
const runAsSelf = (args) =>
  execFileSync(
    "node",
    [CLI, ...args, ...(selfToken ? ["--token", selfToken] : []), ...(board ? ["--board", board] : [])],
    { encoding: "utf8" }
  );

let raw;
try {
  raw = JSON.parse(run(["gather", "--batch", batch, "--json"]));
} catch (e) {
  fail(`gather failed: ${(e && e.message) || e}`);
}
// gather --json is {briefs, replies, items:[...]} (older builds: bare array).
const items = Array.isArray(raw) ? raw : raw && raw.items;
if (!Array.isArray(items) || items.length === 0) fail(`no messages for batch ${batch}`);

const briefs = items.filter((m) => !m.replyTo && (m.batch === batch || m.id === batch || !m.replyTo));
const replies = items.filter((m) => m.replyTo);
// A gather transcript mixes the brief(s) with everything answering them:
// anything that is not itself a reply counts as a brief here.
const briefIds = new Set(briefs.map((m) => m.id));
const orphanReplies = replies.filter((m) => !briefIds.has(m.replyTo));
const allBriefs = [...briefs, ...orphanReplies.filter(() => false)]; // keep simple: briefs as listed

// Extractive digest: first line of each reply + per-sender counts.
const bySender = {};
for (const r of replies) {
  bySender[r.from] = bySender[r.from] || [];
  const firstLine = String(r.body || "").split("\n")[0].slice(0, 200);
  bySender[r.from].push({ id: r.id, line: firstLine, artifact: r.artifact || null });
}

const lines = [];
lines.push(`CONSOLIDATED RESULT for batch ${batch}`);
lines.push(`briefs: ${allBriefs.length}, replies: ${replies.length}`);
for (const b of allBriefs.slice(0, 5)) {
  lines.push(`- brief ${b.id} [${b.from}]: ${String(b.subject || b.body || "").split("\n")[0].slice(0, 160)}`);
}
for (const [sender, posts] of Object.entries(bySender)) {
  lines.push(`- ${sender} (${posts.length} repl${posts.length === 1 ? "y" : "ies"}):`);
  for (const p of posts.slice(0, 10)) {
    lines.push(`    ${p.id}: ${p.line}${p.artifact ? ` [artifact: ${p.artifact}]` : ""}`);
  }
}
if (group) lines.push(`contributing group: ${group}`);
const summary = lines.join("\n");

// Thread the summary back to the lead as a reply to the first brief.
const replyTo = allBriefs.length > 0 ? allBriefs[0].id : undefined;
const sendArgs = ["send", "--from", from, "--to", to, "--subject", `RESULT: ${batch}`, "--body", summary];
if (replyTo) sendArgs.push("--reply", replyTo);
const echo = runAsSelf(sendArgs);
harvest(echo);
process.stdout.write(echo);

// Also append to the group channel so late joiners / sibling groups see it.
if (group) {
  try {
    const out = runAsSelf(["channel", "post", `grp-${group}`, "--from", from, "--subject", `RESULT: ${batch}`, "--body", summary]);
    process.stdout.write(out);
  } catch (e) {
    // channel post creates grp-<group> on first use — failures here are
    // auth/board problems, non-fatal to the handoff above.
    process.stderr.write(`consolidator: channel post skipped: ${(e && e.message || e).split("\n")[0]}\n`);
  }
}
