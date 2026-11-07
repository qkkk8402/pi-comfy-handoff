import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagerLogger, safeEndpoint } from '../src/logger.js';

test('manager logger applies levels, timestamps lines, and keeps endpoints credential-free', () => {
  const lines: string[] = [];
  const logger = new ManagerLogger('info', line => lines.push(line));
  logger.log('debug', 'hidden');
  logger.log('info', 'visible\nsecond-line');
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\d{4}-\d\d-\d\dT.* INFO visible second-line$/);
  assert.equal(safeEndpoint('https://user:secret@example.test/prefix?token=secret#fragment'), 'https://example.test');
  assert.equal(safeEndpoint('not a url'), '<endpoint>');
});

test('silent logger and a failing sink do not throw', () => {
  const lines: string[] = [];
  assert.doesNotThrow(() => new ManagerLogger('silent', line => lines.push(line)).log('error', 'hidden'));
  assert.deepEqual(lines, []);
  assert.doesNotThrow(() => new ManagerLogger('error', () => { throw new Error('sink failed'); }).log('error', 'visible'));
});
