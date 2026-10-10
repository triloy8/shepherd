// Run against an isolated Shepherd web host on port 8799 with playwright-cli run-code.
async (page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/v1/threads?*', route => route.fulfill({ json: { threads: [], nextCursor: null } }));
  const now = Date.now() / 1000;
  let failed = false;
  let requests = 0;
  const snapshot = {
    provider: 'claude', account: { plan: 'pro', authentication: 'subscription', signedIn: true },
    availability: 'available', source: 'events', checkedAt: now, stale: true,
    windows: [
      { id: 'five_hour', label: 'Five-hour allowance', usedPercent: 80, resetsAt: now - 10, status: 'warning', observedAt: now - 150, stale: true },
      { id: 'seven_day', label: 'Weekly allowance', usedPercent: null, resetsAt: null, status: null, observedAt: now, stale: false },
      { id: 'seven_day_opus', label: 'Weekly Opus allowance', usedPercent: 0, resetsAt: now + 3000, status: null, observedAt: now, stale: false },
    ], extraUsage: { enabled: false, usedPercent: null, active: null, status: null, observedAt: now, stale: false }, message: null,
  };
  await page.route('**/api/v1/limits?provider=claude*', route => {
    requests++;
    return failed ? route.fulfill({ status: 502, json: { error: { code: 'operation_failed', message: 'Fixture usage unavailable' } } }) : route.fulfill({ json: snapshot });
  });
  await page.goto('http://127.0.0.1:8799');
  await page.getByRole('button', { name: 'Usage & limits', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Usage & limits', exact: true });
  await panel.getByRole('tab', { name: 'Claude', exact: true }).click();
  await panel.getByText('80% used', { exact: true }).waitFor();
  await panel.getByText('Not reported', { exact: true }).waitFor();
  await panel.getByText('0% used', { exact: true }).waitFor();
  if (await panel.getByRole('button', { name: /Use.*reset/ }).count()) throw Error('Claude tab offers a Codex reset');
  if (await panel.getByRole('progressbar').count() !== 2) throw Error('Unknown percentage rendered as zero progress');
  await panel.getByText(/Last reported value/).first().waitFor();
  await panel.getByRole('tab', { name: 'Claude', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  if (await panel.getByRole('tab', { name: 'Codex', exact: true }).getAttribute('aria-selected') !== 'true') throw Error('Provider keyboard navigation failed');
  await page.keyboard.press('End');
  await panel.getByText('80% used', { exact: true }).waitFor();
  failed = true;
  await panel.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  await panel.getByText('80% used', { exact: true }).waitFor();
  if (!await panel.getByRole('alert').textContent().then(text => text.includes('Showing the last reported values'))) throw Error('Failed refresh hid cached usage');
  await page.setViewportSize({ width: 390, height: 844 });
  if (await panel.evaluate(el => el.closest('[inert]') !== null)) throw Error('Claude panel is inert on mobile');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Claude limits overflow mobile');
  await panel.getByRole('button', { name: 'Close usage & limits', exact: true }).click();
  const before = requests;
  await page.waitForTimeout(100);
  if (requests !== before) throw Error('Closed panel keeps fetching limits');
  await page.unrouteAll({ behavior: 'wait' });
  return 'Claude percentages, unknown values, stale resets, failure retention, provider keyboard navigation, reset isolation and mobile layout passed';
}
