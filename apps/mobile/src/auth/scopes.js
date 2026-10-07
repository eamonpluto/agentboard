// CrewBus M5 mobile scope vocabulary — explicit array, Metro-safe.
// Our code performs NO JSON `with`-attribute import (Metro/Hermes choke on
// it); the M3 core applies this list via createAuthStore({ knownScopes }).
// Mirrors packages/contracts/pairing.json v1 (frozen-M0): keep in sync.
export const PAIRING_CONTRACT_VERSION = 1;

export const KNOWN_SCOPES = Object.freeze([
  'launch:spawn',
  'launch:kill',
  'mail:send',
  'mail:inbox',
  'mail:ack',
  'fleet:read',
  'admin:pair',
  'admin:revoke',
]);

// Working set the phone requests at exchange (narrow-only; admin scopes
// excluded — device revocation review happens on the desktop/relay).
export const DEFAULT_PAIR_SCOPES = Object.freeze([
  'launch:spawn',
  'launch:kill',
  'mail:send',
  'mail:inbox',
  'mail:ack',
  'fleet:read',
]);
