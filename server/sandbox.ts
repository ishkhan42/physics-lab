import { isUtf8 } from 'node:buffer';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const IMAGE = 'physics-lab-harness:local';
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDIN_BYTES = 64 * 1024 * 1024;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_RUNTIME_MS = 240_000;

const dockerEnv = {
  PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/nonexistent',
  ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
};

export interface SandboxRun {
  send: (message: unknown) => void;
  done: Promise<void>;
  stop: () => void;
}
export type SandboxFailureCode = 'docker_unavailable' | 'sandbox_image_missing' | 'sandbox_start_failed' | 'sandbox_resource_limit' | 'sandbox_worker_failed' | 'sandbox_protocol_failed' | 'sandbox_input_limit' | 'sandbox_output_limit' | 'sandbox_io_failed' | 'sandbox_timeout';
const SANDBOX_FAILURE_MESSAGES: Record<SandboxFailureCode, string> = {
  docker_unavailable: 'Docker is unavailable or inaccessible to the physics-lab service.',
  sandbox_image_missing: 'The local physics-lab harness image is missing.',
  sandbox_start_failed: 'Docker could not start the isolated harness.',
  sandbox_resource_limit: 'The isolated harness was terminated; a runtime resource limit may have been reached.',
  sandbox_worker_failed: 'The isolated harness worker exited unexpectedly.',
  sandbox_protocol_failed: 'Communication with the isolated harness contained invalid protocol data.',
  sandbox_input_limit: 'The isolated harness input exceeded its communication size allowance.',
  sandbox_output_limit: 'The isolated harness output exceeded its communication size allowance.',
  sandbox_io_failed: 'Communication with the isolated harness failed.',
  sandbox_timeout: 'The isolated harness exceeded its 240-second maximum lifetime.',
};

export class SandboxError extends Error {
  readonly code: SandboxFailureCode;

  constructor(code: SandboxFailureCode) {
    super(SANDBOX_FAILURE_MESSAGES[code]);
    this.name = 'SandboxError';
    this.code = code;
  }
}

