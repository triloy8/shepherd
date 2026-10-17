// Run against a fresh tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async page => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://127.0.0.1:8799');
  const stored = page.getByRole('button', { name: 'A new home for Shepherd', exact: true });
  const other = page.getByRole('button', { name: 'Paginated history', exact: true });
  await stored.click();
  await page.getByRole('heading', { name: 'A new home for Shepherd', exact: true }).waitFor();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  let release, accepted, requests = 0;
  const held = new Promise(resolve => { accepted = resolve; });
  await page.route('**/api/conversations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requests++;
    const response = await route.fetch();
    const pending = new Promise(resolve => { release = resolve; }); accepted();
    await pending; await route.fulfill({ response });
  });
  await other.click(); await held;
  await other.click(); // Same-thread clicks must share the pending request.
  await stored.click();
  await page.getByText('Resuming conversation…', { exact: true }).waitFor({ state: 'hidden' });
  const receipt = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/conversations'));
  const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/conversations'));
  release(); await receipt; await refreshed;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (requests !== 1) throw Error('Repeated resume clicks created duplicate requests');
  if (await page.locator('.main-header h1').textContent() !== 'A new home for Shepherd') throw Error('Stale resume receipt stole the newer selection');
  if (await page.evaluate(() => JSON.parse(localStorage.getItem('shepherd.selection')).threadId) !== 'stored') throw Error('Stale receipt changed saved selection');
  await page.unrouteAll({ behavior: 'wait' });
  await other.click();
  await page.getByRole('heading', { name: 'Paginated history', exact: true }).waitFor();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  return 'Latest chat click wins; repeated resumes share one request; a stale receipt still registers the resumed chat for later selection';
}
