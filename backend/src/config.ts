export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
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

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    nodeEnv: parseNodeEnv(env.NODE_ENV),
    host: env.HOST?.trim() || '127.0.0.1',
    port: parsePort(env.PORT),
    databaseUrl: required(env, 'DATABASE_URL'),
    redisUrl: required(env, 'REDIS_URL'),
  };
}
