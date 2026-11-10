import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ScenarioBrief } from '../../apps/web/src/ui/scenario-brief';

const approvedBrief = readFileSync(
  new URL(
    '../../docs/scenarios/examples/reservation-moves/README.md',
    import.meta.url,
  ),
  'utf8',
);

describe('ScenarioBrief', () => {
  it('preserves the approved task contract and renders its block and inline syntax', () => {
    const html = renderToStaticMarkup(
      <ScenarioBrief markdown={approvedBrief} />,
    );

    expect(html).toContain('<h2>A retry moved the booking backwards</h2>');
    expect(html).toContain('<h3>Public contract</h3>');
    expect(html).toContain('<h3>Incident sequence</h3>');
    expect(html).not.toContain('<h1');
    expect(html).toContain('<strong>Your task:</strong>');
    expect(html).toContain('<code>move(state, sender, account');
    expect(html).toContain('<ol>');
    expect(html).toContain('<ul>');
    expect(html).toContain(
      'Slot capacities are global across accounts. Fixtures start consistent.',
    );
    expect(html).toContain(
      'Unknown reservation or destination rejects with ValueError before any state change or sender call.',
    );
    expect(html).toContain(
      'A TimeoutError propagates; the accepted move stays committed even when that attempt delivered nothing.',
    );
    expect(html).toContain(
      'Retry <code>first</code>: the booking must remain in C, but return the original A -&gt; B receipt.',
    );
  });

  it('renders fenced and inline code as text and escapes raw HTML', () => {
    const markdown = [
      'Use **bold**, *emphasis*, and `inline <script>`.',
      '',
      '```python',
      'print("<script>alert(1)</script>")',
      '```',
      '',
      '- item **one**',
      '- item two',
      '',
      '### Use C# correctly',
      '',
      'Unparsed [links](https://example.test) and ![images](x.png) stay text.',
    ].join('\n');
    const html = renderToStaticMarkup(<ScenarioBrief markdown={markdown} />);

    expect(html).toContain('tabindex="0" aria-label="Task brief code"');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>emphasis</em>');
    expect(html).toContain('<h4>Use C# correctly</h4>');
    expect(html).toContain('<code>inline &lt;script&gt;</code>');
    expect(html).toContain(
      '<code>print(&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;)</code></pre>',
    );
    expect(html).toContain(
      '<ul><li>item <strong>one</strong></li><li>item two</li></ul>',
    );
    expect(html).toContain(
      'Unparsed [links](https://example.test) and ![images](x.png) stay text.',
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img ');
  });
});
