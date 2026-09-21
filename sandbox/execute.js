import { stdin } from 'node:process';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { createStreamLimiter } from './stream-limit.js';
import { sessionSetupStatements } from './session-setup.js';
import { readPassword } from './secrets.js';
import { writeRunnerError } from './events.js';
import { streamPgQuery } from './pg-query-stream.js';
import {
  closeMysqlConnection,
  runMysqlQuery,
} from './mysql-query-stream.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
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
  const query = new pg.Query({ text: sql, rowMode: 'array' });
  return streamPgQuery(query, client, limiter);
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
    await runMysqlQuery(conn, sql, timeoutMs, limiter);
  } finally {
    await closeMysqlConnection(conn);
  }
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
    password: readPassword(),
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
  writeRunnerError(err);
  process.exit(1);
});
