// Types shared between the main process and the renderer for the "Set up your phone" screen.
import type { PublicDevice } from './devices';
import type { RouteStatus } from './routes';

export interface RemoteState {
  enabled: boolean; running: boolean; port: number; pcName: string; fingerprint: string | null; error: string | null;
  manualHost: string;
  routes: Array<RouteStatus & { likely: boolean; inUse: boolean }>;
  devices: PublicDevice[];
  pairing: { active: boolean; expiresAt: number | null };
  pendingPair: { id: string; deviceName: string; code: string; expiresAt: number } | null;
  /** Other-networks access: vailable = the connectivity module exists; irewall = inbound rule for the bridge port. */
  otherNetworks: { available: boolean; firewall: 'allowed' | 'missing' | 'unknown' };
}
export interface AllowNetworksResult { ok: boolean; already?: boolean; denied?: boolean; error?: string; state: RemoteState }
export interface PairingCode { dataUrl: string; payload: string; expiresAt: number; hosts: string[] }
