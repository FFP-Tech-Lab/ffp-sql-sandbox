import { readFileSync } from 'node:fs';
import { stdin, stdout, stderr } from 'node:process';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { createStreamLimiter } from './stream-limit.js';
import { sessionSetupStatements } from './session-setup.js';

const SECRET_PATH = '/run/secrets/db_password';

function writeEvent(event) {
  stdout.write(JSON.stringify(event) + '\n');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readPassword(payload) {
  try {
    return readFileSync(SECRET_PATH, 'utf8');
  } catch {
    if (typeof payload.password === 'string' && payload.password.length > 0) {
      return payload.password;
    }
    throw new Error('Database password missing (expected tmpfs secret file)');
  }
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function dialectFromEnv() {
  const raw = (process.env.DB_TYPE ?? 'postgres').toLowerCase();
  if (raw === 'postgres' || raw === 'postgresql') {
    return 'postgres';
  }
  if (raw === 'mysql') {
    return 'mysql';
  }
  throw new Error(`Unsupported DB_TYPE: ${raw}`);
}

async function runPostgres({ host, port, user, password, database, sql, timeoutMs, limiter }) {
  const client = new pg.Client({
    host,
    port,
    user,
    password,
    database,
    statement_timeout: timeoutMs,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    for (const statement of sessionSetupStatements('postgres', timeoutMs)) {
      await client.query(statement);
    }
    await streamPg(client, sql, limiter);
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

function streamPg(client, sql, limiter) {
  return new Promise((resolve, reject) => {
    const query = new pg.Query({ text: sql, rowMode: 'array' });
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    query.on('fields', (fields) => {
      writeEvent({ type: 'meta', columns: fields.map((field) => field.name) });
    });

    query.on('row', (row) => {
      if (settled) {
        return;
      }
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

    query.on('end', () => {
      if (settled) {
        return;
      }
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

async function runMysql({ host, port, user, password, database, sql, timeoutMs, limiter }) {
  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    connectTimeout: 5_000,
  });
  try {
    for (const statement of sessionSetupStatements('mysql', timeoutMs)) {
      await conn.query(statement);
    }
    await streamMysql(conn, sql, limiter);
  } finally {
    try {
      await conn.end();
    } catch {
      conn.destroy();
    }
  }
}

function streamMysql(conn, sql, limiter) {
  return new Promise((resolve, reject) => {
    const connection = conn.connection;
    const query = connection.query({ sql, rowsAsArray: true });
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

async function main() {
  const raw = await readStdin();
  let payload = {};
  if (raw.trim().length > 0) {
    payload = JSON.parse(raw);
  }
  const sql = payload.sql;
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('No SQL provided on stdin');
  }

  const timeoutMs = envInt('QUERY_TIMEOUT', 10_000);
  const maxRows = envInt('MAX_ROWS', 1_000);
  const maxBytes = envInt('MAX_BYTES', 1_000_000);
  const limiter = createStreamLimiter({ maxRows, maxBytes });
  const dialect = dialectFromEnv();
  const connection = {
    host: process.env.DB_HOST,
    port: envInt('DB_PORT', dialect === 'mysql' ? 3306 : 5432),
    user: process.env.DB_USER,
    password: readPassword(payload),
    database: process.env.DB_NAME,
    sql,
    timeoutMs,
    limiter,
  };

  if (dialect === 'mysql') {
    await runMysql(connection);
    return;
  }
  await runPostgres(connection);
}

main().catch((err) => {
  stderr.write(JSON.stringify({ type: 'error', error: err.message }) + '\n');
  process.exit(1);
});
