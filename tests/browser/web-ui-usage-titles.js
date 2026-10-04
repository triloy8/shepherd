// Run against the isolated web-ui-host fixture using playwright-cli run-code.
async (page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://127.0.0.1:8799');
  const credit = { resetType: 'codexRateLimits', status: 'available', grantedAt: 100, expiresAt: null, description: null };
  let summary = { availableCount: 2, credits: [{ ...credit, id: 'first', title: 'First reset' }, { ...credit, id: 'second', title: 'Second reset' }] };
  await page.route('**/api/v1/limits', route => route.fulfill({ json: {
    rateLimits: {}, rateLimitsByLimitId: {
      internal_quota: { normalModelSlug: 'future-model', limitName: 'Reserve allowance' },
      provider_bucket: { normalModelSlug: 'unknown', limitName: 'Provider Display Name' },
      new_feature_quota: {},
    }, rateLimitResetCredits: summary,
  } }));
  const catalogRequests = [];
  await page.route('**/api/v1/models?*', route => {
    catalogRequests.push(route.request().url());
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    return route.fulfill({ json: cursor
      ? { data: [{ id: 'future-id', model: 'future-model', displayName: 'Future Model', hidden: true }], nextCursor: null }
      : { data: [], nextCursor: 'page-2' } });
  });
  await page.getByRole('button', { name: 'Usage & limits', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Usage & limits', exact: true });
  await panel.getByRole('heading', { name: 'Future Model', exact: true }).waitFor();
  await panel.getByText('Reserve allowance', { exact: true }).waitFor();
  await panel.getByRole('heading', { name: 'Provider Display Name', exact: true }).waitFor();
  await panel.getByRole('heading', { name: 'New feature quota', exact: true }).waitFor();
  if (catalogRequests.length !== 2) throw Error('Catalog pagination incomplete');
  if (await panel.getByRole('button', { name: 'Use next available reset', exact: true }).count()) throw Error('Generic control shown with full reset details');
  const requests = [];
  await page.route('**/api/v1/limits/reset', route => {
    const request = route.request().postDataJSON(); requests.push(request);
    summary = { availableCount: 1, credits: [{ ...credit, id: 'first', title: 'First reset' }] };
    return route.fulfill({ json: { outcome: 'reset' } });
  });
  await panel.locator('li').filter({ hasText: 'Second reset' }).getByRole('button', { name: 'Use this reset', exact: true }).click();
  await panel.getByText('Banked resets · 1 available', { exact: true }).waitFor();
  if (requests[0]?.creditId !== 'second') throw Error('Wrong reset chosen');
  if (await panel.getByText('Second reset · available', { exact: true }).count()) throw Error('Redeemed reset did not disappear');
  // Optional metadata failure must leave usage, selection, and readable fallbacks working.
  await page.unroute('**/api/v1/models?*');
  await page.route('**/api/v1/models?*', route => route.fulfill({ status: 502, json: { error: { code: 'operation_failed', message: 'Catalog unavailable' } } }));
  await panel.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await panel.getByRole('heading', { name: 'Reserve allowance', exact: true }).waitFor();
  await panel.getByText('Banked resets · 1 available', { exact: true }).waitFor();
  if (!await panel.getByRole('button', { name: 'Use this reset', exact: true }).isEnabled()) throw Error('Catalog failure blocked resets');
  if (await panel.getByRole('alert').count()) throw Error('Optional catalog failure became a usage error');
  // Count-only and capped inventories keep provider-selected redemption available.
  summary = { availableCount: 2, credits: [{ ...credit, id: 'first', title: 'First reset' }] };
  await panel.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await panel.getByRole('button', { name: 'Use next available reset', exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Use next available reset', exact: true }).click();
  await panel.getByText('Banked resets · 1 available', { exact: true }).waitFor();
  if ('creditId' in requests[1]) throw Error('Provider-selected reset forced an ID');
  if (requests[0].idempotencyKey === requests[1].idempotencyKey) throw Error('Separate attempts shared a key');
  summary = { availableCount: 2, credits: [
    { ...credit, id: 'expired', title: 'Expired reset', expiresAt: 1 },
    { ...credit, id: 'redeeming', title: 'Pending reset', status: 'redeeming' },
  ] };
  await panel.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await panel.getByText('Expired reset · expired', { exact: true }).waitFor();
  for (const button of await panel.getByRole('button', { name: 'Use this reset', exact: true }).all()) if (await button.isEnabled()) throw Error('Unavailable reset selectable');
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile metadata/reset overflow');
  await page.screenshot({ path: '/tmp/shepherd-reset-selection-mobile.png' });
  await panel.getByRole('button', { name: 'Close usage & limits', exact: true }).click();
  await page.unrouteAll({ behavior: 'wait' });
  return 'Paginated model names, label/ID fallbacks, catalog failure isolation, second-reset selection, provider selection for capped rows, and unavailable/reset mobile states verified';
}
