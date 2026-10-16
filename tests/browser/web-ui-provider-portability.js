// Independent capabilities: selection without discovery, absent account reporting, partial telemetry.
async page => {
  page.setDefaultTimeout(10000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors = [], modelWrites = [], effortWrites = [];
  let catalogs = 0, accountReads = 0, pendingModel = null, pendingEffort = null, pendingEffortClear = false, catalogEnabled = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/models')) catalogs++;
    if (new URL(request.url()).pathname.endsWith('/limits')) accountReads++;
  });
  await page.route('**/api/providers', async route => {
    const response = await route.fetch(); const data = await response.json();
    for (const provider of data.providers) Object.assign(provider, { accountReporting: false });
    await route.fulfill({ response, json: data });
  });
  await page.route(/\/api\/conversations\/[^/?]+$/, async route => {
    const response = await route.fetch(); const data = await response.json();
    Object.assign(data.state.capabilities, { modelCatalog: catalogEnabled, modelCatalogAuthoritative: false, modelSelection: true, effortSelection: true });
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/conversations/*/settings', route => route.fulfill({ json: {
    model: { threadId: 'stored', provider: 'independent', currentModel: null, pendingModel },
    effort: { threadId: 'stored', model: pendingModel, currentEffort: null, pendingEffort, pendingEffortClear,
      inputModalities: null, supportedEfforts: null, defaultEffort: null, effortOptionsKnown: false },
    modelCapabilities: { current: { inputModalities: null, supportedEfforts: null, defaultEffort: null },
      next: { inputModalities: null, supportedEfforts: null, defaultEffort: null } },
  } }));
  await page.route('**/api/conversations/*/models', route => route.fulfill({ json: { data: [{ id: 'catalog-entry',
    displayName: 'Listed model', description: '', hidden: false, isDefault: false,
    inputModalities: null, supportedEfforts: null, defaultEffort: null }], nextCursor: null } }));
  await page.route('**/api/conversations/*/model', route => {
    pendingModel = route.request().postDataJSON().model; modelWrites.push(pendingModel);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/conversations/*/effort', route => {
    const value = route.request().postDataJSON().effort; effortWrites.push(value);
    pendingEffort = value; pendingEffortClear = value === null;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/conversations/*/context', route => route.fulfill({ json: { threadId: 'stored', tokenUsage: {
    last: null, total: { inputTokens: null, outputTokens: null, totalTokens: 42,
      cacheReadInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null }, contextWindow: 1000,
  } } }));
  await page.reload();
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Model and effort', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model and effort', exact: true });
  const save = async (kind, label) => {
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith(`/${kind}`) && response.request().method() === 'POST'),
      dialog.getByRole('button', { name: label, exact: true }).click(),
    ]);
    await dialog.getByText('Saved. Applies to the next new turn and subsequent turns.', { exact: true }).waitFor();
  };
  await dialog.getByLabel('Custom effort for next turn', { exact: true }).fill('Native/LEVEL');
  await save('effort', 'Use effort');
  await dialog.getByLabel('Model for next turn', { exact: true }).fill('Project/CaseSensitive');
  await save('model', 'Use model');
  if (modelWrites.at(-1) !== 'Project/CaseSensitive' || effortWrites.at(-1) !== 'Native/LEVEL') throw Error('Opaque selections changed');
  if (catalogs) throw Error('Selection required a model catalog');
  await dialog.getByLabel('Effort for next turn', { exact: true }).selectOption({ label: 'Clear effort override' });
  await save('effort', 'Use effort');
  if (effortWrites.at(-1) !== null) throw Error('Explicit effort clearing was lost');
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: 'Conversation context', exact: true }).click();
  const context = page.getByRole('dialog', { name: 'Conversation context', exact: true });
  await context.getByText('42', { exact: true }).waitFor();
  if ((await context.textContent()).includes('NaN')) throw Error('Unknown telemetry became a number');
  await context.getByRole('button', { name: 'Close context', exact: true }).click();
  await page.getByRole('button', { name: 'Usage & limits', exact: true }).click();
  const usage = page.getByRole('dialog', { name: 'Usage & limits', exact: true });
  await usage.getByText('This agent does not report account usage.', { exact: true }).waitFor();
  if (accountReads) throw Error('Unsupported account reporting was queried');
  if (await usage.getByRole('button', { name: 'Refresh usage', exact: true }).isEnabled()) throw Error('Unsupported reporting remained enabled');
  await usage.getByRole('button', { name: 'Close usage & limits', exact: true }).click();
  catalogEnabled = true;
  await page.reload();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Model and effort', exact: true }).click();
  await dialog.getByLabel('Model for next turn', { exact: true }).fill('Alias/not-listed');
  await save('model', 'Use model');
  if (modelWrites.at(-1) !== 'Alias/not-listed' || !catalogs) throw Error('Advisory discovery restricted native selection');
  await page.unrouteAll({ behavior: 'wait' });
  if (errors.length) throw Error(errors.join('\n'));
  return 'Independent/advisory discovery, opaque selection, explicit clearing, partial telemetry and absent account reporting passed';
}
