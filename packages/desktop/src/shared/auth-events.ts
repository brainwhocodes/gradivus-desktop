/**
 * Sentinel provider id carried on `AuthEvent` error events when provider
 * discovery itself failed. Normal auth errors name a specific provider; this
 * value means no provider list is known at all, so sign-in must not be offered.
 */
export const AUTH_DISCOVERY_PROVIDER = "";
