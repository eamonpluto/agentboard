import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tokenFilePath, saveTokenFile, loadTokenFile } from "../bin/lib/tokenfile.js";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// tmp board dir (root = the .crewbus dir itself)
const board = fs.mkdtempSync(path.join(os.tmpdir(), "cb-tokenfile-"));

// save/load roundtrip
const p = saveTokenFile(board, "alice", "abt-abc123");
check("save returns logs path", p === path.join(board, "logs", "alice.token"));
check("tokenFilePath matches save", tokenFilePath(board, "alice") === p);
check("file exists with trailing newline", fs.existsSync(p) && fs.readFileSync(p, "utf8") === "abt-abc123\n");
check("load roundtrips", loadTokenFile(board, "alice") === "abt-abc123");

// missing file -> null
check("missing file -> null", loadTokenFile(board, "ghost") === null);

// name sanitization (lowercase, [^a-z0-9_.-] -> -, max 40)
check("sanitize Alice! -> alice-", tokenFilePath(board, "Alice!") === path.join(board, "logs", "alice-.token"));
saveTokenFile(board, "Alice!", "abt-x");
check("sanitized save/load roundtrip", loadTokenFile(board, "alice-") === "abt-x" && loadTokenFile(board, "Alice!") === "abt-x");
check("long name truncated to 40", path.basename(tokenFilePath(board, "a".repeat(50))) === `${"a".repeat(40)}.token`);

// load trims surrounding whitespace
fs.writeFileSync(path.join(board, "logs", "spaced.token"), "  abt-sp \n");
check("load trims", loadTokenFile(board, "spaced") === "abt-sp");

// chmod 0600 best-effort (POSIX check only; Windows ACLs differ)
if (process.platform !== "win32") {
  check("file mode 0600", (fs.statSync(p).mode & 0o777) === 0o600);
} else {
  check("file created (windows skips mode check)", fs.existsSync(p));
}

// cleanup: Windows holds file handles briefly — retry rm
for (let i = 0; i < 10; i++) {
  try {
    fs.rmSync(board, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

if (failures) process.exit(1);
console.log("tokenfile: all green");
