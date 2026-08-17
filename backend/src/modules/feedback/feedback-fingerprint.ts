import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

function canonicalizeIp(gatewayIp: string): string {
  const family = isIP(gatewayIp);
  if (family === 0) throw new Error('Invalid gateway client IP');

  if (family === 4) {
    return gatewayIp
      .split('.')
      .map((part) => String(Number(part)))
      .join('.');
  }

  const hostname = new URL(`http://[${gatewayIp}]/`).hostname;
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) {
    throw new Error('Invalid gateway client IP');
  }
  return hostname.slice(1, -1).toLowerCase();
}

export function createFeedbackFingerprint(
  secret: string,
  gatewayIp: string,
): string {
  if (!secret) throw new Error('Feedback fingerprint secret is required');
  const canonicalIp = canonicalizeIp(gatewayIp);
  return createHmac('sha256', secret)
    .update(canonicalIp, 'utf8')
    .digest('hex');
}
