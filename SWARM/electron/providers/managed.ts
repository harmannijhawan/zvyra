import { managedRequest } from '../account/sync';
import type { ProviderAdapter } from './types';
export const managed: ProviderAdapter = {
  id: 'managed', name: 'SWARM account AI', kind: 'cloud', requiresKey: false, needsAccountId: false,
  defaultBaseUrl: '', signupUrl: '', freeNotes: 'Uses your configured account provider keys and SWARM allowance. Provider billing is separate.', publicDiscovery: true,
  async discover(_config, signal) {
    const response = await managedRequest('models', undefined, signal);
    return response.models.map((m: any) => ({ modelId: m.id, displayName: m.displayName, capabilities: m.capabilities || ['chat','coding'], contextLength: m.contextLength, maxOutput: 4096, freeStatus: 'free_tier' }));
  },
  async chat() { throw new Error('Use the SWARM managed request router.'); },
};
