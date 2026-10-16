// Virtual module resolved by scripts/build-main.mjs to electron/remote/connectivity/index.ts when that file exists,
// otherwise to an empty stub. Keeps the bridge building whether or not the connectivity module is present.
declare module 'swarm-remote-connectivity' {
  export function getCandidateEndpoints(port?: number): Promise<string[]>;
  export function start(ctx: { port?: number; fingerprint?: string; pcName?: string }): Promise<void> | void;
  export function stop(): Promise<void> | void;
  export function getConnectivityStatus(): unknown;
  export function ensureFirewallRuleElevated(port: number): Promise<{ ok: boolean; already?: boolean; denied?: boolean; error?: string }>;
  export function removeFirewallRuleElevated(port: number): Promise<{ ok: boolean; already?: boolean; denied?: boolean; error?: string }>;
}