/** Return all non-loopback IPv4 addresses on this machine. */
export declare function detectAllLanIps(): string[];
/** Idempotently ensure a self-signed cert+key for `ips` exists. Uses OpenSSL CLI. */
export declare function ensureSelfSignedCert(ips: string[]): [string, string];
