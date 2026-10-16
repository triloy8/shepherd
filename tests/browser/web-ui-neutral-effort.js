// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code in Firefox.
async page => {
  page.setDefaultTimeout(10000);
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  const efforts = ['normal', 'default', 'DEFAULT', 'clear', 'model-default', '\u0000model-default'];
  let current = 'normal';
  const requests = [];
  const state = () => ({ threadId: 'fixture', model: 'small', currentEffort: current, pendingEffort: null,
    inputModalities: null, defaultEffort: 'normal', supportedEfforts: efforts.map(value => ({ value, description: value })) });
  await page.route('**/api/conversations/*/settings', route => route.fulfill({ json: {
    model: { threadId: 'fixture', provider: 'codex', currentModel: 'small', pendingModel: null },
    effort: state(), modelCapabilities: null,
  } }));
  await page.route('**/api/conversations/*/effort', route => {
    const input = route.request().postDataJSON(); requests.push(input.effort);
    current = input.effort === null ? null : typeof input.effort === 'string' ? input.effort : 'normal';
    return route.fulfill({ json: state() });
  });
  await page.getByRole('button', { name: 'Model and effort', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model and effort', exact: true });
  const select = dialog.getByLabel('Effort for next turn', { exact: true });
  const values = await select.locator('option').evaluateAll(options => options.map(option => option.value));
  if (new Set(values).size !== values.length) throw Error('Provider effort collided with the default option');
  for (const effort of efforts.slice(1)) {
    await select.selectOption(JSON.stringify(['effort', effort]));
    await dialog.getByRole('button', { name: 'Use effort', exact: true }).click();
    await dialog.getByText('Saved. Applies to the next new turn and subsequent turns.', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.settings-dialog button.button-secondary')?.disabled);
    if (requests.at(-1) !== effort) throw Error('Provider effort value was changed');
  }
  await select.selectOption({ label: 'Model default (normal)' });
  await dialog.getByRole('button', { name: 'Use effort', exact: true }).click();
  await dialog.getByText('Saved. Applies to the next new turn and subsequent turns.', { exact: true }).waitFor();
  if (requests.at(-1)?.mode !== 'default') throw Error('Model default did not send its distinct action');
  await select.selectOption({ label: 'Clear effort override' });
  await dialog.getByRole('button', { name: 'Use effort', exact: true }).click();
  await dialog.getByText('Saved. Applies to the next new turn and subsequent turns.', { exact: true }).waitFor();
  if (requests.at(-1) !== null) throw Error('Clearing the override did not send null');
  return 'Opaque values stay distinct from model default and clear, including former UI sentinels';
}
