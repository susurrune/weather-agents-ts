import { describe, it, expect } from 'vitest';
import { ACLMiddleware, RateLimitMiddleware, MiddlewareChain } from '../src/core/middleware.js';

describe('ACLMiddleware', () => {
  it('allow-by-default permits unknown agents', async () => {
    const acl = new ACLMiddleware(true);
    expect(await acl.pre('read_file', 'fog', {})).toEqual([true, null]);
  });

  it('denies explicitly denied tools', async () => {
    const acl = new ACLMiddleware(true);
    acl.deny('fog', 'shell_exec');
    const [allowed, reason] = await acl.pre('shell_exec', 'fog', {});
    expect(allowed).toBe(false);
    expect(reason).toContain('not allowed');
  });

  it('deny-by-default blocks tools not explicitly allowed', async () => {
    const acl = new ACLMiddleware(false);
    acl.allow('rain', 'write_file');
    expect((await acl.pre('write_file', 'rain', {}))[0]).toBe(true);
    expect((await acl.pre('shell_exec', 'rain', {}))[0]).toBe(false);
  });
});

describe('RateLimitMiddleware', () => {
  it('blocks after exceeding the per-tool limit', async () => {
    const rl = new RateLimitMiddleware(30, 60);
    rl.setLimit('burst', 2, 60);
    expect((await rl.pre('burst', null, {}))[0]).toBe(true);
    expect((await rl.pre('burst', null, {}))[0]).toBe(true);
    const [allowed, reason] = await rl.pre('burst', null, {});
    expect(allowed).toBe(false);
    expect(reason).toContain('rate limit exceeded');
  });
});

describe('MiddlewareChain', () => {
  it('short-circuits on the first deny', async () => {
    const chain = new MiddlewareChain();
    const acl = new ACLMiddleware(true);
    acl.deny('fog', 'x');
    chain.add(acl);
    expect((await chain.runPre('x', 'fog', {}))[0]).toBe(false);
    expect((await chain.runPre('y', 'fog', {}))[0]).toBe(true);
  });
});
