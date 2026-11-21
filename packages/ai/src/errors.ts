export type AiErrorCode =
  | 'not_configured' // no AI provider key
  | 'auth' // key rejected
  | 'rate_limited' // provider rate limit (incl. free-tier limits)
  | 'quota_exhausted' // paid account has no credits left
  | 'timeout'
  | 'upstream' // provider returned an error / network failure
  | 'refused' // the model declined the request
  | 'bad_output'; // response didn't match the schema

const USER_MESSAGES: Record<AiErrorCode, string> = {
  not_configured: 'AI setup is not available (no AI provider configured). Fill in the filters yourself.',
  auth: 'The AI service rejected our credentials. Fill in the filters yourself for now.',
  rate_limited: 'The AI service is busy or its usage limit was reached. Try again later, or fill in the filters yourself.',
  quota_exhausted: 'The AI service has run out of credits. Fill in the filters yourself for now.',
  timeout: 'The AI service took too long to respond. Try again, or fill in the filters yourself.',
  upstream: 'The AI service failed. Try again, or fill in the filters yourself.',
  refused: 'The AI could not turn this description into filters. Try rewording it, or fill in the filters yourself.',
  bad_output: 'The AI gave an unusable answer. Try again, or fill in the filters yourself.',
};

/** Every failure from the AI layer. `userMessage` is safe to show; `message` may hold details for logs. */
export class AiError extends Error {
  readonly userMessage: string;

  constructor(
    readonly code: AiErrorCode,
    detail?: string,
    options?: { cause?: unknown },
  ) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = 'AiError';
    this.userMessage = USER_MESSAGES[code];
  }
}
