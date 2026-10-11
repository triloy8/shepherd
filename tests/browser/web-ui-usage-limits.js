// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code in Firefox.
async page => {
  page.setDefaultTimeout(10000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const now = Date.now() / 1000;
  const credit = (id, title, overrides = {}) => ({ id, title, supported: true, status: 'available',
    grantedAt: now - 100, expiresAt: null, description: null, ...overrides });
  let resets = { supported: true, availableCount: 2,
    credits: [credit('first', 'First reset'), credit('second', 'Second reset')] };
  let failRead = false;
  const snapshot = () => ({ provider: 'codex', account: { plan: 'fixture', authentication: 'subscription', signedIn: true },
    availability: 'available', source: 'provider', checkedAt: now, stale: false, ordinaryUsageAllowed: true,
    windows: [{ id: 'session', groupId: null, label: 'Session allowance', subtitle: null, durationMinutes: 300,
      usedPercent: 25, resetsAt: now + 300, status: 'available', observedAt: now, stale: false }],
    extraUsage: null, spendControls: [], resets, message: null });
  await page.route('**/api/limits?provider=codex*', route => route.fulfill(failRead
    ? { status: 502, json: { error: { code: 'operation_failed', message: 'Limits unavailable' } } }
    : { json: snapshot() }));
  await page.goto('http://127.0.0.1:8799');
  await page.evaluate(() => sessionStorage.removeItem('shepherd.account-reset:codex'));
  const open = async () => {
    if (!(await page.getByRole('button', { name: 'Usage & limits', exact: true }).isVisible())) await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
    await page.getByRole('button', { name: 'Usage & limits', exact: true }).click();
  };
  await open();
  const panel = page.getByRole('dialog', { name: 'Usage & limits', exact: true });
  await panel.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('codex');
  await panel.getByText('Banked resets: 2', { exact: true }).waitFor();
  const specific = title => panel.getByText(title, { exact: true }).locator('..').getByRole('button', { name: 'Use reset', exact: true });
  const generic = panel.getByRole('button', { name: 'Use available reset', exact: true });
  const retry = panel.getByRole('button', { name: 'Check unresolved reset request', exact: true });
  const requests = [];
  let release, entered;
  let outcome = 'already_redeemed';
  const started = new Promise(resolve => { entered = resolve; });
  await page.route('**/api/limits/reset', async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      entered(); await new Promise(resolve => { release = resolve; });
      await route.abort(); // Model a reply lost after the provider used the reset.
    } else await route.fulfill({ json: { outcome } });
  });
  await specific('Second reset').click(); await started;
  for (const button of await panel.getByRole('button', { name: /Use.*reset/ }).all()) if (await button.isEnabled()) throw Error('Concurrent reset allowed');
  if (await panel.getByRole('combobox', { name: 'Agent', exact: true }).isEnabled()) throw Error('Agent switch allowed during reset');
  await page.keyboard.press('Escape');
  if (!(await panel.isVisible())) throw Error('Closed during reset execution');
  release();
  await panel.getByRole('alert').filter({ hasText: 'Retry to check the same request' }).waitFor();
  if (!(await specific('First reset').isDisabled()) || !(await generic.isDisabled())) throw Error('Unresolved reset allowed another attempt');
  await page.reload(); await open();
  await retry.waitFor();
  await panel.getByRole('button', { name: 'Refresh usage', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(el => el.textContent === 'Check unresolved reset request')?.disabled);
  if (!(await generic.isDisabled()) || !(await specific('First reset').isDisabled())) throw Error('Reload unlocked a second reset before resolving the first');
  await retry.click();
  await panel.getByText('This reset was already used.', { exact: true }).waitFor();
  if (requests.length !== 2 || JSON.stringify(requests[0]) !== JSON.stringify(requests[1]) || requests[0].provider !== 'codex' || requests[0].creditId !== 'second') throw Error('Reload changed logical reset identity');
  if (await page.evaluate(() => sessionStorage.getItem('shepherd.account-reset:codex')) !== null) throw Error('Resolved request remained pending');
  for (const [next, message] of [['nothing_to_reset', 'No usage window is eligible for a reset.'], ['no_credit', 'No resets are available.'], ['reset', 'Reset used.']]) {
    outcome = next;
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(el => el.textContent === 'Use available reset')?.disabled);
    await generic.click(); await panel.getByText(message, { exact: true }).waitFor();
    const last = requests.at(-1);
    if (last.provider !== 'codex' || 'creditId' in last) throw Error('Provider-selected reset forced a credit ID');
  }
  if (new Set(requests.slice(1).map(input => input.idempotencyKey)).size !== requests.length - 1) throw Error('Separate attempts reused an idempotency key');
  const refresh = async () => {
    const loaded = page.waitForResponse(response => response.url().includes('/api/limits?provider=codex'));
    await panel.getByRole('button', { name: 'Refresh usage', exact: true }).click();
    await loaded; await panel.getByText('Loading…', { exact: true }).waitFor({ state: 'hidden' });
  };
  resets = { supported: true, availableCount: 2, credits: [credit('expired', 'Expired reset', { expiresAt: now - 1 }), credit('redeeming', 'Pending reset', { status: 'redeeming' }), credit('unsupported', 'Unsupported reset', { supported: false })] };
  await refresh();
  for (const title of ['Expired reset', 'Pending reset', 'Unsupported reset']) if (!(await specific(title).isDisabled())) throw Error(`${title} was selectable`);
  resets = { supported: true, availableCount: 0, credits: [] }; await refresh();
  await panel.getByText('Banked resets: 0', { exact: true }).waitFor();
  if (!(await generic.isDisabled())) throw Error('Zero resets offered');
  resets = { supported: true, availableCount: null, credits: null }; await refresh();
  await panel.getByText('Banked resets: Unknown', { exact: true }).waitFor();
  failRead = true; await refresh();
  await panel.getByRole('alert').filter({ hasText: 'Limits unavailable' }).waitFor();
  if (!(await panel.getByText('25% used', { exact: true }).isVisible())) throw Error('Failed refresh hid usage');
  await panel.getByText(/Last known data/).waitFor();
  await panel.getByRole('button', { name: 'Close usage & limits', exact: true }).click();
  await page.reload(); await open();
  await panel.getByRole('alert').waitFor();
  if (await panel.getByRole('progressbar').count()) throw Error('Failed initial load invented usage');
  failRead = false; await refresh();
  await panel.getByText('25% used', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Close usage & limits', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await open();
  await panel.getByText('25% used', { exact: true }).waitFor();
  if (await panel.evaluate(el => el.closest('[inert]') !== null)) throw Error('Usage panel inert on mobile');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Usage panel overflows mobile');
  await panel.getByRole('button', { name: 'Close usage & limits', exact: true }).click();
  if (!(await page.getByRole('button', { name: 'Open conversations', exact: true }).evaluate(el => el === document.activeElement))) throw Error('Mobile focus not restored');
  await page.unrouteAll({ behavior: 'wait' });
  return 'Specific/provider-selected resets, identity across reload, locking, all outcomes, unusable credits, load failures and mobile focus passed';
}
