// Run against the isolated web-ui-host fixture using playwright-cli run-code.
async (page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://127.0.0.1:8799');
  let summary = { availableCount: 3, credits: [
    { id: 'credit-1', resetType: 'codexRateLimits', status: 'available', grantedAt: 100, expiresAt: 2000000000, title: 'Expiring reset', description: null },
    { id: 'credit-2', resetType: 'codexRateLimits', status: 'available', grantedAt: 100, expiresAt: null, title: 'Permanent reset', description: null },
  ] };
  let failRead = false;
  await page.route('**/api/v1/limits', route => failRead
    ? route.fulfill({ status: 502, json: { error: { code: 'operation_failed', message: 'Limits unavailable' } } })
    : route.fulfill({ json: { rateLimits: { planType: 'fixture', primary: { usedPercent: 25 } }, rateLimitsByLimitId: null, rateLimitResetCredits: summary } }));
  await page.getByRole('button', { name: 'Usage & limits', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Usage & limits', exact: true });
  await panel.getByText('Banked resets · 3 available', { exact: true }).waitFor();
  await panel.getByText('Does not expire', { exact: true }).waitFor();
  await panel.getByText('Details are available for 2 of 3 resets.', { exact: true }).waitFor();
  const requests = [];
  let failed = false;
  let release;
  await page.route('**/api/v1/limits/reset', async route => {
    requests.push(route.request().postDataJSON());
    if (!failed) {
      failed = true;
      await new Promise(resolve => { release = resolve; });
      await route.abort(); // A response can be lost after redemption.
    } else {
      summary = { availableCount: 2, credits: null };
      await route.fulfill({ json: { outcome: 'alreadyRedeemed' } });
    }
  });
  await panel.locator('li').filter({ hasText: 'Expiring reset' }).getByRole('button', { name: 'Use this reset', exact: true }).click();
  await panel.getByText('Using reset…', { exact: true }).waitFor();
  for (const button of await panel.getByRole('button', { name: 'Use this reset', exact: true }).all()) if (await button.isEnabled()) throw Error('Concurrent reset allowed');
  await page.keyboard.press('Escape');
  if (!await panel.isVisible()) throw Error('Closed while reset in flight');
  release();
  await panel.getByRole('button', { name: 'Retry reset', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Usage & limits', exact: true }).click();
  await panel.getByRole('button', { name: 'Retry reset', exact: true }).click();
  await panel.getByText('This reset was already used.', { exact: true }).waitFor();
  await panel.getByText('Banked resets · 2 available', { exact: true }).waitFor();
  if (requests.length !== 2 || requests[0].idempotencyKey !== requests[1].idempotencyKey || requests[0].creditId !== 'credit-1' || requests[1].creditId !== 'credit-1') throw Error('Retry changed logical reset identity');
  await panel.getByText('Expiration details are unavailable.', { exact: true }).waitFor();
  for (const [outcome, message] of [['nothingToReset', 'No usage window is eligible for a reset right now.'], ['noCredit', 'No banked resets are available.'], ['reset', 'Reset used.']]) {
    await page.unroute('**/api/v1/limits/reset');
    await page.route('**/api/v1/limits/reset', route => route.fulfill({ json: { outcome } }));
    await panel.getByRole('button', { name: 'Use next available reset', exact: true }).click();
    await panel.getByText(message, { exact: true }).waitFor();
    await panel.getByText('Banked resets · 2 available', { exact: true }).waitFor();
  }
  summary = { availableCount: 0, credits: [] };
  await panel.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await panel.getByText('Banked resets · 0 available', { exact: true }).waitFor();
  if (await panel.getByRole('button', { name: 'Use next available reset', exact: true }).count()) throw Error('Zero resets offered');
  summary = null;
  await panel.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await panel.getByText('Banked reset information is unavailable.', { exact: true }).waitFor();
  failRead = true;
  await panel.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await panel.getByText('Limits unavailable', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  if (await panel.isVisible()) throw Error('Escape did not dismiss usage');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  failRead = false; summary = { availableCount: 1, credits: null };
  await page.getByRole('button', { name: 'Usage & limits', exact: true }).click();
  await panel.getByText('Banked resets · 1 available', { exact: true }).waitFor();
  if (await panel.evaluate(el => el.closest('[inert]') !== null)) throw Error('Usage dialog inert on mobile');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Usage panel overflows mobile viewport');
  await panel.getByRole('button', { name: 'Close usage & limits', exact: true }).click();
  if (!await page.getByRole('button', { name: 'Open conversations', exact: true }).evaluate(el => el === document.activeElement)) throw Error('Mobile focus not restored');
  await page.unrouteAll({ behavior: 'wait' });
  return 'Usage accessible without a conversation; reset details, all outcomes, safe retries across reload, unavailable data, and mobile focus verified';
}
