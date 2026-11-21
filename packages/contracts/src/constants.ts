/**
 * Plain constants with no dependencies — safe for the browser to import
 * via `@monitorly/contracts/constants` without bundling Zod.
 */
export const MONITOR_TYPES = ['job_listing', 'product_availability', 'generic'] as const;
export const MONITOR_STATUSES = ['active', 'paused', 'error'] as const;
export const FETCH_MODES = ['auto', 'http', 'browser'] as const;

export type MonitorType = (typeof MONITOR_TYPES)[number];
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];
export type MonitorFetchMode = (typeof FETCH_MODES)[number];

/** Intervals offered in the UI. The API accepts any integer in [MIN, MAX]. */
export const CHECK_INTERVAL_OPTIONS = [5, 15, 30, 60, 180, 360, 720, 1440] as const;
export const MIN_CHECK_INTERVAL_MINUTES = 5;
export const MAX_CHECK_INTERVAL_MINUTES = 1440;
