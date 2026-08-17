export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  feedbackIntakeEnabled: boolean;
  feedbackFingerprintSecret?: string;
}

function required(env: NodeJS.ProcessEnv, name: 'DATABASE_URL' | 'REDIS_URL'): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 3001;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseNodeEnv(value: string | undefined): AppConfig['nodeEnv'] {
  if (value === undefined) {
    return 'development';
  }
  if (value === 'development' || value === 'test' || value === 'production') {
    return value;
  }
  throw new Error('NODE_ENV must be development, test, or production');
}

function parseFeedbackEnabled(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('FEEDBACK_INTAKE_ENABLED must be true or false');
}

function parseFeedbackSecret(
  env: NodeJS.ProcessEnv,
  enabled: boolean,
): string | undefined {
  const value = env.FEEDBACK_FINGERPRINT_SECRET?.trim();
  if (!enabled) return undefined;
  if (!value) throw new Error('FEEDBACK_FINGERPRINT_SECRET is required when feedback intake is enabled');
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('FEEDBACK_FINGERPRINT_SECRET must contain at least 32 bytes');
  }
  return value;
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const feedbackIntakeEnabled = parseFeedbackEnabled(env.FEEDBACK_INTAKE_ENABLED);
  const feedbackFingerprintSecret = parseFeedbackSecret(env, feedbackIntakeEnabled);
  return {
    nodeEnv: parseNodeEnv(env.NODE_ENV),
    host: env.HOST?.trim() || '127.0.0.1',
    port: parsePort(env.PORT),
    databaseUrl: required(env, 'DATABASE_URL'),
    redisUrl: required(env, 'REDIS_URL'),
    feedbackIntakeEnabled,
    ...(feedbackFingerprintSecret ? { feedbackFingerprintSecret } : {}),
  };
}
