import { writeEvent as writeEventToStdout } from './events.js';
import {
  isQueryTimeoutError,
  queryTimeoutError,
  startQueryWatchdog,
} from './query-watchdog.js';

const MYSQL_END_GRACE_MS = 200;

/**
 * Stream a mysql2 query as NDJSON runner events.
 * Column metadata comes from the mysql2 `fields` event.
 */
export function streamMysqlQuery(
  query,
  connection,
  limiter,
  writeEvent = writeEventToStdout,
) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    query.on('fields', (fields) => {
      const columns = (fields ?? []).map((field) => field.name);
      writeEvent({ type: 'meta', columns });
    });

    query.on('result', (row) => {
      if (settled) {
        return;
      }
      const values = Array.isArray(row) ? row : Object.values(row);
      const decision = limiter.push(values);
      if (!decision.accept) {
        writeEvent({
          type: 'end',
          truncated: true,
          reason: decision.reason,
        });
        connection.destroy();
        finish();
        return;
      }
      writeEvent({ type: 'row', values });
    });

    query.on('end', () => {
      if (!settled) {
        writeEvent({ type: 'end', truncated: false });
        finish();
      }
    });

    query.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });
  });
}

/**
 * Wall-clock QUERY_TIMEOUT around a mysql2 stream.
 * MAX_EXECUTION_TIME does not interrupt SLEEP(); destroying the socket does.
 */
export async function runMysqlQuery(
  conn,
  sql,
  timeoutMs,
  limiter,
  writeEvent = writeEventToStdout,
) {
  const connection = conn.connection;
  let timedOut = false;
  const clear = startQueryWatchdog(timeoutMs, () => {
    timedOut = true;
    try {
      connection.destroy();
    } catch {
      // ignore
    }
  });
  try {
    const query = connection.query({ sql, rowsAsArray: true });
    await streamMysqlQuery(query, connection, limiter, writeEvent);
    if (timedOut) {
      throw queryTimeoutError(timeoutMs);
    }
  } catch (err) {
    if (timedOut || isQueryTimeoutError(err)) {
      throw queryTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clear();
  }
}

/**
 * mysql2 `end()` can hang after destroy() (truncation / timeout). Fail closed
 * onto destroy so the runner process can exit and the host can demux a
 * complete NDJSON stream.
 */
export async function closeMysqlConnection(conn) {
  const destroy = () => {
    try {
      conn.destroy?.();
    } catch {
      // ignore
    }
  };
  if (typeof conn.end !== 'function') {
    destroy();
    return;
  }
  let timer;
  try {
    await Promise.race([
      Promise.resolve(conn.end()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('mysql end timeout')),
          MYSQL_END_GRACE_MS,
        );
      }),
    ]);
  } catch {
    destroy();
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
