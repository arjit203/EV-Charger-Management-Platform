/**
 * Charger connection tokens.
 *
 * A charger authenticates to the OCPP gateway with a per-charger secret, sent as HTTP Basic
 * auth on the WebSocket upgrade — which is how real OCPP 1.6J charge points typically
 * authenticate. (OCPP 2.0.1 moves to mutual TLS with client certificates; we do not build
 * that.)
 *
 * The token is stored HASHED, exactly like a user password, so a database dump yields no
 * working charger credentials. The consequence is that it can be shown only once, at creation
 * or regeneration — the same model as an API key.
 *
 * Why this exists at all: `ocppId` is a CLAIM, not a credential. Without a secret, anything
 * that can open a WebSocket could connect as any registered charger and report false status
 * or accept commands meant for real hardware.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';

import { env } from '../config/env';

/** 32 random bytes as URL-safe base64 — long enough that guessing is hopeless. */
export function generateChargerToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashChargerToken(token: string): Promise<string> {
  return bcrypt.hash(token, env.bcryptSaltRounds);
}

/** Constant-time comparison via bcrypt. Returns false for a charger with no token set. */
export async function verifyChargerToken(token: string, hash?: string | null): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(token, hash);
}
