import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Spinner } from '../src/cli/spinner.js';

// The regression: stop() used to always emit the clear-line escape, so calling
// it once per streamed content chunk erased the reply as it printed (TTY only).

const CLEAR = '\r\x1B[K'; // carriage-return + erase-to-end

describe('Spinner.stop() is idempotent on the terminal', () => {
  let writes: string[];
  let origWrite: typeof process.stdout.write;
  let origTTY: boolean | undefined;

  beforeEach(() => {
    writes = [];
    origWrite = process.stdout.write.bind(process.stdout);
    origTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.stdout.write = ((s: string) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    Object.defineProperty(process.stdout, 'isTTY', { value: origTTY, configurable: true });
  });

  it('does NOT clear the line when stopped while inactive', () => {
    const sp = new Spinner('fog', 'thinking');
    sp.stop(); // never started
    expect(writes.join('')).not.toContain(CLEAR);
  });

  it('clears exactly once across repeated stop() calls', () => {
    const sp = new Spinner('fog', 'thinking');
    sp.start();
    writes.length = 0; // ignore the hidden-cursor + first frame
    sp.stop();
    sp.stop();
    sp.stop();
    const clears = writes.join('').split(CLEAR).length - 1;
    expect(clears).toBe(1);
    sp.stop(); // ensure timer is cleared
  });

  it('no-ops entirely on a non-TTY stream', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const sp = new Spinner('rain', 'thinking');
    sp.start();
    sp.setLabel('x');
    sp.stop();
    expect(writes.join('')).toBe('');
  });
});
