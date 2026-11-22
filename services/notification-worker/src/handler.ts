import { MAX_ATTEMPTS, ROUTES, type EmailJob, type EventMatched } from '@monitorly/contracts';
import { Event, Monitor, Notification, User, isDuplicateKeyError, mongoose } from '@monitorly/database';
import type { Logger } from '@monitorly/logger';
import { createEnvelope, type ConsumeContext } from '@monitorly/messaging';
import { enqueueOutbox } from '@monitorly/outbox';
import { emailContent, notificationText, type ChangeType } from './content';
import { MailError, type Mailer } from './mailer';

export interface NotificationDeps {
  logger: Logger;
  /** Base URL of the web app, for links in emails. */
  webOrigin: string;
  wakeOutbox?: () => void;
}

export interface EmailDeps {
  logger: Logger;
  mailer: Mailer;
  webOrigin: string;
  /** Emails per user per hour; more are skipped (still visible in the app). */
  maxPerHour: number;
  /** A send stuck in "sending" this long (crashed worker) may be taken over. */
  staleSendMs?: number;
  now?: () => Date;
}

const monitorName = (m: { name?: string | null; url: string }) => m.name || new URL(m.url).hostname;

// ---------------------------------------------------------------- event.matched → notification

export type DispatchResult = 'ignored' | 'duplicate' | 'muted' | 'created';

/**
 * One matched change → one notification (unique per event, so redeliveries are harmless), then
 * in the same transaction: an email job if the monitor emails, and a live push if it notifies
 * in the app.
 */
