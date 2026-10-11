// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code in Firefox.
async page => {
  page.setDefaultTimeout(10000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const now = Date.now() / 1000;
  const window = (id, label, usedPercent, stale = false) => ({ id, groupId: null, label, subtitle: null,
    durationMinutes: null, usedPercent, resetsAt: null, status: null, observedAt: now, stale });
  const snapshot = provider => ({ provider, account: { plan: 'pro', authentication: 'subscription', signedIn: true },
    availability: 'available', source: 'events', checkedAt: now, stale: provider === 'claude', ordinaryUsageAllowed: true,
    windows: provider === 'claude' ? [window('five_hour', 'Five-hour allowance', 80, true),
      window('seven_day', 'Weekly allowance', null), window('seven_day_opus', 'Weekly Opus allowance', 0)]
      : [window('session', 'Session allowance', 25)],
    extraUsage: { enabled: false, unlimited: null, balanceLabel: null, usedPercent: null, active: null, status: null, observedAt: now, stale: false },
    spendControls: [], resets: { supported: false, availableCount: null, credits: null }, message: null });
  let failed = false, hold = false, release, entered;
  let requests = 0;
  const aborted = [];
  page.on('requestfailed', request => { if (request.url().includes('/api/limits?')) aborted.push(request.url()); });
  await page.route('**/api/limits?*', async route => {
    requests++;
    const provider = new URL(route.request().url()).searchParams.get('provider');
    if (hold) { entered(); await new Promise(resolve => { release = resolve; }); }
    try {
      await route.fulfill(failed && provider === 'claude'
        ? { status: 502, json: { error: { code: 'operation_failed', message: 'Fixture usage unavailable' } } }
        : { json: snapshot(provider) });
    } catch (error) { if (!hold) throw error; }
  });
  await page.goto('http://127.0.0.1:8799');
  await page.getByRole('button', { name: 'Usage & limits', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Usage & limits', exact: true });
  const agent = panel.getByRole('combobox', { name: 'Agent', exact: true });
  await agent.selectOption('claude');
  await panel.getByText(/^80% used(?: · Last known data)?$/).waitFor();
  await panel.getByText('Usage unavailable', { exact: true }).waitFor();
  await panel.getByText('0% used', { exact: true }).waitFor();
  if (await panel.getByRole('progressbar').count() !== 2) throw Error('Unknown usage rendered as zero progress');
  await panel.getByText(/Last known data/).first().waitFor();
  if (await panel.getByRole('button', { name: /reset/i }).count()) throw Error('Claude offers reset controls');
  failed = true;
  await panel.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Fixture usage unavailable' }).waitFor();
  if (!(await panel.getByText(/^80% used(?: · Last known data)?$/).isVisible())) throw Error('Refresh failure hid last known usage');
  await agent.selectOption('codex');
  await panel.getByText('25% used', { exact: true }).waitFor();
  if (await panel.getByText(/^80% used(?: · Last known data)?$/).count()) throw Error('Claude usage leaked into Codex');
  await agent.selectOption('claude');
  await panel.getByRole('alert').waitFor();
  if (await panel.getByRole('progressbar').count()) throw Error('Agent switch retained another account’s numbers');
  failed = false;
  await panel.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await panel.getByText(/^80% used(?: · Last known data)?$/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  if (await panel.evaluate(el => el.closest('[inert]') !== null)) throw Error('Usage panel is inert on mobile');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Usage panel overflows mobile');
  hold = true;
  const started = new Promise(resolve => { entered = resolve; });
  await panel.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await started;
  const abortCount = aborted.length;
  const cancelled = page.waitForEvent('requestfailed', { predicate: request => request.url().includes('/api/limits?'), timeout: 10000 });
  await panel.getByRole('button', { name: 'Close usage & limits', exact: true }).click();
  await cancelled;
  if (aborted.length <= abortCount) throw Error('Closing did not abort the pending read');
  const before = requests;
  release();
  await page.waitForTimeout(100);
  if (requests !== before || await panel.isVisible()) throw Error('Closed panel continued loading');
  await page.unrouteAll({ behavior: 'wait' });
  return 'Shared account data, percentages, unknown/stale values, refresh retention, agent isolation, mobile layout and close cancellation passed';
}
