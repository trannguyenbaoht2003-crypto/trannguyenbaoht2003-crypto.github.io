export type OperatorConfig = {
  host: '127.0.0.1' | '::1' | 'localhost';
  port: number;
  databaseUrl: string;
};

const LOOPBACK_HOSTS = new Set<OperatorConfig['host']>([
  '127.0.0.1',
  '::1',
  'localhost',
]);

function parseHost(value: string | undefined): OperatorConfig['host'] {
  const host = value?.trim() || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host as OperatorConfig['host'])) {
    throw new Error('OPERATOR_HOST must be loopback-only');
  }
  return host as OperatorConfig['host'];
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3011;
  if (value.trim() === '') {
    throw new Error('OPERATOR_PORT must be an integer between 1 and 65535');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('OPERATOR_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function requiredDatabaseUrl(value: string | undefined): string {
  const databaseUrl = value?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return databaseUrl;
}

export function parseOperatorConfig(env: NodeJS.ProcessEnv): OperatorConfig {
  return {
    host: parseHost(env.OPERATOR_HOST),
    port: parsePort(env.OPERATOR_PORT),
    databaseUrl: requiredDatabaseUrl(env.DATABASE_URL),
  };
}
