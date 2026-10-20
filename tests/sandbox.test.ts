import assert from 'node:assert/strict';
import test from 'node:test';
import { sandboxExitFailure } from '../server/sandbox.ts';

test('sandbox exits distinguish Docker setup, runtime resource, and worker failures without exposing stderr', () => {
  const missingImage = sandboxExitFailure(125, null, "Error response from daemon: No such image: physics-lab-harness:local");
  assert.equal(missingImage.code, 'sandbox_image_missing');

  const inaccessibleDocker = sandboxExitFailure(125, null, 'permission denied while trying to connect to the Docker daemon');
  assert.equal(inaccessibleDocker.code, 'docker_unavailable');

  const dockerStartFailure = sandboxExitFailure(125, null, 'OCI runtime failed to create container');
  assert.equal(dockerStartFailure.code, 'sandbox_start_failed');
  assert.doesNotMatch(dockerStartFailure.message, /build/i);

  const resourceFailure = sandboxExitFailure(137, null, 'worker terminated by runtime');
  assert.equal(resourceFailure.code, 'sandbox_resource_limit');
  assert.match(resourceFailure.message, /may have been reached/);

  const workerFailure = sandboxExitFailure(1, null, 'private worker diagnostic /private/path');
  assert.equal(workerFailure.code, 'sandbox_worker_failed');
  assert.doesNotMatch(workerFailure.message, /private|diagnostic|path/i);
});
