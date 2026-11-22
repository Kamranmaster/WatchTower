import { mongoose } from '@monitorly/database';
import { HttpError } from './middleware/errors';

/**
 * Keyset pagination for newest-first lists sorted by (time desc, _id desc).
 * The cursor is the position of the last item returned: "<ISO time>|<ObjectId>", base64url
 * encoded so clients treat it as opaque. Unlike skip/offset, pages stay correct while new
 * items keep arriving at the top.
 */
export function encodeCursor(time: Date, id: unknown): string {
  return Buffer.from(`${time.toISOString()}|${String(id)}`).toString('base64url');
}

/** Mongo filter for "older than the cursor", or {} without one. Malformed cursors are a 400. */
export function cursorFilter(raw: unknown, timeField: string): Record<string, unknown> {
  if (raw === undefined || raw === '') return {};
  const invalid = () => new HttpError(400, 'Invalid cursor', [{ path: 'cursor', message: 'Invalid cursor' }]);
  if (typeof raw !== 'string' || raw.length > 200) throw invalid();
  const [iso, id, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const time = new Date(iso ?? '');
  if (rest.length > 0 || Number.isNaN(time.getTime()) || !id || !mongoose.isValidObjectId(id)) throw invalid();
  const _id = new mongoose.Types.ObjectId(id);
  return { $or: [{ [timeField]: { $lt: time } }, { [timeField]: time, _id: { $lt: _id } }] };
}

/**
 * Splits a `limit + 1` query result into the page and the cursor for the next one.
 * Fetching one extra item tells us whether there is a next page without a count query.
 */
export function paginate<T extends { _id: unknown }>(rows: T[], limit: number, timeOf: (row: T) => Date) {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { page, nextCursor: rows.length > limit && last ? encodeCursor(timeOf(last), last._id) : null };
}
