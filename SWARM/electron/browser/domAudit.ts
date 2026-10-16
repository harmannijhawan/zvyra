// DOM-based layout audit executed inside the page. Every issue is a measured fact
// (bounding boxes, computed styles, image load state), not a guess.
import type { Page } from 'playwright-core';

export interface DomIssue { severity: 'low' | 'medium' | 'high'; description: string; selector?: string }
export interface DomReport {
  issues: DomIssue[];
  metrics: { scrollWidth: number; innerWidth: number; textLength: number; images: number; brokenImages: number; links: number; headings: number; title: string; hasViewportMeta: boolean };
  internalLinks: string[];
}

export async function auditPage(page: Page, viewportName: string): Promise<DomReport> {
  return page.evaluate((vp) => {
    const issues: { severity: 'low' | 'medium' | 'high'; description: string; selector?: string }[] = [];
    const sel = (el: Element): string => {
      if (el.id) return `#${el.id}`;
      const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
    };
    const visible = (el: Element) => {
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05 && r.width > 0 && r.height > 0;
    };
    const iw = window.innerWidth;
    const doc = document.documentElement;
    // 1. Horizontal overflow.
    if (doc.scrollWidth > iw + 2) {
      const offenders: string[] = [];
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.right > iw + 2 && r.width > 0 && visible(el)) {
          const parentOver = el.parentElement && el.parentElement.getBoundingClientRect().right > iw + 2;
          if (!parentOver || el.parentElement === document.body) offenders.push(sel(el));
        }
        if (offenders.length >= 4) break;
      }
      issues.push({ severity: 'high', description: `[${vp}] Horizontal overflow: page is ${doc.scrollWidth}px wide in a ${iw}px viewport${offenders.length ? ` (overflowing: ${offenders.join(', ')})` : ''}`, selector: offenders[0] });
    }
    // 2. Broken images.
    const imgs = Array.from(document.images);
    const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0 && visible(i));
    if (broken.length) issues.push({ severity: 'medium', description: `[${vp}] ${broken.length} image(s) failed to load: ${broken.slice(0, 3).map((i) => i.getAttribute('src')).join(', ')}`, selector: sel(broken[0]) });
    // 3. Empty / near-empty page.
    const textLength = (document.body.innerText ?? '').trim().length;
    if (textLength < 40) issues.push({ severity: 'high', description: `[${vp}] Page renders almost no text (${textLength} characters) — likely a blank or crashed render` });
    // 4. Overlapping interactive elements.
    const interactive = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role=button]')).filter(visible).slice(0, 160);
    const rects = interactive.map((el) => ({ el, r: el.getBoundingClientRect() }));
    let overlaps = 0; const overlapSamples: string[] = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 2 || h <= 2) continue;
      const area = w * h, minArea = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (minArea > 0 && area / minArea > 0.35) { overlaps++; if (overlapSamples.length < 3) overlapSamples.push(`${sel(a.el)} × ${sel(b.el)}`); }
    }
    if (overlaps) issues.push({ severity: 'medium', description: `[${vp}] ${overlaps} overlapping interactive element pair(s): ${overlapSamples.join('; ')}` });
    // 5. Text clipped by its container.
    let clipped = 0; const clippedSamples: string[] = [];
    for (const el of Array.from(document.querySelectorAll('h1,h2,h3,p,a,button,span,li')).slice(0, 600)) {
      if (!visible(el) || !(el as HTMLElement).innerText?.trim()) continue;
      const st = getComputedStyle(el);
      const he = el as HTMLElement;
      if ((st.overflow === 'hidden' || st.overflowX === 'hidden') && st.textOverflow !== 'ellipsis' && he.scrollWidth > he.clientWidth + 4) { clipped++; if (clippedSamples.length < 3) clippedSamples.push(sel(el)); }
    }
    if (clipped) issues.push({ severity: 'low', description: `[${vp}] ${clipped} element(s) clip their text: ${clippedSamples.join(', ')}` });
    // 6. Tiny text.
    let tiny = 0;
    for (const el of Array.from(document.querySelectorAll('p,span,a,li,button,td,label')).slice(0, 800)) {
      if (!visible(el) || !(el as HTMLElement).innerText?.trim()) continue;
      if (parseFloat(getComputedStyle(el).fontSize) < 11) tiny++;
    }
    if (tiny > 3) issues.push({ severity: 'low', description: `[${vp}] ${tiny} text element(s) smaller than 11px` });
    // 7. Mobile tap targets.
    if (iw < 500) {
      const small = interactive.filter((el) => { const r = el.getBoundingClientRect(); return r.height < 24 && r.width < 24; });
      if (small.length > 2) issues.push({ severity: 'low', description: `[${vp}] ${small.length} tap target(s) smaller than 24×24px`, selector: sel(small[0]) });
    }
    // 8. Document basics.
    const hasViewportMeta = !!document.querySelector('meta[name=viewport]');
    if (!hasViewportMeta) issues.push({ severity: 'medium', description: `[${vp}] Missing <meta name="viewport"> — layout will not adapt on mobile` });
    if (!document.title.trim()) issues.push({ severity: 'low', description: `[${vp}] Document has no <title>` });
    const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const internalLinks = [...new Set(links.map((a) => a.href).filter((h) => h.startsWith(location.origin) && !h.includes('#') && h !== location.href))].slice(0, 20);
    return {
      issues,
      metrics: { scrollWidth: doc.scrollWidth, innerWidth: iw, textLength, images: imgs.length, brokenImages: broken.length, links: links.length, headings: document.querySelectorAll('h1,h2,h3').length, title: document.title, hasViewportMeta },
      internalLinks,
    };
  }, viewportName);
}
