import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTEMPTS, ROUTES, emailJobSchema, notificationCreatedSchema, type EventMatched } from '@monitorly/contracts';
import {
  CheckRun,
  Event,
  Monitor,
  Notification,
  OutboxMessage,
  User,
  connectDatabase,
  disconnectDatabase,
  mongoose,
  partitionFor,
  syncAllIndexes,
} from '@monitorly/database';
import { createSilentLogger } from '@monitorly/logger';
import { createEnvelope } from '@monitorly/messaging';
import { handleEmailJob, handleEventMatched, type EmailDeps } from '../src/handler';
import { MailError, type Mailer, type OutgoingEmail } from '../src/mailer';

const TEST_DB_URI = process.env.TEST_NOTIFY_MONGODB_URI ?? 'mongodb://localhost:27017/monitorly_notify_test?directConnection=true';
const logger = createSilentLogger();
const ctx = { messageId: 'm', attempt: 1, redelivered: false };
const WEB = 'https://app.monitorly.test';

beforeAll(async () => {
  await connectDatabase(TEST_DB_URI, logger);
  await syncAllIndexes();
});
beforeEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
});
afterAll(async () => {
  await mongoose.connection.db?.dropDatabase();
  await disconnectDatabase();
});

let seq = 0;
async function setup(opts: { notifyInApp?: boolean; notifyEmail?: boolean; emailNotifications?: boolean } = {}) {
  const user = await User.create({
    name: 'N',
    email: `n-${Date.now()}-${seq++}@example.com`,
    passwordHash: 'x',
    emailNotifications: opts.emailNotifications ?? true,
  });
  const _id = new mongoose.Types.ObjectId();
  const monitor = await Monitor.create({
    _id,
    userId: user._id,
    name: 'Acme <jobs>',
    url: 'https://careers.example.com/jobs',
    instruction: 'frontend internships',
    notifyInApp: opts.notifyInApp ?? true,
    notifyEmail: opts.notifyEmail ?? true,
    partitionId: partitionFor(String(_id)),
    nextCheckAt: new Date(Date.now() + 60_000),
  });
  const run = await CheckRun.create({ monitorId: monitor._id, userId: user._id, scheduledFor: new Date(), status: 'succeeded' });
  async function matched(title = 'Frontend Intern', extra: Record<string, unknown> = {}) {
    const event = await Event.create({
      monitorId: monitor._id,
      userId: user._id,
      checkRunId: run._id,
      eventType: 'new_item',
      title,
      description: 'Remote',
      sourceUrl: 'https://careers.example.com/jobs/frontend-intern',
      fingerprint: `fp-${seq++}`,
      detectedAt: new Date(),
      match: { status: 'matched' },
      alertedAt: new Date(),
      ...extra,
    });
    const msg: EventMatched = {
      ...createEnvelope(),
      eventId: event.id,
      monitorId: monitor.id,
      userId: user.id,
      eventType: 'new_item',
      aiReviewed: false,
    };
    return { event, msg };
  }
  return { user, monitor, matched };
}

const deps = { logger, webOrigin: WEB };
const outbox = (key: string) => OutboxMessage.find({ routingKey: key }).lean();

