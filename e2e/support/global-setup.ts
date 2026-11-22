import { E2E } from './env';

/** Start every run from an empty e2e database. */
export default async function globalSetup() {
  const res = await fetch(`${E2E.seedUrl}/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`Could not reset the e2e database: ${res.status} ${await res.text()}`);
}
