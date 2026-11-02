import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readProjectJson, writeProjectJson } from '../src/files.js';

test('workflow files reject paths and symlinks outside the project and replace files atomically', async () => {
  await mkdir('work', { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), 'work', 'files-'));
  const project = join(directory, 'project');
  const outside = join(directory, 'outside');
  await mkdir(project); await mkdir(outside);
  try {
    await writeProjectJson(project, 'workflow.json', { value: 1 });
    assert.deepEqual(await readProjectJson(project, 'workflow.json'), { value: 1 });
    await assert.rejects(writeProjectJson(project, '../outside/no.json', {}), /inside/);
    await writeProjectJson(outside, 'outside.json', { value: 'outside' });
    await symlink(join(outside, 'outside.json'), join(project, 'link.json'));
    await assert.rejects(readProjectJson(project, 'link.json'), /inside/);
    await writeProjectJson(project, 'link.json', { replaced: true });
    assert.deepEqual(JSON.parse(await readFile(join(outside, 'outside.json'), 'utf8')), { value: 'outside' });
    await symlink(outside, join(project, 'directory'));
    await assert.rejects(writeProjectJson(project, 'directory/no.json', {}), /inside/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
