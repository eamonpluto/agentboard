// CrewBus M5 mobile view-model builders: pure functions, no I/O.
// Screens render these; all shaping/sorting/filtering lives here so it is
// unit-testable without network. Inputs mirror the web JSON shapes:
//   inbox item: { id, from, at, subject, head, replyTo, batch, artifact, acked }
//   worker row: boardSnapshot workerStatus { name, known, pid, alive, reply,
//               acked, driver, spawnedHarness, ... }
//   launch plan: packages/contracts/launch.json request fields.

const APPROVAL_PREFIX = /^approval:\s*/i;
const DIGEST_SUBJECT = /^\s*digest\b/i;
const DIGEST_MARK = /\[checkpoint\]|digest/i;

function isDigestLike(item) {
  const subject = String(item?.subject || "");
  const head = String(item?.head || item?.body || "");
  return DIGEST_SUBJECT.test(subject) || DIGEST_MARK.test(subject) || DIGEST_MARK.test(head);
}

function timeOf(item) {
  const t = Date.parse(item?.at || "");
  return Number.isFinite(t) ? t : 0;
}

// Triage queue: digest/checkpoint summaries first (they unblock the rest),
// then oldest-first. Also returns a per-sender grouping note so the screen
// can render a "3 senders: worker (2), lead (1)" header.
export function triageCards(items) {
  const list = Array.isArray(items) ? items : [];
  const cards = list.map((m) => ({
    id: m?.id,
    from: m?.from || "",
    at: m?.at || "",
    subject: m?.subject || "",
    head: String(m?.head ?? m?.body ?? "").slice(0, 160),
    replyTo: m?.replyTo || "",
    batch: m?.batch || "",
    artifact: m?.artifact || "",
    acked: !!m?.acked,
    digest: isDigestLike(m || {}),
  }));
  cards.sort((a, b) => {
    if (a.digest !== b.digest) return a.digest ? -1 : 1;
    return timeOf(a) - timeOf(b);
  });
  const senders = {};
  for (const c of cards) senders[c.from || "?"] = (senders[c.from || "?"] || 0) + 1;
  const parts = Object.entries(senders).map(([s, n]) => `${s} (${n})`);
  const note = cards.length === 0
    ? "inbox empty — nothing needs triage"
    : `${cards.length} unacked from ${parts.length} sender${parts.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
  return { cards, senders, note, total: cards.length };
}

// Approval requests only: subject starts with "approval:" (the request
// schema per docs/APPROVALS + the spawn prompt). Verdict replies
// ("approved…"/"denied…") are DMs without that subject and are excluded.
export function approvalCards(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .filter((m) => APPROVAL_PREFIX.test(String(m?.subject || "")))
    .map((m) => ({
      id: m?.id,
      from: m?.from || "",
      at: m?.at || "",
      subject: String(m.subject),
      request: String(m.subject).replace(APPROVAL_PREFIX, "").trim(),
      detail: String(m?.head ?? m?.body ?? ""),
      replyTo: m?.replyTo || "",
      acked: !!m?.acked,
    }));
}

// Worker rows for the Crews screen. State labels mirror the dashboard's
// stateOf() (bin/lib/web.js renderBoardHtml): unknown / done·acked /
// done·reply-waiting / running / exited·no-reply / no-pid.
// killable is true only for a live pid (the kill button's enable rule).
export function workerStateOf(w) {
  if (!w?.known) return "unknown";
  if (w.reply) return w.acked ? "done · acked" : "done · reply waiting";
  if (w.alive === true) return "running";
  if (w.alive === false) return "exited · no reply";
  return "no pid";
}

export function workerCards(workers) {
  const list = Array.isArray(workers) ? workers : [];
  return list.map((w) => ({
    name: w?.name || "",
    state: workerStateOf(w || {}),
    pid: typeof w?.pid === "number" ? w.pid : null,
    driver: w?.driver || w?.spawnedHarness || null,
    killable: w?.alive === true && typeof w?.pid === "number",
    replyPending: !!w?.reply && !w?.acked,
    spawnedBy: w?.spawnedBy || null,
  }));
}

// Dry-run summary for the launch confirmation sheet: how many commands the
// server will preview (/api/launch dryRun answers one command per worker
// name). `to` names win over `count` (server rule); prefix defaults to "w".
export function launchPreview(plan) {
  const p = plan && typeof plan === "object" ? plan : {};
  const harness = String(p.harness || "").trim().toLowerCase() || "(pick a harness)";
  const permission = p.permission || "supervised";
  const dryRun = p.dryRun !== false;
  const toNames = String(p.to || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const count = toNames.length > 0
    ? toNames.length
    : Number.isInteger(Number(p.count)) && Number(p.count) > 0 ? Number(p.count) : 1;
  const prefix = String(p.prefix || "w").trim() || "w";
  const names = toNames.length > 0
    ? toNames
    : Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
  const warnings = [];
  if (toNames.length > 0 && p.count !== undefined) warnings.push("both to and count given; to names win");
  if (count > 20) warnings.push(`count ${count} exceeds MAX_SPAWN 20 — confirm compute budget`);
  if (permission === "auto" || permission === "full") warnings.push(`permission ${permission} runs unattended — prefer an isolated runner`);
  const summary = `${harness} × ${names.length} (${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""}) [${dryRun ? "dry-run" : "LIVE"} · ${permission}]`;
  return { harness, count: names.length, names, permission, dryRun, warnings, summary };
}
