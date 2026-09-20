// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async (page) => {
  await page.unroute("**/api/v1/threads?**");
  let reverse = false;
  let requests = 0;
  await page.route('**/api/v1/threads?**', async route => {
    requests++;
    await page.waitForTimeout(350);
    const rows = [
      { threadId: 'stored', name: 'Original first', preview: '', archived: false },
      { threadId: 'other', name: 'Recently updated', preview: '', archived: false },
    ];
    await route.fulfill({ json: { threads: reverse ? rows.reverse() : rows, nextCursor: null, backwardsCursor: null } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Original first', exact: true }).waitFor();
  reverse = true;
  const refresh = page.getByRole('button', { name: 'Refresh conversations', exact: true });
  await refresh.click();
  await page.getByText('Refreshing conversations…', { exact: true }).waitFor();
  if (await refresh.isEnabled()) throw Error('Refresh not marked busy');
  await page.getByText('Refreshing conversations…', { exact: true }).waitFor({ state: 'hidden' });
  const labels = await page.locator('nav .thread-button').allTextContents();
  if (!labels[0].includes('Recently updated')) throw Error('Returned newest-first order not rendered');
  await page.getByRole('button', { name: 'Original first', exact: true }).click();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  await page.waitForTimeout(1000);
  const before = requests;
  await page.getByRole('textbox', { name: 'Message Shepherd', exact: true }).fill('Refresh the list after this turn');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForTimeout(1800);
  if (requests <= before) throw Error('Turn activity did not refresh conversations');
  const beforeFocus = requests;
  await page.waitForTimeout(500);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(700);
  if (requests <= beforeFocus) throw Error('Focus did not refresh conversations');
  await page.unroute('**/api/v1/threads?**');
  return 'Manual refresh feedback, server ordering, activity refresh and focus refresh passed';
}
