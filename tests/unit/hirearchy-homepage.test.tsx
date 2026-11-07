import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import HomePage from '../../apps/web/app/page';
import ContactPage from '../../apps/web/app/contact/page';
import ProductsPage from '../../apps/web/app/products/page';
import SoftwarePage from '../../apps/web/app/products/software/page';
import ThinkingPage from '../../apps/web/app/thinking/page';
import AboutPage from '../../apps/web/app/about/page';

const pages = [
  HomePage,
  ContactPage,
  ProductsPage,
  SoftwarePage,
  ThinkingPage,
  AboutPage,
].map((Page) => ({ name: Page.name, Page }));
const routes = [
  '/',
  '/products',
  '/products/software',
  '/thinking',
  '/about',
  '/contact',
  '/privacy',
  '/terms',
];
describe('Hirearchy public website', () => {
  it.each(pages)(
    'provides complete semantic content and real destinations in $name without client execution',
    ({ Page }) => {
      const html = renderToStaticMarkup(createElement(Page));
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).toContain('id="main"');
      expect(html).toContain('Skip to content');
      for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
        if (href.startsWith('#'))
          expect(html).toContain(`id="${href.slice(1)}"`);
        else expect(routes).toContain(href.split(/[?#]/)[0]);
      }
      // The public site must not leak the evaluation vocabulary, the
      // competitor, or the retired brand names. Hirearchy and Hirearchy
      // Software are the site's own product-family names and are expected here.
      expect(html).not.toMatch(
        /candidate score|candidate ranking|Northwind|\bDelimit\b|\bSynco\b/i,
      );
    },
  );
  it('preserves the original headline and keeps future products explicit', () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain('Different work.<br/>One clear principle.');
    expect(html).toContain('A growing family<br/>for a changing world.');
    expect(html).toContain('Evidence informs.');
    expect(html).toContain('People decide.');
    expect(html).toContain('Hirearchy Software');
    expect(html.match(/Future direction/g)).toHaveLength(4);
    expect(html).not.toContain('<img');
  });
  it('does not present future products or an illustrative record as live evidence', () => {
    expect(renderToStaticMarkup(createElement(ProductsPage))).toContain(
      'not products available today',
    );
    const html = renderToStaticMarkup(createElement(SoftwarePage));
    expect(html).toContain('Illustrative task');
    expect(html).toContain('Illustrative record');
    expect(html).toContain('no automatic positive or negative judgement');
  });
  it('keeps buyer and demo requests closed without collecting personal data', () => {
    const html = renderToStaticMarkup(createElement(ContactPage));
    expect(html).toContain('Buyer and demo requests are not open yet.');
    expect(html).toContain('does not accept or store messages.');
    expect(html).not.toMatch(/<(form|input|textarea)\b/);
    expect(html).toContain('href="/products/software"');
    expect(html).toContain('href="/products/software#demo-limits"');
  });
});
