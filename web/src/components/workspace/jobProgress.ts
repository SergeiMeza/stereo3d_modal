/**
 * How often an open project page reads a running analysis's or profile's
 * progress (QA 2026-11-07). The gateway works the % out from the job on
 * each project read and never writes it, so the live feed carries only a
 * job's start and end. A module constant so tests can vi.mock it.
 */
export const JOB_PROGRESS_READ_MS = 3000;
