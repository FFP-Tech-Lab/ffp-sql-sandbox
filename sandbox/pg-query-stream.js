import { writeEvent as writeEventToStdout } from './events.js';

function columnNames(fields) {
  if (!Array.isArray(fields)) {
    return null;
  }
  return fields.map((field) => field.name);
}

/**
 * Stream a node-postgres Query as NDJSON runner events.
 *
 * node-postgres 8.x does not emit a `fields` event. Column metadata is on
 * `result.fields` when `row` / `end` fire. Keep a `fields` listener so older
 * emitters still work; emit `meta` at most once.
 */
export function streamPgQuery(query, client, limiter, writeEvent = writeEventToStdout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let metaSent = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const emitMeta = (fields) => {
      if (metaSent) {
        return;
      }
      const columns = columnNames(fields);
      if (columns === null) {
        return;
      }
      metaSent = true;
      writeEvent({ type: 'meta', columns });
    };

    query.on('fields', (fields) => {
      emitMeta(fields);
    });

    query.on('row', (row, result) => {
      if (settled) {
        return;
      }
      emitMeta(result?.fields);
      const decision = limiter.push(row);
      if (!decision.accept) {
        writeEvent({
          type: 'end',
          truncated: true,
          reason: decision.reason,
        });
        finish();
        client.connection?.stream?.destroy?.();
        return;
      }
      writeEvent({ type: 'row', values: row });
    });

    query.on('end', (result) => {
      if (settled) {
        return;
      }
      emitMeta(result?.fields);
      writeEvent({ type: 'end', truncated: false });
      finish();
    });

    query.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });

    client.query(query);
  });
}
