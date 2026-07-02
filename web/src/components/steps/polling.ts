/**
 * Poll cadence for active conversions (GET /v1/conversions/{id}); the
 * gateway's read-through poll keeps that endpoint fresh. A module constant
 * so tests can vi.mock a faster cadence.
 */
export const POLL_INTERVAL_MS = 2000;
