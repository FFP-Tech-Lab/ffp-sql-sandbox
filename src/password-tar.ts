/**
 * Build a ustar archive containing a single file `db_password`.
 * Kept for tests that model Docker `putArchive` (which writes under mounts).
 * Production secret delivery is a host bind-mount, not putArchive.
 */
export function createPasswordTar(password: string, uid = 1000): Buffer {
  const content = Buffer.from(password, 'utf8');
  const header = Buffer.alloc(512);
  header.write('db_password', 0, 100, 'utf8');
  header.write('0000400\0', 100, 8, 'utf8');
  header.write(octal(uid, 7) + '\0', 108, 8, 'utf8');
  header.write(octal(uid, 7) + '\0', 116, 8, 'utf8');
  header.write(octal(content.length, 11) + '\0', 124, 12, 'utf8');
  header.write(octal(0, 11) + '\0', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write('0', 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');

  let checksum = 0;
  for (let i = 0; i < header.length; i += 1) {
    checksum += header[i] ?? 0;
  }
  header.write(octal(checksum, 6) + '\0 ', 148, 8, 'utf8');

  const pad =
    content.length % 512 === 0 ? 0 : 512 - (content.length % 512);
  return Buffer.concat([header, content, Buffer.alloc(pad), Buffer.alloc(1024)]);
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, '0');
}