export function sandboxExitFailure(code: number | null, exitSignal: NodeJS.Signals | null, stderr: string): SandboxError {
  const diagnostic = stderr.toLowerCase();
  if (diagnostic.includes(`no such image: ${IMAGE}`) || diagnostic.includes(`unable to find image '${IMAGE}' locally`)) {
    return new SandboxError('sandbox_image_missing');
  }
  if (/cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|error during connect|permission denied while trying to connect/.test(diagnostic)) {
    return new SandboxError('docker_unavailable');
  }
  if (code === 125) return new SandboxError('sandbox_start_failed');
  if (code === 137 || exitSignal === 'SIGKILL') return new SandboxError('sandbox_resource_limit');
  return new SandboxError('sandbox_worker_failed');
}
export function sandboxResourceArgs(input: unknown): string[] {
  const model = typeof input === 'object' && input !== null && 'model' in input && typeof input.model === 'object' && input.model !== null ? input.model : null;
  const imageInput = model !== null && 'input' in model && Array.isArray(model.input) && model.input.includes('image');
  return imageInput
    ? ['--memory=1g', '--pids-limit=128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m']
    : ['--memory=512m', '--pids-limit=64', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m'];
}


export function runSandbox(
  input: unknown,
  onMessage: (message: unknown) => void,
  signal: AbortSignal,
): SandboxRun {
  const containerName = `physics-lab-harness-${randomUUID()}`;
  let child: ChildProcessWithoutNullStreams | undefined;
  let settled = false;
  let cleanupAttempts = 0;
  let inputBytes = 0;
  let outputBytes = 0;
  let stderr = Buffer.alloc(0);
  let pending = Buffer.alloc(0);
  let lifetimeTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const childExited = Promise.withResolvers<void>();
  let cleanupDone = Promise.resolve();

  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  void done.catch(() => {});

  const cleanupContainer = () => {
    if (!child || cleanupAttempts === 2) return cleanupDone;
    cleanupAttempts++;
    cleanupDone = cleanupDone.then(() => new Promise<void>(resolve => {
      try {
        const cleanup = spawn('docker', ['rm', '-f', containerName], { cwd: '/', env: dockerEnv, stdio: 'ignore' });
        const timeout = setTimeout(() => cleanup.kill('SIGKILL'), 5_000);
        timeout.unref();
        cleanup.once('error', () => { clearTimeout(timeout); resolve(); });
        cleanup.once('close', () => { clearTimeout(timeout); resolve(); });
      } catch { resolve(); }
    }));
    return cleanupDone;
  };

  const detachSignal = () => signal.removeEventListener('abort', onAbort);
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(lifetimeTimer);
    detachSignal();
    if (child) {
      child.stdin.destroy();
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 1_000);
        killTimer.unref();
      }
    }
    void (async () => {
      await cleanupContainer();
      if (child?.pid !== undefined) await childExited.promise;
      await cleanupContainer();
      rejectDone(error);
    })();
  };

  function onAbort() {
    const error = new Error('Sandbox run was aborted.');
    error.name = 'AbortError';
    fail(error);
  }

  const send = (message: unknown) => {
    if (settled || !child) return;
    let json: string | undefined;
    try {
      json = JSON.stringify(message);
    } catch {
      fail(new SandboxError('sandbox_protocol_failed'));
      return;
    }
    if (json === undefined) {
      fail(new SandboxError('sandbox_protocol_failed'));
      return;
    }
    const bytes = Buffer.byteLength(json) + 1;
    if (bytes - 1 > MAX_LINE_BYTES) {
      fail(new SandboxError('sandbox_input_limit'));
      return;
    }
    if (inputBytes + bytes > MAX_STDIN_BYTES) {
      fail(new SandboxError('sandbox_input_limit'));
      return;
    }
    inputBytes += bytes;
    try {
      child.stdin.write(`${json}\n`);
    } catch {
      fail(new SandboxError('sandbox_io_failed'));
    }
  };

  if (signal.aborted) {
    onAbort();
    return { send, done, stop: onAbort };
  }
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
    return { send, done, stop: onAbort };
  }

  const args = [
    'run', '--rm', '-i',
    '--pull=never',
    '--name', containerName,
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=10001:10001',
    ...sandboxResourceArgs(input),
    '--cpus=1',
    IMAGE,
  ];
  try {
    child = spawn('docker', args, {
      cwd: '/',
      env: dockerEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    fail(new SandboxError('sandbox_start_failed'));
    return { send, done, stop: onAbort };
  }

  lifetimeTimer = setTimeout(() => fail(new SandboxError('sandbox_timeout')), MAX_RUNTIME_MS);
  lifetimeTimer.unref();

  child.on('error', (error) => {
    const errno = error as NodeJS.ErrnoException;
    fail(new SandboxError(errno.code === 'ENOENT' ? 'docker_unavailable' : 'sandbox_start_failed'));
  });
  child.stdin.on('error', () => fail(new SandboxError('sandbox_io_failed')));
  child.stdout.on('error', () => fail(new SandboxError('sandbox_io_failed')));
  child.stderr.on('error', () => fail(new SandboxError('sandbox_io_failed')));
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_BYTES) {
      stderr = Buffer.concat([stderr, chunk.subarray(0, MAX_STDERR_BYTES - stderr.length)]);
    }
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (settled) return;
    outputBytes += chunk.length;
    if (outputBytes > MAX_STDOUT_BYTES) {
      fail(new SandboxError('sandbox_output_limit'));
      return;
    }
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const newline = data.indexOf(0x0a, start);
      if (newline === -1) break;
      let line = data.subarray(start, newline);
      if (line.length > MAX_LINE_BYTES) {
        fail(new SandboxError('sandbox_output_limit'));
        return;
      }
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (!line.length || !isUtf8(line)) {
        fail(new SandboxError('sandbox_protocol_failed'));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line.toString('utf8'));
      } catch {
        fail(new SandboxError('sandbox_protocol_failed'));
        return;
      }
      try {
        onMessage(message);
      } catch {
        fail(new SandboxError('sandbox_protocol_failed'));
        return;
      }
      start = newline + 1;
      if (settled) return;
    }
    pending = start === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(start));
    if (pending.length > MAX_LINE_BYTES) fail(new SandboxError('sandbox_output_limit'));
  });
  child.on('close', (code, exitSignal) => {
    childExited.resolve();
    clearTimeout(killTimer);
    if (settled) {
      cleanupContainer();
      return;
    }
    if (code === 137 || exitSignal === 'SIGKILL') {
      fail(sandboxExitFailure(code, exitSignal, stderr.toString('utf8')));
      return;
    }
    if (pending.length) {
      fail(new SandboxError('sandbox_protocol_failed'));
      return;
    }
    if (code !== 0) {
      fail(sandboxExitFailure(code, exitSignal, stderr.toString('utf8')));
      return;
    }
    settled = true;
    clearTimeout(lifetimeTimer);
    clearTimeout(killTimer);
    detachSignal();
    void cleanupContainer().then(resolveDone);
  });

  send(input);
  return { send, done, stop: onAbort };
}
