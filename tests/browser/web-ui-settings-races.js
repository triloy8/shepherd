// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async page => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  let modelRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/models')) modelRequests++; });
  const open = async () => {
    await page.getByRole('button', { name: 'Model and effort', exact: true }).click();
    await page.getByRole('button', { name: 'More models', exact: true }).waitFor();
  };
  await open();
  const model = page.getByRole('combobox', { name: 'Model for next turn', exact: true });
  const effort = page.getByRole('combobox', { name: 'Effort for next turn', exact: true });
  await effort.selectOption('default');
  await page.getByRole('button', { name: 'More models', exact: true }).click();
  await model.selectOption('large');
  const catalogRequests = modelRequests;
  const settingsResponse = response => response.url().endsWith('/settings') && response.request().method() === 'GET';
  const started = page.waitForResponse(settingsResponse);
  await page.evaluate(async () => {
    const selected = JSON.parse(localStorage.getItem('shepherd.selection'));
    const response = await fetch(`/api/conversations/${selected.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Settings lifecycle regression', images: [] }) });
    if (!response.ok) throw Error('Fixture send failed');
  });
  await started;
  const completed = page.waitForResponse(settingsResponse);
  await completed;
  if (modelRequests !== catalogRequests) throw Error('Turn lifecycle refetched the model catalog');
  if (await model.locator('option[value="large"]').count() !== 1) throw Error('Turn lifecycle discarded paginated models');
  if (await model.inputValue() !== 'large' || await effort.inputValue() !== 'default') throw Error('Turn activity overwrote unsaved settings');
  const refreshed = page.waitForResponse(settingsResponse);
  await page.getByRole('button', { name: 'Refresh settings', exact: true }).click();
  await refreshed;
  await page.getByRole('button', { name: 'Use model', exact: true }).waitFor();
  if (await model.inputValue() !== 'large' || await effort.inputValue() !== 'default') throw Error('Refresh overwrote unsaved settings');
  await page.getByRole('button', { name: 'Use model', exact: true }).click();
  await page.getByText('Saved. Applies to the next new turn and subsequent turns.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Use effort', exact: true }).waitFor();
  if (await effort.inputValue() !== 'default') throw Error('Saving model overwrote unsaved effort');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await open();
  await page.waitForFunction(() => document.querySelector('[aria-label="Effort for next turn"]').value === 'low');
  if (await model.inputValue() !== 'large') throw Error('Reopening did not load saved model');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  return 'Unsaved model and effort survive turn start/completion, refresh and independent saves; reopening loads server values';
}
