/**
 * The mock status stream's tick (src/mocks: one lifecycle step of every
 * going run, analysis and profile job per tick). A module constant so
 * tests can vi.mock a faster cadence. The app itself never polls on a
 * timer: status comes from the live feed (lib/live).
 */
export const POLL_INTERVAL_MS = 2000;
