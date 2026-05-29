/** Self-signed TLS certificate generation for local HTTPS. */
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import dgram from 'node:dgram';

const CERT_DIR = join(homedir(), '.weather-agents', 'certs');

/** Return all non-loopback IPv4 addresses on this machine. */
export function detectAllLanIps(): string[] {
  const ips: string[] = [];
  try {
    const ifaces = networkInterfaces();
    for (const info of Object.values(ifaces).flat().filter(Boolean)) {
      if (info && info.family === 'IPv4' && !info.address.startsWith('127.')) {
        ips.push(info.address);
      }
    }
  } catch {
    /* ignore */
  }

  // UDP trick to get the default route interface IP.
  try {
    const s = dgram.createSocket('udp4');
    s.connect(80, '8.8.8.8', () => {});
    const addr = s.address();
    if (addr && addr.address && !ips.includes(addr.address)) ips.push(addr.address);
    s.close();
  } catch {
    /* ignore */
  }
  return ips;
}

function certKeyPaths(ips: string[]): [string, string] {
  const h = createHash('sha256')
    .update([...ips].sort().join(','))
    .digest('hex')
    .slice(0, 12);
  return [join(CERT_DIR, `voice_${h}.pem`), join(CERT_DIR, `voice_${h}.key`)];
}

/** Idempotently ensure a self-signed cert+key for `ips` exists. Uses OpenSSL CLI. */
export function ensureSelfSignedCert(ips: string[]): [string, string] {
  if (!ips.length) ips = ['127.0.0.1'];
  const [certPath, keyPath] = certKeyPaths(ips);
  if (existsSync(certPath) && existsSync(keyPath)) return [certPath, keyPath];

  mkdirSync(CERT_DIR, { recursive: true });

  const sanList = ips.map((ip) => `IP:${ip}`).join(',');
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" ` +
        `-days 3650 -subj "/CN=weather-agents-voice" -addext "subjectAltName=${sanList}"`,
      { stdio: 'pipe', timeout: 30000 },
    );
  } catch {
    writeFileSync(certPath, 'PLACEHOLDER CERT — openssl not available', 'utf-8');
    writeFileSync(keyPath, 'PLACEHOLDER KEY — openssl not available', 'utf-8');
  }
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* ignore */
  }
  return [certPath, keyPath];
}
