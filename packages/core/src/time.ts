/**
 * Parse a timestamp string and return a UTC millisecond epoch.
 * Returns null if the input is not a valid date.
 */
export function parseUtcTimestamp(iso: string): number | null {
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * Format a UTC ISO timestamp as local time (e.g., "3:00 PM" or "3:00pm").
 */
export function formatLocalTime(isoUtc: string, lowercase: boolean = false): string {
  const date = new Date(isoUtc);
  if (isNaN(date.getTime())) return 'unknown';

  const formatted = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return lowercase ? formatted.toLowerCase() : formatted;
}

/**
 * Format a UTC ISO timestamp as local date+time.
 * If the date is today, shows just time (e.g., "3:00 PM").
 * If the date is another day, includes short weekday (e.g., "Thu 7:00 AM").
 */
export function formatLocalDateTime(isoUtc: string): string {
  const date = new Date(isoUtc);
  if (isNaN(date.getTime())) return 'unknown';

  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (isToday) return timeStr;

  const dayStr = date.toLocaleDateString(undefined, { weekday: 'short' });
  return `${dayStr} ${timeStr}`;
}

/**
 * Compute a human-readable relative duration from now to the given ISO timestamp.
 * Returns "resets soon" if the time is in the past (negative duration guard).
 */
export function formatRelativeTime(isoUtc: string, nowMs?: number): string {
  const target = parseUtcTimestamp(isoUtc);
  if (target === null) return 'unknown';

  const diff = target - (nowMs ?? Date.now());

  if (diff <= 0) return 'resets soon';

  const totalMinutes = Math.floor(diff / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'resets soon';
}

/**
 * Check for clock skew: returns true if fetchedAt is more than 5 minutes
 * in the future relative to Date.now().
 */
export function detectClockSkew(fetchedAtIso: string, nowMs?: number): boolean {
  const fetchedAt = parseUtcTimestamp(fetchedAtIso);
  if (fetchedAt === null) return false;
  return fetchedAt - (nowMs ?? Date.now()) > 5 * 60 * 1000;
}
