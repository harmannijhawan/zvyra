const UA = 'SWARM-Research/1.0 (+desktop; respectful bot)';
for (const u of ['https://search.brave.com/robots.txt', 'https://www.startpage.com/robots.txt', 'https://www.qwant.com/robots.txt', 'https://search.yahoo.com/robots.txt', 'https://www.ecosia.org/robots.txt', 'https://www.bing.com/robots.txt']) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    const t = await r.text();
    const lines = t.split('\n').filter((l) => /user-agent: \*|search|^disallow: \/$|allow: \/\?/i.test(l)).slice(0, 12);
    console.log('==', u, r.status, '\n  ' + lines.join('\n  '));
  } catch (e) { console.log(u, e.message); }
}