export async function handleEventMatched(deps: NotificationDeps, msg: EventMatched, ctx: ConsumeContext): Promise<DispatchResult> {
  const log = deps.logger.child({ eventId: msg.eventId, monitorId: msg.monitorId, attempt: ctx.attempt });

  const [event, monitor, user] = await Promise.all([
    Event.findById(msg.eventId).lean(),
    Monitor.findById(msg.monitorId, { name: 1, url: 1, notifyInApp: 1, notifyEmail: 1 }).lean(),
    User.findById(msg.userId, { emailNotifications: 1 }).lean(),
  ]);
  if (!event || !monitor || !user || String(event.monitorId) !== msg.monitorId) {
    log.info('Event, monitor or user no longer exists; ignoring');
    return 'ignored';
  }

  const inApp = monitor.notifyInApp !== false;
  const email = monitor.notifyEmail === true && user.emailNotifications !== false;
  if (!inApp && !email) {
    log.info('Notifications are off for this monitor');
    return 'muted';
  }

  const text = notificationText({
    eventType: event.eventType as ChangeType,
    title: event.title,
    description: event.description,
    aiSummary: event.ai?.status === 'done' ? event.ai.summary : undefined,
    monitorName: monitorName(monitor),
  });

  try {
    await mongoose.connection.transaction(async (session) => {
      const [notification] = await Notification.create(
        [
          {
            userId: msg.userId,
            monitorId: msg.monitorId,
            eventId: msg.eventId,
            eventType: event.eventType,
            title: text.title,
            message: text.message,
            sourceUrl: event.sourceUrl,
            inApp,
            email: { status: email ? 'pending' : 'not_requested' },
          },
        ],
        { session },
      );
      const ids = { notificationId: String(notification!._id), userId: msg.userId };
      if (email) await enqueueOutbox(ROUTES.notifyEmail, { ...createEnvelope(), ...ids }, session);
      if (inApp) await enqueueOutbox(ROUTES.notificationCreated, { ...createEnvelope(), ...ids }, session);
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      log.info('Notification already exists for this event');
      return 'duplicate';
    }
    throw err;
  }
  deps.wakeOutbox?.();
  log.info({ inApp, email }, 'Notification created');
  return 'created';
}

// ---------------------------------------------------------------- notify.email → email

export type EmailResult = 'ignored' | 'duplicate' | 'skipped' | 'sent' | 'failed';

/**
 * Sends a notification's email once. The send is claimed first (pending → sending) so parallel
 * deliveries don't both send; a claim left by a crashed worker expires after staleSendMs.
 * The provider also gets the notification id as idempotency key.
 */
export async function handleEmailJob(deps: EmailDeps, msg: EmailJob, ctx: ConsumeContext): Promise<EmailResult> {
  const log = deps.logger.child({ notificationId: msg.notificationId, attempt: ctx.attempt });
  const now = deps.now?.() ?? new Date();
  const staleBefore = new Date(now.getTime() - (deps.staleSendMs ?? 10 * 60_000));

  const notification = await Notification.findById(msg.notificationId).lean();
  if (!notification) return done(log, 'ignored', 'notification no longer exists');
  const status = notification.email?.status ?? 'not_requested';
  if (status === 'sent') return done(log, 'duplicate', 'already sent');
  if (status === 'not_requested' || status === 'skipped' || status === 'failed') return done(log, 'ignored', `email ${status}`);

  const [user, monitor] = await Promise.all([
    User.findById(notification.userId, { email: 1, emailNotifications: 1 }).lean(),
    Monitor.findById(notification.monitorId, { name: 1, url: 1, notifyEmail: 1 }).lean(),
  ]);
  if (!user || !monitor) return done(log, 'ignored', 'user or monitor no longer exists');

  const skip = async (reason: string) => {
    await Notification.updateOne(
      { _id: notification._id, 'email.status': { $in: ['pending', 'sending'] } },
      { $set: { 'email.status': 'skipped', 'email.error': reason } },
    );
    return done(log, 'skipped', reason);
  };
  // Settings may have changed since the job was queued.
  if (user.emailNotifications === false || monitor.notifyEmail !== true) return skip('Email alerts were turned off');
  const sentLastHour = await Notification.countDocuments({
    userId: notification.userId,
    'email.status': 'sent',
    'email.sentAt': { $gt: new Date(now.getTime() - 3_600_000) },
  });
  if (sentLastHour >= deps.maxPerHour) return skip(`Hourly email limit (${deps.maxPerHour}) reached; see the app for this alert`);

  // Claim the send.
  const claimed = await Notification.updateOne(
    {
      _id: notification._id,
      $or: [{ 'email.status': 'pending' }, { 'email.status': 'sending', 'email.sendingAt': { $lt: staleBefore } }],
    },
    { $set: { 'email.status': 'sending', 'email.sendingAt': now } },
  );
  if (claimed.modifiedCount !== 1) return done(log, 'duplicate', 'another worker is sending it');

  const name = monitorName(monitor);
  const content = emailContent(
    {
      eventType: (notification.eventType ?? 'new_item') as ChangeType,
      title: notification.title,
      sourceUrl: notification.sourceUrl,
      monitorName: name,
    },
    { title: notification.title, message: notification.message },
    {
      monitorUrl: `${deps.webOrigin}/monitors/${String(monitor._id)}`,
      settingsUrl: `${deps.webOrigin}/monitors/${String(monitor._id)}/edit`,
    },
  );

  try {
    const { id } = await deps.mailer.send({ to: user.email, ...content, idempotencyKey: `notification-${String(notification._id)}` });
    await Notification.updateOne(
      { _id: notification._id },
      { $set: { 'email.status': 'sent', 'email.sentAt': new Date(), 'email.providerMessageId': id }, $unset: { 'email.error': 1 } },
    );
    log.info({ mailer: deps.mailer.name }, 'Email sent');
    return 'sent';
  } catch (err) {
    const permanent = err instanceof MailError && err.permanent;
    const message = (err as Error).message.slice(0, 500);
    if (!permanent && ctx.attempt < MAX_ATTEMPTS) {
      // Release the claim so the retry can take it.
      await Notification.updateOne({ _id: notification._id, 'email.status': 'sending' }, { $set: { 'email.status': 'pending', 'email.error': message } });
      log.warn({ err }, 'Email failed; will retry');
      throw err;
    }
    await Notification.updateOne({ _id: notification._id }, { $set: { 'email.status': 'failed', 'email.error': message } });
    log.error({ err, permanent }, 'Email failed; giving up');
    return 'failed';
  }
}

function done<T extends string>(log: Logger, result: T, reason: string): T {
  log.info({ result, reason }, 'Email not sent');
  return result;
}
