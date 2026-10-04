// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async (page) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/v1/conversations/*/turns?*', async route => {
    const response = await route.fetch();
    const history = await response.json();
    if (history.data?.length) history.data[0].items = [{
      id: 'currency-regression', type: 'agentMessage', phase: 'final_answer',
      text: 'Compared with Prime’s available **40GB A100 at $1.99/h**, Runpod advertises **80GB at $1.59/h**.\n\nCosts $5 or $10. Formula: $2 + 2 = 4$ and $x^2$.\n\n$$\n\\frac{a}{b}\n$$',
    }];
    await route.fulfill({ response, json: history });
  });
  await page.goto('http://127.0.0.1:8799');
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.locator('.prose-chat strong').nth(1).waitFor();
  const bold = await page.locator('.prose-chat strong').allTextContents();
  if (JSON.stringify(bold) !== JSON.stringify(['40GB A100 at $1.99/h', '80GB at $1.59/h'])) throw Error('Dollar prices broke bold Markdown');
  if (await page.locator('.prose-chat p').first().locator('.katex').count()) throw Error('Dollar prices were parsed as math');
  if (await page.locator('.prose-chat .katex').count() !== 3) throw Error('Mixed currency and genuine math did not render correctly');
  const mixed = await page.locator('.prose-chat p').nth(1).textContent();
  if (!mixed.includes('Costs $5 or $10.')) throw Error('Currency was lost next to math');
  if (await page.locator('.prose-chat .katex-display').count() !== 1) throw Error('Display math was affected');
  await page.unroute('**/api/v1/conversations/*/turns?*');
  return 'Mobile rendering preserves dollar prices and bold formatting while rendering numeric inline math, variable inline math, and display equations';
}
