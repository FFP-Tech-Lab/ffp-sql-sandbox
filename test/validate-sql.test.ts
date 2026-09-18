import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateSql } from '../src/index.js';

describe('validateSql allowlist', () => {
  it('accepts SELECT / WITH / SHOW / DESCRIBE / EXPLAIN, including leading whitespace and case folding', () => {
    assert.deepEqual(validateSql('SELECT 1'), { ok: true });
    assert.deepEqual(validateSql('  select id from orders'), { ok: true });
    assert.deepEqual(
      validateSql('WITH cte AS (SELECT 1 AS x) SELECT * FROM cte'),
      { ok: true },
    );
    assert.deepEqual(validateSql('\n\tshow tables'), { ok: true });
    assert.deepEqual(validateSql('DESCRIBE users'), { ok: true });
    assert.deepEqual(validateSql('EXPLAIN SELECT * FROM orders'), { ok: true });
    assert.deepEqual(validateSql('EXPLAIN ANALYZE SELECT 1'), { ok: true });
  });

  it('accepts a trailing semicolon with no following statement', () => {
    assert.deepEqual(validateSql('SELECT 1;'), { ok: true });
  });

  it('does not treat substrings of allowed identifiers as DML/DDL', () => {
    assert.deepEqual(validateSql('SELECT created_at, updated_at FROM orders'), {
      ok: true,
    });
    assert.deepEqual(validateSql('SELECT inserted_at FROM events'), {
      ok: true,
    });
    assert.deepEqual(validateSql("SELECT * FROM t WHERE status = 'deleted'"), {
      ok: true,
    });
  });
});

describe('validateSql prefix rejection', () => {
  it('rejects empty input and statements outside the allowlist', () => {
    const empty = validateSql('');
    assert.equal(empty.ok, false);
    if (!empty.ok) {
      assert.equal(empty.code, 'NOT_READ_ONLY_PREFIX');
    }

    const whitespace = validateSql('   ');
    assert.equal(whitespace.ok, false);
    if (!whitespace.ok) {
      assert.equal(whitespace.code, 'NOT_READ_ONLY_PREFIX');
    }

    const callStmt = validateSql('CALL do_something()');
    assert.equal(callStmt.ok, false);
    if (!callStmt.ok) {
      assert.equal(callStmt.code, 'NOT_READ_ONLY_PREFIX');
    }

    const commentPrefix = validateSql('-- SELECT 1\nSELECT 1');
    assert.equal(commentPrefix.ok, false);
    if (!commentPrefix.ok) {
      assert.equal(commentPrefix.code, 'NOT_READ_ONLY_PREFIX');
    }
  });
});

describe('validateSql write and multi-statement rejection', () => {
  it('rejects DML and DDL even when they use an allowed prefix', () => {
    const writes = [
      'INSERT INTO t VALUES (1)',
      'DELETE FROM t',
      'UPDATE t SET a = 1',
      'DROP TABLE t',
      'ALTER TABLE t ADD col int',
      'TRUNCATE TABLE t',
      'CREATE TABLE t (id int)',
      'GRANT SELECT ON t TO u',
      'REVOKE SELECT ON t FROM u',
    ];
    for (const sql of writes) {
      const result = validateSql(sql);
      assert.equal(result.ok, false, sql);
      if (!result.ok) {
        assert.equal(result.code, 'NOT_READ_ONLY_PREFIX', sql);
      }
    }
  });

  it('rejects forbidden keywords embedded after an allowed prefix', () => {
    const updateLiteral = validateSql("SELECT * FROM t WHERE action = 'UPDATE'");
    assert.equal(updateLiteral.ok, false);
    if (!updateLiteral.ok) {
      assert.equal(updateLiteral.code, 'FORBIDDEN_KEYWORD');
    }

    const dropAfterSelect = validateSql('SELECT 1; DROP TABLE t');
    assert.equal(dropAfterSelect.ok, false);
    if (!dropAfterSelect.ok) {
      assert.match(dropAfterSelect.code, /FORBIDDEN_KEYWORD|MULTI_STATEMENT/);
    }
  });

  it('rejects EXEC / EXECUTE / xp_ after an allowed prefix', () => {
    for (const sql of [
      'SELECT EXEC("x")',
      'SELECT 1 FROM t WHERE fn = EXECUTE',
      'SELECT xp_ FROM t',
    ]) {
      const result = validateSql(sql);
      assert.equal(result.ok, false, sql);
      if (!result.ok) {
        assert.equal(result.code, 'FORBIDDEN_KEYWORD', sql);
      }
    }
  });

  it('rejects a second statement after a semicolon', () => {
    const twoSelects = validateSql('SELECT 1; SELECT 2');
    assert.equal(twoSelects.ok, false);
    if (!twoSelects.ok) {
      assert.equal(twoSelects.code, 'MULTI_STATEMENT');
      assert.match(twoSelects.reason, /multi-statement/i);
    }

    const twoShows = validateSql('SHOW TABLES;\nSHOW DATABASES');
    assert.equal(twoShows.ok, false);
    if (!twoShows.ok) {
      assert.equal(twoShows.code, 'MULTI_STATEMENT');
    }
  });
});

describe('validateSql has no configurable bypass options', () => {
  it('accepts only the sql string (fail-fast; no allow/forbid options)', () => {
    assert.equal(validateSql.length, 1);
    const result = validateSql('SELECT 1');
    assert.deepEqual(result, { ok: true });
  });
});
