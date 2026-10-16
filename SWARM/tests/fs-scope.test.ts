import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, Notification: { isSupported: () => false } }));
import { resolveInProject, ScopeError } from '../electron/tools/fs';

const root = path.resolve('C:/work/project');

describe('filesystem scope', () => {
  it('resolves project-relative paths', () => {
    expect(resolveInProject(root, 'src/app.js')).toBe(path.join(root, 'src', 'app.js'));
    expect(resolveInProject(root, './public\\index.html')).toBe(path.join(root, 'public', 'index.html'));
    expect(resolveInProject(root, '/src/app.js')).toBe(path.join(root, 'src', 'app.js'));
  });
  it('refuses escapes', () => {
    expect(() => resolveInProject(root, '../other/x')).toThrow(ScopeError);
    expect(() => resolveInProject(root, 'C:/Windows/system.ini')).toThrow(ScopeError);
    expect(() => resolveInProject(root, 'src/../../x')).toThrow(ScopeError);
  });
  it('allows a wider workspace scope when configured', () => {
    const ws = path.resolve('C:/work');
    expect(resolveInProject(root, '../sibling/file.txt', ws)).toBe(path.join(ws, 'sibling', 'file.txt'));
    expect(() => resolveInProject(root, '../../outside.txt', ws)).toThrow(ScopeError);
  });
});
