// Milestone 1 check: API is ready, can publish to RabbitMQ, and a consumer drains the queue.
// Usage: start infra + api + fetch-worker, then `npm run smoke`.
const API = process.env.API_URL ?? 'http://localhost:4000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (res) => ({ status: res.status, body: await res.json() });
let failed = false;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed = true;
};

try {
  const ready = await json(await fetch(`${API}/health/ready`));
  check(ready.status === 200, 'API ready', JSON.stringify(ready.body.checks));

  const before = await json(await fetch(`${API}/api/dev/queues`));
  const fetchQ = before.body.queues.find((q) => q.queue === 'fetch.http');
  check(fetchQ?.consumerCount > 0, 'fetch.http has a consumer', `consumers=${fetchQ?.consumerCount}`);

  const pub = await json(await fetch(`${API}/api/dev/test-fetch-job`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  check(pub.status === 202, 'Publish confirmed by broker', pub.body.message?.messageId);

  let drained = false;
  for (let i = 0; i < 20 && !drained; i++) {
    await sleep(250);
    const q = (await json(await fetch(`${API}/api/dev/queues`))).body.queues.find((x) => x.queue === 'fetch.http');
    drained = q.messageCount === 0;
  }
  check(drained, 'Consumer received and acked the message');
} catch (err) {
  check(false, 'Smoke test could not reach the API', err.message);
}

process.exit(failed ? 1 : 0);