describe('event.matched → notification', () => {
  it('creates the notification, an email job and a live push', async () => {
    const t = await setup();
    const { event, msg } = await t.matched('Frontend Intern', {
      ai: { status: 'done', relevant: true, summary: 'New Frontend Intern role at Acme (Remote).' },
    });
    expect(await handleEventMatched(deps, msg, ctx)).toBe('created');

    const n = (await Notification.findOne({ eventId: event._id }).lean())!;
    expect(n).toMatchObject({
      title: 'New: Frontend Intern',
      message: 'New Frontend Intern role at Acme (Remote).',
      eventType: 'new_item',
      inApp: true,
      isRead: false,
      sourceUrl: 'https://careers.example.com/jobs/frontend-intern',
      email: { status: 'pending' },
    });
    const [email] = await outbox(ROUTES.notifyEmail.routingKey);
    expect(emailJobSchema.parse(email!.payload)).toMatchObject({ notificationId: String(n._id), userId: t.user.id });
    const [push] = await outbox(ROUTES.notificationCreated.routingKey);
    expect(notificationCreatedSchema.parse(push!.payload).notificationId).toBe(String(n._id));
  });

  it('uses the change description when there is no AI summary', async () => {
    const t = await setup();
    const { msg } = await t.matched('Data Analyst', { eventType: 'item_changed', description: 'Location: Remote → Mumbai' });
    await handleEventMatched(deps, msg, ctx);
    expect((await Notification.findOne().lean())!).toMatchObject({ title: 'Updated: Data Analyst', message: 'Location: Remote → Mumbai' });
  });

  it('follows the monitor and user settings', async () => {
    const appOnly = await setup({ notifyEmail: false });
    await handleEventMatched(deps, (await appOnly.matched()).msg, ctx);
    expect((await Notification.findOne({ userId: appOnly.user._id }).lean())!.email!.status).toBe('not_requested');

    const emailOnly = await setup({ notifyInApp: false });
    await handleEventMatched(deps, (await emailOnly.matched()).msg, ctx);
    expect((await Notification.findOne({ userId: emailOnly.user._id }).lean())!.inApp).toBe(false);

    const userOptedOut = await setup({ emailNotifications: false });
    await handleEventMatched(deps, (await userOptedOut.matched()).msg, ctx);
    expect((await Notification.findOne({ userId: userOptedOut.user._id }).lean())!.email!.status).toBe('not_requested');

    expect(await outbox(ROUTES.notifyEmail.routingKey)).toHaveLength(1); // only emailOnly
    expect(await outbox(ROUTES.notificationCreated.routingKey)).toHaveLength(2); // appOnly + userOptedOut

    const muted = await setup({ notifyInApp: false, notifyEmail: false });
    expect(await handleEventMatched(deps, (await muted.matched()).msg, ctx)).toBe('muted');
    expect(await Notification.countDocuments({ userId: muted.user._id })).toBe(0);
  });

  it('one notification per event, however often (or in parallel) the match arrives', async () => {
    const t = await setup();
    const { msg } = await t.matched();
    const results = await Promise.all([1, 2, 3].map(() => handleEventMatched(deps, msg, ctx)));
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(await handleEventMatched(deps, msg, { ...ctx, redelivered: true })).toBe('duplicate');
    expect(await Notification.countDocuments()).toBe(1);
    expect(await outbox(ROUTES.notifyEmail.routingKey)).toHaveLength(1);
    expect(await outbox(ROUTES.notificationCreated.routingKey)).toHaveLength(1);
  });

  it('ignores deleted monitors and events, and events of another monitor', async () => {
    const t = await setup();
    const { event, msg } = await t.matched();
    await Event.deleteOne({ _id: event._id });
    expect(await handleEventMatched(deps, msg, ctx)).toBe('ignored');

    const other = await setup();
    const foreign = await other.matched();
    expect(await handleEventMatched(deps, { ...foreign.msg, monitorId: t.monitor.id, userId: t.user.id }, ctx)).toBe('ignored');

    const { msg: m2 } = await t.matched('Another');
    await Monitor.deleteOne({ _id: t.monitor._id });
    expect(await handleEventMatched(deps, m2, ctx)).toBe('ignored');
    expect(await Notification.countDocuments()).toBe(0);
  });
});

