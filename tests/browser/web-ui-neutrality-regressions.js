// Provider values stay opaque; model changes constrain existing drafts and archive controls.
async page => {
  const errors = [], efforts = [], messages = [];
  let pendingEffort = null, pendingEffortClear = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/conversations/*/settings', async route => {
    const response = await route.fetch(); const data = await response.json();
    const capabilities = id => id === 'small'
      ? { inputModalities: ['text'], supportedEfforts: [], defaultEffort: null }
      : { inputModalities: ['text', 'image'], supportedEfforts: [{ value: 'default', description: '' }, { value: 'Focused', description: '' }], defaultEffort: 'Focused' };
    Object.assign(data.effort, capabilities(data.model.pendingModel ?? data.model.currentModel), { pendingEffort, pendingEffortClear });
    data.modelCapabilities.current = capabilities(data.model.currentModel);
    data.modelCapabilities.next = capabilities(data.model.pendingModel ?? data.model.currentModel);
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/conversations/*/effort', async route => {
    const value = route.request().postDataJSON().effort; efforts.push(value);
    pendingEffort = value === null ? null : typeof value === 'string' ? value : 'Focused';
    pendingEffortClear = value === null;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/conversations/*/messages', async route => {
    messages.push(route.request().postDataJSON());
    await route.fulfill({ json: { type: 'submit', threadId: 'stored', turnId: null } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Model and effort', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model and effort', exact: true });
  await dialog.getByRole('button', { name: 'More models', exact: true }).click();
  await dialog.getByLabel('Model for next turn', { exact: true }).selectOption('large');
  await dialog.getByRole('button', { name: 'Use model', exact: true }).click();
  const effort = dialog.getByLabel('Effort for next turn', { exact: true });
  await effort.selectOption('value:default');
  await dialog.getByRole('button', { name: 'Use effort', exact: true }).click();
  await dialog.getByText('Saved. Applies to the next new turn and subsequent turns.', { exact: true }).waitFor();
  if (efforts.at(-1) !== 'default') throw Error('Literal default effort was reinterpreted');
  await effort.selectOption('default');
  await dialog.getByRole('button', { name: 'Use effort', exact: true }).click();
  if (efforts.at(-1)?.mode !== 'default') throw Error('Model default was not a distinct action');
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Attach images"]')?.disabled);
  await page.locator('input[type="file"]').setInputFiles('/tmp/shepherd-image-input-fixtures/only.png');
  await page.getByRole('button', { name: 'Remove only.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Model and effort', exact: true }).click();
  await dialog.getByLabel('Model for next turn', { exact: true }).selectOption('small');
  await dialog.getByRole('button', { name: 'Use model', exact: true }).click();
  await dialog.getByText('No effort controls available for this model.', { exact: true }).waitFor();
  await effort.selectOption('clear');
  await dialog.getByRole('button', { name: 'Use effort', exact: true }).click();
  if (efforts.at(-1) !== null) throw Error('Could not clear effort on a model without effort controls');
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Attach images"]')?.disabled);
  if (await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled()) throw Error('Existing unsupported image was sendable');
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('kept draft');
  await page.getByRole('textbox', { name: 'Message Shepherd' }).press('Enter');
  if (messages.length) throw Error('Keyboard submission bypassed image support');
  await page.getByRole('button', { name: 'Remove only.png', exact: true }).click();
  if (!(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled())) throw Error('Removing unsupported media did not unblock the draft');
  await page.route('**/api/threads?*', async route => {
    if (new URL(route.request().url()).searchParams.get('archived') === 'true') await route.fulfill({ json: {
      threads: [{ threadId: 'archived-third', provider: 'third', canUnarchive: false, name: 'Third archived', preview: '', archived: true, createdAt: 1, updatedAt: 2, cwd: '/tmp' }],
      nextCursor: null, backwardsCursor: null, unavailableProviders: ['offline-agent'],
    } }); else await route.continue();
  });
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  const restore = page.getByRole('button', { name: 'Restore Third archived', exact: true });
  await restore.waitFor();
  if (await restore.isEnabled()) throw Error('Restore ignored the stored thread capability');
  await page.getByRole('alert').filter({ hasText: 'Some agents are unavailable: offline-agent. Reload the list to retry.' }).waitFor();
  if (errors.length) throw Error(errors.join('\n'));
}
