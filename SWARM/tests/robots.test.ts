import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots } from '../electron/research/robots';

const UA = 'SWARM-Research/1.0';

describe('robots.txt', () => {
  const groups = parseRobots(`
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*?session=
Disallow: /*.pdf$

User-agent: BadBot
Disallow: /
`);
  it('applies the wildcard group', () => {
    expect(isAllowed(groups, UA, '/')).toBe(true);
    expect(isAllowed(groups, UA, '/private/x')).toBe(false);
  });
  it('uses longest-match precedence', () => {
    expect(isAllowed(groups, UA, '/private/public/page')).toBe(true);
  });
  it('supports * and $ patterns', () => {
    expect(isAllowed(groups, UA, '/a?session=1')).toBe(false);
    expect(isAllowed(groups, UA, '/doc.pdf')).toBe(false);
    expect(isAllowed(groups, UA, '/doc.pdf?x=1')).toBe(true);
  });
  it('matches specific user agents', () => {
    expect(isAllowed(groups, 'BadBot/2.0', '/anything')).toBe(false);
  });
  it('treats an empty Disallow as allow-all', () => {
    expect(isAllowed(parseRobots('User-agent: *\nDisallow:'), UA, '/x')).toBe(true);
  });
});
