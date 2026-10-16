// One-time pairing tokens: 32 random bytes, 120 s TTL, single use, 5 failed attempts max.
import { PAIR_MAX_FAILED, PAIR_TOKEN_TTL_MS, randomB64Url, safeEqual } from './protocol';

interface Active { token: string; expiresAt: number; failed: number }

export class PairingManager {
  private active: Active | null = null;
  constructor(private now: () => number = Date.now, private ttlMs = PAIR_TOKEN_TTL_MS, private maxFailed = PAIR_MAX_FAILED) {}

  /** Creates a new token; any previous outstanding token is invalidated. */
  generate(): { token: string; expiresAt: number } {
    const token = randomB64Url(32);
    this.active = { token, expiresAt: this.now() + this.ttlMs, failed: 0 };
    return { token, expiresAt: this.active.expiresAt };
  }

  /** Current token state for the UI (never returns the token itself). */
  status(): { active: boolean; expiresAt: number | null } {
    if (this.active && this.now() >= this.active.expiresAt) this.active = null;
    return { active: !!this.active, expiresAt: this.active?.expiresAt ?? null };
  }

  /**
   * Validates and consumes a token. Success invalidates it (single use).
   * A wrong guess counts against the active token; after maxFailed wrong guesses it is invalidated.
   */
  consume(candidate: unknown): boolean {
    const a = this.active;
    if (!a) return false;
    if (this.now() >= a.expiresAt) { this.active = null; return false; }
    const ok = typeof candidate === 'string' && candidate.length <= 128 && safeEqual(candidate, a.token);
    if (ok) { this.active = null; return true; }
    a.failed++;
    if (a.failed >= this.maxFailed) this.active = null;
    return false;
  }

  cancel() { this.active = null; }
}