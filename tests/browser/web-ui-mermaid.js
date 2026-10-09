// Run against a fresh tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async page => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors = [];
  const external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content-Security-Policy|Refused to apply/.test(message.text())) errors.push(message.text()); });
  page.on('request', request => { if (!request.url().startsWith(new URL(page.url()).origin) && !request.url().startsWith('data:')) external.push(request.url()); });
  const flow = 'flowchart LR\n  A[Start] --> B{Ready?}\n  B -->|Yes| C[Ship]\n  B -->|No| A';
  const invalid = 'flowchart LR\n A[unfinished';
  const sequence = 'sequenceDiagram\n Alice->>Bob: Hello';
  const oversized = 'flowchart LR\n%%' + 'x'.repeat(50_000);
  const hostile = '%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n A[Safe] --> B[End]\n click A "https://example.com/diagram-link"';
  const fence = code => '```mermaid\n' + code + '\n```';
  await page.route('**/api/v1/conversations/*/turns?*', async route => {
    const response = await route.fetch();
    const history = await response.json();
    history.data = history.data.slice(0, 1);
    history.data[0].items = [{ id: 'mermaid-checks', type: 'agentMessage', phase: 'final_answer', text: [flow, invalid, sequence, hostile, oversized].map(fence).join('\n\n') }];
    await route.fulfill({ response, json: history });
  });
  await page.reload();
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  const blocks = page.locator('.message-assistant .mermaid-block');
  await blocks.nth(3).getByRole('img', { name: 'Mermaid diagram', exact: true }).waitFor();
  await blocks.nth(1).getByText('Diagram unavailable. Showing source.', { exact: true }).waitFor();
  if (await blocks.nth(1).locator('code').innerText() !== invalid) throw Error('Invalid diagram lost source');
  await blocks.nth(4).getByText('Diagram unavailable. Showing source.', { exact: true }).waitFor();
  if (await blocks.nth(4).locator('img').count() || await blocks.nth(4).locator('code').innerText() !== oversized) throw Error('Oversized diagram did not preserve source');
  const urls = await blocks.locator('img').evaluateAll(images => images.map(img => img.src));
  if (urls.length !== 3 || new Set(urls).size !== 3) throw Error('Multiple diagrams collided');
  const parsed = await page.evaluate(urls => urls.map(url => {
    const svg = new DOMParser().parseFromString(decodeURIComponent(url.split(',')[1]), 'image/svg+xml');
    return { text: svg.documentElement.textContent, links: svg.querySelectorAll('a').length, scripts: svg.querySelectorAll('script').length };
  }), urls);
  if (!parsed[0].text.includes('Ready?') || !parsed[1].text.includes('Hello')) throw Error('Diagram labels missing');
  if (parsed.some(svg => svg.links || svg.scripts)) throw Error('Diagram enabled links or scripts');
  await page.waitForFunction(() => [...document.querySelectorAll('.mermaid-block img')].every(img => img.complete && img.naturalWidth > 0));
  await blocks.first().getByRole('button', { name: 'Show source', exact: true }).click();
  if (await blocks.first().locator('code').innerText() !== flow) throw Error('Source toggle changed diagram code');
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.copiedDiagram = text; } }));
  await blocks.first().getByRole('button', { name: 'Copy code', exact: true }).click();
  await blocks.first().getByText('Copied', { exact: true }).waitFor();
  if (await page.evaluate(() => window.copiedDiagram) !== flow) throw Error('Diagram copy changed source');
  await blocks.first().getByRole('button', { name: 'Show diagram', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  await page.unroute('**/api/v1/conversations/*/turns?*');
  await composer.fill('mermaid streaming');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const streaming = page.locator('.message-assistant').last();
  await streaming.locator('code').filter({ hasText: 'A[Start] --> B[' }).waitFor();
  if (!await page.getByRole('button', { name: 'Interrupt response', exact: true }).isVisible()) throw Error('Diagram source did not appear while streaming');
  await streaming.getByRole('img', { name: 'Mermaid diagram', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Interrupt response', exact: true }).waitFor({ state: 'hidden' });
  await streaming.getByRole('button', { name: 'Show source', exact: true }).click();
  if (await streaming.locator('code').innerText() !== 'flowchart LR\n A[Start] --> B[Ship]') throw Error('Streamed diagram retained stale source');
  await composer.fill(fence(invalid));
  await page.getByRole('button', { name: 'Preview draft', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Draft preview', exact: true });
  await preview.getByText('Diagram unavailable. Showing source.', { exact: true }).waitFor();
  await preview.getByRole('button', { name: 'Back to editing', exact: true }).click();
  await composer.fill(fence(flow));
  await page.getByRole('button', { name: 'Preview draft', exact: true }).click();
  await preview.getByRole('img', { name: 'Mermaid diagram', exact: true }).waitFor();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    const fits = await preview.locator('.mermaid-block').evaluate(el => el.getBoundingClientRect().right <= innerWidth);
    if (!fits) throw Error('Diagram overflowed draft preview');
  }
  await preview.getByRole('button', { name: 'Back to editing', exact: true }).click();
  if (await composer.inputValue() !== fence(flow)) throw Error('Preview changed draft');
  // PR #88 shares the transcript with pending questions. Diagrams must stay
  // available while a blocking question pauses the working indicators.
  await composer.fill('Show a provider question example');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const questions = page.getByRole('form', { name: 'Questions from Shepherd', exact: true });
  await questions.getByText('Waiting for your answer', { exact: true }).waitFor();
  if (await questions.getByRole('radio', { checked: true }).count()) throw Error('Question selected an answer automatically');
  if (await questions.getByRole('button', { name: 'Submit answers', exact: true }).isEnabled()) throw Error('Unanswered question can submit');
  if (await page.getByText('Writing…', { exact: true }).count()) throw Error('Writing indicator remained while waiting for an answer');
  if (await page.locator('.message-assistant .mermaid-block img').count() < 1) throw Error('Pending question displaced diagrams');
  await questions.getByRole('radio', { name: /Select per conversation/ }).check();
  await questions.getByRole('button', { name: 'Submit answers', exact: true }).click();
  await questions.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Interrupt response', exact: true }).waitFor({ state: 'hidden' });
  if (await page.locator('body > div[id^="dshepherd-diagram-"]').count()) throw Error('Mermaid leaked a temporary render container');
  if (errors.length || external.length) throw Error([...errors, ...external].join('\n'));
  return 'Mermaid diagrams, isolated rendering, invalid/oversized fallback, source toggle/copy, streaming, mobile drafts, and PR #88 blocking questions passed';
}
