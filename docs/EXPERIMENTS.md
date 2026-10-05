# Experiments: does the peer-to-peer part matter?

Goal: test whether crewbus's peer-to-peer messaging (vs a simple
orchestrator or native subagents) changes outcomes — using public models,
cheap tasks, and published negative results.

## Tasks (cheap, objective verifiers only)

1. **Constraint puzzles** — e.g. small SAT/scheduling instances with a
   script checker. Verifier: the checker script, exit 0/1.
2. **Small formal proofs** — toy theorems with a machine-checkable proof
   (Lean or a purpose-built checker). Verifier: the checker.
3. **TDD code tasks** — a failing test suite ships with the task; the agent
   edit must turn it green without breaking the rest. Verifier: the suite.
4. **One cross-dependency task** — lateral messaging should help here if it
   helps anywhere: subproblems with discovered couplings (e.g. part A's
   interface choice constrains part B), where workers must negotiate the
   seam. Verifier: joint test suite + seam contract check.

Every task must state its verifier command up front. No verifier, no
experiment. Suggested: `ack --verify "<command>"`-style hooks so acceptance
can be automatic (see review §4.2).

## Conditions (ablate the structure)

- single agent (baseline)
- native subagents of one harness (vendor baseline)
- orchestrator script (fan-out, collect, no lateral mail)
- crewbus DMs only
- DMs plus shared channel (`channel post` / `tail`)
- plus consolidator (a reference reducer worker summarizing group findings)

## Scaling curves

Group sizes 1 / 4 / 16 / 64 / 256 against: success rate, wall-clock time,
and cost (tokens + compute). Repeat every cell — agent runs are noisy, so
report means with spread, never single runs.

## Message audit rubric

Sample messages from each run and classify each as:

- **useful** — changed a decision, carried a result, prevented rework;
- **redundant** — restated known state, duplicate, noise;
- **harmful** — wrong direction, stale pointer acted on, prompt-injected.

Report the mix per condition: a win on success rate with 80% redundant
traffic is a different finding than a lean win.

## Reporting policy (negative results required)

Publish negative results. If P2P does not beat a simple orchestrator, say
so — the project keeps a defensible smaller claim (best cross-harness
messaging layer) and the field learns something. File every run as:
task + verifier + condition + group size + repeats + success/time/cost +
message-audit sample, with hardware and model versions pinned.