describe('notify.email → email', () => {
  function fakeMailer(fail?: () => Error) {
    const sent: OutgoingEmail[] = [];
    const send = vi.fn(async (email: OutgoingEmail) => {
      if (fail) throw fail();
      sent.push(email);
      return { id: `msg-${sent.length}` };
    });
    return { mailer: { name: 'fake', send } as Mailer, sent, send };
  }

  async function queued(opts: Parameters<typeof setup>[0] = {}) {
    const t = await setup(opts);
    const { msg } = await t.matched();
    await handleEventMatched(deps, msg, ctx);
    const n = (await Notification.findOne({ userId: t.user._id }).lean())!;
    return { t, n, job: { ...createEnvelope(), notificationId: String(n._id), userId: t.user.id } };
  }
  const emailDeps = (mailer: Mailer, over: Partial<EmailDeps> = {}): EmailDeps => ({ logger, mailer, webOrigin: WEB, maxPerHour: 20, ...over });

  it('sends once, to the user, with escaped content and safe links', async () => {
    const { t, n, job } = await queued();
    const { mailer, sent } = fakeMailer();
    expect(await handleEmailJob(emailDeps(mailer), job, ctx)).toBe('sent');
    expect(await handleEmailJob(emailDeps(mailer), job, { ...ctx, redelivered: true })).toBe('duplicate');

    expect(sent).toHaveLength(1);
    const email = sent[0]!;
    expect(email.to).toBe(t.user.email);
    expect(email.subject).toBe('Acme <jobs> · New: Frontend Intern');
    expect(email.idempotencyKey).toBe(`notification-${String(n._id)}`);
    expect(email.html).toContain('Acme &lt;jobs&gt;');
    expect(email.html).not.toContain('Acme <jobs>');
    expect(email.html).toContain('href="https://careers.example.com/jobs/frontend-intern"');
    expect(email.text).toContain(`${WEB}/monitors/${t.monitor.id}/edit`);
    expect((await Notification.findById(n._id).lean())!.email).toMatchObject({ status: 'sent', providerMessageId: 'msg-1' });
  });

  it('parallel deliveries send only once', async () => {
    const { job } = await queued();
    const { mailer, send } = fakeMailer();
    const results = await Promise.all([1, 2, 3].map(() => handleEmailJob(emailDeps(mailer), job, ctx)));
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a temporary failure retries; the retry sends', async () => {
    const { n, job } = await queued();
    const failing = fakeMailer(() => new MailError('connection refused', false));
    await expect(handleEmailJob(emailDeps(failing.mailer), job, ctx)).rejects.toThrow('connection refused');
    expect((await Notification.findById(n._id).lean())!.email!.status).toBe('pending');
    const ok = fakeMailer();
    expect(await handleEmailJob(emailDeps(ok.mailer), job, { ...ctx, attempt: 2 })).toBe('sent');
  });

  it('a permanent failure, or the last attempt, gives up', async () => {
    const a = await queued();
    const bad = fakeMailer(() => new MailError('550 no such user', true));
    expect(await handleEmailJob(emailDeps(bad.mailer), a.job, ctx)).toBe('failed');
    expect((await Notification.findById(a.n._id).lean())!.email).toMatchObject({ status: 'failed', error: '550 no such user' });

    const b = await queued();
    const flaky = fakeMailer(() => new MailError('timeout', false));
    expect(await handleEmailJob(emailDeps(flaky.mailer), b.job, { ...ctx, attempt: MAX_ATTEMPTS })).toBe('failed');
  });

  it('a send left half-done by a crashed worker is taken over later, not while fresh', async () => {
    const { n, job } = await queued();
    await Notification.updateOne({ _id: n._id }, { $set: { 'email.status': 'sending', 'email.sendingAt': new Date() } });
    const { mailer } = fakeMailer();
    expect(await handleEmailJob(emailDeps(mailer), job, ctx)).toBe('duplicate');
    const later = () => new Date(Date.now() + 11 * 60_000);
    expect(await handleEmailJob(emailDeps(mailer, { now: later }), job, ctx)).toBe('sent');
  });

  it('skips when email was turned off after the alert, or the hourly limit is reached', async () => {
    const a = await queued();
    await Monitor.updateOne({ _id: a.t.monitor._id }, { notifyEmail: false });
    const { mailer, send } = fakeMailer();
    expect(await handleEmailJob(emailDeps(mailer), a.job, ctx)).toBe('skipped');
    expect((await Notification.findById(a.n._id).lean())!.email!.status).toBe('skipped');

    const b = await queued();
    expect(await handleEmailJob(emailDeps(mailer, { maxPerHour: 1 }), b.job, ctx)).toBe('sent');
    const { msg } = await b.t.matched('Second');
    await handleEventMatched(deps, msg, ctx);
    const second = (await Notification.findOne({ userId: b.t.user._id, title: 'New: Second' }).lean())!;
    const job2 = { ...createEnvelope(), notificationId: String(second._id), userId: b.t.user.id };
    expect(await handleEmailJob(emailDeps(mailer, { maxPerHour: 1 }), job2, ctx)).toBe('skipped');
    expect((await Notification.findById(second._id).lean())!.email!.error).toContain('Hourly email limit');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores deleted notifications and ones that never asked for email', async () => {
    const { mailer, send } = fakeMailer();
    expect(await handleEmailJob(emailDeps(mailer), { ...createEnvelope(), notificationId: new mongoose.Types.ObjectId().toString(), userId: new mongoose.Types.ObjectId().toString() }, ctx)).toBe('ignored');
    const { job } = await queued({ notifyEmail: false });
    expect(await handleEmailJob(emailDeps(mailer), job, ctx)).toBe('ignored');
    expect(send).not.toHaveBeenCalled();
  });
});
