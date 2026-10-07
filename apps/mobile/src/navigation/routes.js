// CrewBus M5 mobile route names — single source of truth for the stack
// navigator (plain JS, checkable). Mirrors the IA in CONTROL_PLANE_SPEC §5.
export const ROUTES = Object.freeze({
  Pair: 'Pair',
  Boards: 'Boards',
  Triage: 'Triage',
  Approvals: 'Approvals',
  Launch: 'Launch',
  Fleet: 'Fleet',
  Queue: 'Queue',
  Settings: 'Settings',
});

export const INITIAL_ROUTE = ROUTES.Pair;

export const ROUTE_TITLES = Object.freeze({
  Pair: 'Pair a device',
  Boards: 'Boards',
  Triage: 'Triage',
  Approvals: 'Approvals',
  Launch: 'Launch',
  Fleet: 'Workers / Fleet',
  Queue: 'Queued mutations',
  Settings: 'Settings',
});
