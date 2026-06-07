/**
 * Confluence space-validation port — 1:1 port of the `ConfluenceValidatorPort` Protocol +
 * `ConfluenceValidationResult` in `vendor/codemaster-py/codemaster/api/admin/integrations.py:159-176`.
 *
 * When an operator registers a Confluence space via POST /api/admin/integrations/confluence-spaces, the
 * admin pod validates the service account can actually reach the space BEFORE persisting a row — an
 * unreachable space cannot create an integration. This module defines the PORT only (the injectable seam);
 * the REAL adapter over the Confluence v2 client is wired at the composition root (the route consumes a
 * {@link GetConfluenceValidator} factory from `AdminRoutesOptions`), exactly like the preflight-validator
 * port. Tests inject a stub. Per the live-untested Confluence surface, the real adapter MUST be exercised
 * against live Atlassian Cloud, not shipped blind.
 */

/** Outcome of a space-reachability probe. `detail` carries the upstream status/reason the route classifies
 *  into a stable error code (auth_error | rate_limited | not_found | validation_failed). */
export type ConfluenceValidationResult = {
  readonly ok: boolean;
  readonly detail: string;
  readonly validatedAt: Date;
};

export type ConfluenceValidatorPort = {
  validateSpace(args: { spaceKey: string; now: Date }): Promise<ConfluenceValidationResult>;
};

/** Factory injected into the admin routes (mirrors GetPreflightValidator). Undefined at the composition root
 *  until the live Confluence adapter lands → the create route 503s. */
export type GetConfluenceValidator = () => ConfluenceValidatorPort;
