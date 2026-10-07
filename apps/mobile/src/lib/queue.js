// CrewBus M5 mobile explicit-retry worker (plain JS, checkable).
// The queue NEVER auto-replays: these run ONLY from the Queue screen's
// explicit "Retry queued (n)" button (or per-item Retry) via cache.retryAll().
// Launch ops are intentionally unsupported here — a live launch needs its
// own explicit confirm on the Launch screen, never a background replay.
export function describeOp(op) {
  if (!op || typeof op !== 'object') return 'unknown mutation';
  switch (op.kind) {
    case 'ack': return `ack ${op.all ? 'all' : op.id} as ${op.from}`;
    case 'approve': return `${op.decision} ${op.id} as ${op.from}`;
    case 'kill': return `kill ${op.all ? 'all workers' : (op.to || []).join(', ')} as ${op.from}`;
    default: return `unknown mutation (${String(op.kind)})`;
  }
}

export function createQueueWorker({ apiFor, connection }) {
  const currentApi = () => {
    const route = connection && connection.getState ? connection.getState().route : null;
    if (!route) throw new Error('no connected route — pick a route on Boards first');
    return apiFor(route);
  };
  return async function worker(op) {
    const api = currentApi();
    if (!op || typeof op !== 'object') throw new Error('bad queued op');
    switch (op.kind) {
      case 'ack': return api.ack({ from: op.from, agentToken: op.agentToken, id: op.id, all: !!op.all });
      case 'approve': return api.approve({ from: op.from, agentToken: op.agentToken, id: op.id, decision: op.decision, reason: op.reason || '' });
      case 'kill': return api.kill({ from: op.from, agentToken: op.agentToken, to: op.to, all: !!op.all });
      default: throw new Error(`queue refuses to replay op kind: ${String(op && op.kind)}`);
    }
  };
}
