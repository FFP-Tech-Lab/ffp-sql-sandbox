import { stdout } from 'node:process';

export function encodeRunnerEvent(event) {
  return JSON.stringify(event) + '\n';
}

export function writeEvent(event, stream = stdout) {
  stream.write(encodeRunnerEvent(event));
}

export function writeRunnerError(err, stream = stdout) {
  const message = err instanceof Error ? err.message : String(err);
  writeEvent({ type: 'error', error: message }, stream);
}
