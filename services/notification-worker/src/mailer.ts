import nodemailer from 'nodemailer';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Same key → the provider sends at most once (Resend honours it for 24 h). */
  idempotencyKey: string;
}

/** permanent = retrying can't help (bad address, rejected sender, bad API key). */
export class MailError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MailError';
  }
}

export interface Mailer {
  readonly name: string;
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
}

/** SMTP: Mailpit locally (http://localhost:8025), or any real SMTP server. */
export function createSmtpMailer(o: SmtpOptions): Mailer {
  const transport = nodemailer.createTransport({
    host: o.host,
    port: o.port,
    secure: o.port === 465,
    ...(o.user ? { auth: { user: o.user, pass: o.pass ?? '' } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    name: `smtp://${o.host}:${o.port}`,
    async send(email) {
      try {
        const info = await transport.sendMail({
          from: o.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: { 'X-Entity-Ref-ID': email.idempotencyKey },
        });
        return { id: String(info.messageId ?? '') };
      } catch (err) {
        const code = (err as { responseCode?: number }).responseCode;
        // 5xx = the server refused this message for good (unknown recipient, policy…).
        throw new MailError((err as Error).message, typeof code === 'number' && code >= 500, { cause: err });
      }
    },
  };
}

/** Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export function createResendMailer(apiKey: string, from: string, fetchFn: typeof fetch = fetch): Mailer {
  return {
    name: 'resend',
    async send(email) {
      let res: Response;
      try {
        res = await fetchFn('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': email.idempotencyKey,
          },
          body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new MailError(`Resend unreachable: ${(err as Error).message}`, false, { cause: err });
      }
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (res.ok && body.id) return { id: body.id };
      const detail = `${res.status} ${body.name ?? ''} ${body.message ?? ''}`.trim();
      // 429 and 5xx can succeed later; other 4xx (validation, auth, domain) won't.
      throw new MailError(`Resend refused the email: ${detail}`, res.status < 500 && res.status !== 429);
    },
  };
}
