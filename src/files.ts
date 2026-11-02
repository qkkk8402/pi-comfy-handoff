import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

function inside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Workflow path must remain inside the current project');
}
export async function readProjectJson(cwd: string, filename: string): Promise<unknown> {
  const path = await projectFile(cwd, filename);
  if ((await stat(path)).size > 10 * 1024 * 1024) throw new Error('Workflow JSON exceeds 10 MiB');
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function projectFile(cwd: string, filename: string): Promise<string> {
  const root = await realpath(cwd);
  const path = await realpath(resolve(root, filename));
  inside(root, path);
  return path;
}
export async function writeProjectJson(cwd: string, filename: string, data: unknown): Promise<string> {
  const root = await realpath(cwd);
  const target = resolve(root, filename);
  inside(root, target);
  inside(root, await realpath(dirname(target)));
  // Atomic replacement replaces an existing symlink rather than following it.
  const temporary = resolve(dirname(target), `.${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
  return target;
}
