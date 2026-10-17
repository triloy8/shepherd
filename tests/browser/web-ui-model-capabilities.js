// Firefox fixture test: model metadata changes independently of adapter support.
async page => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/conversations/*/settings', async route => {
    const response = await route.fetch();
    const data = await response.json();
    const modalities = id => id === 'small' ? ['text'] : ['text', 'image'];
    data.modelCapabilities.current.inputModalities = modalities(data.model.currentModel);
    data.modelCapabilities.next.inputModalities = modalities(data.model.pendingModel ?? data.model.currentModel);
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  const attach = page.getByRole('button', { name: 'Attach images', exact: true });
  await page.waitForFunction(() => document.querySelector('button[aria-label="Attach images"]')?.disabled);
  await page.getByRole('button', { name: 'Model and effort', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model and effort', exact: true });
  await dialog.getByText('Model inputs: text', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'More models', exact: true }).click();
  await dialog.getByLabel('Model for next turn', { exact: true }).selectOption('large');
  await dialog.getByRole('button', { name: 'Use model', exact: true }).click();
  await dialog.getByText('Model inputs: text, image', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Attach images"]')?.disabled);
  if (await attach.isDisabled()) throw Error('Pending image-capable model did not enable attachments');
  await page.unroute('**/api/conversations/*/settings');
  if (errors.length) throw Error(errors.join('\n'));
}
