export function encodeRunnerEvent(event: {
  type: string;
  [key: string]: unknown;
}): string;
export function writeEvent(
  event: { type: string; [key: string]: unknown },
  stream?: NodeJS.WritableStream,
): void;
export function writeRunnerError(
  err: unknown,
  stream?: NodeJS.WritableStream,
): void;
