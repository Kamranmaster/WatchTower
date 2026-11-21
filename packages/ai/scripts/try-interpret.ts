/**
 * Try the instruction → rules prompt against the configured AI provider (AI_PROVIDER in .env):
 *   npm run ai:try -- "Notify me about new SWE intern roles in India, ignore senior" https://careers.example.com/jobs
 */
import '@monitorly/config'; // loads the monorepo .env
import { z } from 'zod';
import { AiError, aiEnvFields, createAiInterpreter, resolveAiConfig } from '../src';

const env = z.object(aiEnvFields).parse(process.env);
const [instruction, url] = process.argv.slice(2);

if (!instruction) {
  console.error('Usage: npm run ai:try -- "<instruction>" [url]');
  process.exit(1);
}
const config = resolveAiConfig(env);
if (!config) {
  console.error(`AI_API_KEY is not set in .env (AI_PROVIDER=${env.AI_PROVIDER})`);
  process.exit(1);
}

console.log(`Provider: ${config.provider}, model: ${config.model}\n`);
const started = Date.now();
try {
  const result = await createAiInterpreter(config).interpret({ instruction, url });
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n${Date.now() - started} ms`);
} catch (err) {
  console.error(err instanceof AiError ? err.message : err);
  process.exit(1);
}
