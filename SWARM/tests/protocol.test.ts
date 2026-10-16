import { describe, expect, it } from 'vitest';
import { parseActions } from '../electron/agents/protocol';
import { extractJson, repairTruncatedJson } from '../electron/core/util';

describe('action protocol', () => {
  it('parses writes, edits, reads, runs and done in order', () => {
    const r = parseActions(`I'll create the server.
<write path="server.js">
\`\`\`js
const x = 1;
\`\`\`
</write>
<edit path="public/app.js"><find>old()</find><replace>next()</replace></edit>
<read path="package.json"/>
<run>npm test</run>
<message to="tester">ready</message>
<done>Implemented server</done>`);
    expect(r.actions.map((a) => a.type)).toEqual(['write', 'edit', 'read', 'run', 'message', 'done']);
    const w = r.actions[0] as { content: string; path: string };
    expect(w.path).toBe('server.js');
    expect(w.content).toBe('const x = 1;\n');
    expect(r.truncatedWrite).toBeNull();
  });
  it('does not treat tags inside written file content as actions', () => {
    const r = parseActions('<write path="a.html"><p>Use <run> tags</p>\n<done>not me</done></write><done>ok</done>');
    expect(r.actions.filter((a) => a.type === 'done')).toHaveLength(1);
  });
  it('detects truncated writes', () => {
    const r = parseActions('<write path="big.css">body { color: red;');
    expect(r.truncatedWrite).toBe('big.css');
    expect(r.actions).toHaveLength(0);
  });
  it('falls back to path-labelled code fences', () => {
    const r = parseActions('**index.html**\n```html\n<h1>Hi</h1>\n```');
    expect(r.actions[0]).toMatchObject({ type: 'write', path: 'index.html' });
  });
  it('ignores <think> blocks', () => {
    expect(parseActions('<think><run>rm -rf x</run></think><done>ok</done>').actions).toEqual([{ type: 'done', summary: 'ok' }]);
  });
});

describe('JSON extraction', () => {
  it('extracts JSON from fenced output with reasoning', () => {
    expect(extractJson('<think>hmm</think>Here:\n```json\n{"a": [1, 2]}\n```')).toEqual({ a: [1, 2] });
  });
  it('tolerates trailing commas', () => {
    expect(extractJson('{"a": 1, "b": [1,2,],}')).toEqual({ a: 1, b: [1, 2] });
  });
  it('repairs output truncated by the token limit', () => {
    const v = repairTruncatedJson('{"tasks": [{"key": "a", "title": "A"}, {"key": "b", "tit') as { tasks: unknown[] };
    expect(v.tasks).toEqual([{ key: 'a', title: 'A' }]);
  });
  it('throws when there is no JSON at all', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});
