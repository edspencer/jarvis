// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ICONS, iconSvg, sanitizeSvg } from '../../src/ui/icons';

// what reaches the page: the sanitised string, parsed the way unsafeSVG parses it (as HTML)
function parsed(svg: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = svg;
  return host;
}
const DANGEROUS = (host: HTMLElement) => {
  const all = [host, ...Array.from(host.querySelectorAll('*'))];
  const bad: string[] = [];
  for (const el of all) {
    if (
      /^(script|style|use|image|foreignobject|a|iframe|animate|set|animatetransform|animatemotion|feimage)$/i.test(
        el.localName,
      )
    )
      bad.push(el.localName);
    for (const a of Array.from(el.attributes))
      if (/^on|href$|^style$|^src$/i.test(a.localName) || /javascript:|data:|url\((?!#)/i.test(a.value))
        bad.push(`${el.localName}@${a.name}=${a.value}`);
  }
  return bad;
};

describe("a plugin's SVG icon", () => {
  it('keeps drawing elements and presentation attributes', () => {
    const out = sanitizeSvg(
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><g transform="translate(1 1)"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5" stroke-linecap="round"/></g></svg>',
    )!;
    const svg = parsed(out).querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelector('circle')!.getAttribute('r')).toBe('6.5');
    expect(svg.querySelector('path')!.getAttribute('d')).toBe('M16 16l4.5 4.5');
    expect(svg.querySelector('g')!.getAttribute('transform')).toBe('translate(1 1)');
  });

  it('keeps gradients referenced inside the icon', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect width="24" height="24" fill="url(#g)"/></svg>',
    )!;
    expect(out).toContain('<linearGradient id="g">');
    expect(out).toContain('fill="url(#g)"');
  });

  // known vectors: none of them may leave anything that runs, loads or styles
  const vectors = [
    '<svg/onload=alert(1)>',
    '<svg onload="alert(1)"><path d="M0 0"/></svg>',
    '<svg\nonload="alert(1)"></svg>',
    '<svg><script>alert(1)</script></svg>',
    '<svg><script href="data:text/javascript,alert(1)"/></svg>',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use href="data:image/svg+xml;base64,PHN2Zy8+#x"/></svg>',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.example/x.svg#a"/></svg>',
    '<svg><style>@import url(https://evil.example/x.css);</style></svg>',
    '<svg><path style="fill:url(https://evil.example/t)" d="M0 0"/></svg>',
    '<svg><path fill="url(https://evil.example/t)" d="M0 0"/></svg>',
    '<svg><a href="javascript:alert(1)"><rect width="24" height="24"/></a></svg>',
    '<svg><image href="https://evil.example/track.png"/></svg>',
    '<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>',
    '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject></svg>',
    '<svg><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onmouseover" to="alert(1)"/></svg>',
    '<svg><rect width="24" height="24"><animate attributeName="onbegin" values="alert(1)" begin="0s"/></rect></svg>',
    '<svg><g onclick="alert(1)"><rect ONMOUSEOVER="alert(1)" width="1" height="1"/></g></svg>',
    '<svg><filter><feImage href="https://evil.example/x"/></filter></svg>',
    '<svg><title><![CDATA[</title><script>alert(1)</script>]]></title></svg>',
    '<svg><desc>&lt;img src=x onerror=alert(1)&gt;</desc></svg>',
    '<svg><x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script></svg>',
    '<svg><html:script xmlns:html="http://www.w3.org/1999/xhtml">alert(1)</html:script></svg>',
    '<svg><path d="M0 0" xlink:href="javascript:alert(1)" xmlns:xlink="http://www.w3.org/1999/xlink"/></svg>',
    '<svg><rect width="1" height="1" fill="&#x6A;avascript:alert(1)"/></svg>',
    '<svg><rect id="x&quot; onload=&quot;alert(1)" width="1" height="1"/></svg>',
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><svg>&x;</svg>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<div><svg onload="alert(1)"/></div>',
  ];
  for (const v of vectors)
    it(`neutralises ${JSON.stringify(v).slice(0, 90)}`, () => {
      const out = iconSvg(v);
      expect(DANGEROUS(parsed(out))).toEqual([]);
      // (payloads may survive as escaped text or attribute values: inert)
    });

  it('falls back to the cube for markup that is not an SVG or does not parse', () => {
    expect(iconSvg('<svg/onload=alert(1)>')).toBe(ICONS.cube);
    expect(iconSvg('<div>hi</div>')).toBe(ICONS.cube);
    expect(iconSvg('<svg><path d="M0 0"></svg>')).toBe(ICONS.cube);
  });

  it('falls back to the cube when the sanitiser drops the whole icon (an <svg> in another namespace)', () => {
    const odd = '<svg xmlns="http://www.w3.org/1999/xhtml"><path d="M0 0"/></svg>';
    expect(sanitizeSvg(odd)).toBeNull();
    expect(iconSvg(odd)).toBe(ICONS.cube);
  });

  it('names still resolve, unknown names give the cube', () => {
    expect(iconSvg('search')).toBe(ICONS.search);
    expect(iconSvg('nope')).toBe(ICONS.cube);
    expect(iconSvg(undefined)).toBe('');
  });

  it('every core icon survives the sanitiser with the same drawing', () => {
    for (const [name, svg] of Object.entries(ICONS)) {
      const a = parsed(svg).querySelector('svg')!,
        b = parsed(sanitizeSvg(svg)!).querySelector('svg')!;
      expect(b.innerHTML.replace(/\s+/g, ''), name).toBe(a.innerHTML.replace(/\s+/g, ''));
    }
  });
});
