// Run against a fresh tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async page => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const code = 'const answer = 42;';
  const markdown = '## Markdown checks\n\nInline `const x = 1`.\n\n```ts\n' + code + '\n```\n\n```unknown-language\n<tag>literal</tag>\n```\n\n```\nplain text\n```';
  await page.route('**/api/conversations/*/turns?*', async route => {
    const response = await route.fetch();
    const history = await response.json();
    history.data[0].items = [{ id: 'markdown-checks', type: 'agentMessage', phase: 'final_answer', text: markdown }];
    await route.fulfill({ response, json: history });
  });
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  const blocks = page.locator('.message-assistant .code-block');
  await blocks.nth(2).waitFor();
  await blocks.first().locator('.hljs-keyword').waitFor();
  if (await blocks.count() !== 3) throw Error('Inline code became a code block');
  if (await blocks.nth(1).locator('code').innerText() !== '<tag>literal</tag>') throw Error('Unknown language lost literal code');
  if (await blocks.nth(1).locator('tag').count()) throw Error('Code was rendered as HTML');
  if (await blocks.nth(2).locator('code').innerText() !== 'plain text') throw Error('Plain code block changed');
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.copiedCode = text; } }));
  await blocks.first().getByRole('button', { name: 'Copy code', exact: true }).click();
  await blocks.first().getByText('Copied', { exact: true }).waitFor();
  if (await page.evaluate(() => window.copiedCode) !== code) throw Error('Copy included the toolbar or markup');
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw Error('Clipboard denied'); } }));
  await blocks.first().getByRole('button', { name: 'Copy code', exact: true }).click();
  await blocks.first().getByText('Could not copy', { exact: true }).waitFor();
  await page.unroute('**/api/conversations/*/turns?*');
  const composer = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  await composer.fill('markdown streaming');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const streaming = page.locator('.message-assistant').last();
  // These assertions occur before message completion; the fence is still open.
  await streaming.getByRole('heading', { name: 'Streaming Markdown', exact: true }).waitFor();
  if (!await page.getByRole('button', { name: 'Interrupt response', exact: true }).isVisible()) throw Error('Markdown only appeared after completion');
  await streaming.locator('strong').filter({ hasText: 'Formatted while writing.' }).waitFor();
  await streaming.locator('pre').filter({ hasText: 'const answer =' }).waitFor();
  await page.getByRole('button', { name: 'Interrupt response', exact: true }).waitFor({ state: 'hidden' });
  await streaming.locator('.hljs-number').waitFor();
  if (await streaming.locator('code').innerText() !== code) throw Error('Streaming fence did not settle into final code');
  await page.setViewportSize({ width: 390, height: 844 });
  await composer.fill('## My draft\n\n**Ready to review.** Reference[^note].\n\n```ts\nconst draft = true;\n```\n\n[^note]: A draft footnote.');
  const draft = await composer.inputValue();
  await page.getByRole('button', { name: 'Preview draft', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Draft preview', exact: true });
  await preview.getByRole('heading', { name: 'My draft', exact: true }).waitFor();
  await preview.locator('.hljs-keyword').waitFor();
  const previewUrl = page.url();
  await preview.locator('a[data-footnote-ref]').click();
  if (page.url() !== previewUrl || !await preview.locator('li[id]').evaluate(el => el === document.activeElement)) throw Error('Preview footnote displaced navigation or focus');
  await page.screenshot({ path: '/tmp/shepherd-markdown-draft-preview.png' });
  await preview.getByRole('button', { name: 'Back to editing', exact: true }).click();
  if (await composer.inputValue() !== draft || !await composer.evaluate(el => el === document.activeElement)) throw Error('Preview lost the draft or editing focus');
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  }
  await composer.fill('');
  if (await page.getByRole('button', { name: 'Preview draft', exact: true }).count()) throw Error('Empty draft has a preview action');
  if (errors.length) throw Error(errors.join('\n'));
  return 'Live Markdown and unfinished fences, highlighting and fallback, exact code copy and clipboard failure, preview preservation and focus, and mobile widths passed';
}
