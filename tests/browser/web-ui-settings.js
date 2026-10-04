// Run against the isolated web-ui-host fixture using playwright-cli run-code.
async (page) => {
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Conversation settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Conversation settings', exact: true });
  await dialog.getByRole('button', { name: 'More models', exact: true }).click();
  await dialog.getByLabel('Model for next turn', { exact: true }).selectOption('large');
  await dialog.getByRole('button', { name: 'Use model', exact: true }).click();
  await dialog.getByText('Options for large.', { exact: false }).waitFor();
  await dialog.getByLabel('Effort for next turn', { exact: true }).selectOption('high');
  await dialog.getByRole('button', { name: 'Use effort', exact: true }).click();
  await dialog.locator('dd').filter({ hasText: /^high$/ }).waitFor();
  await dialog.getByText('Conversation context', { exact: true }).click();
  await dialog.getByText('No context telemetry yet. Send a turn first.', { exact: true }).waitFor();
  if (await dialog.getByText('Banked resets', { exact: false }).count()) throw Error('Account usage leaked into conversation settings');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/shepherd-settings-mobile.png' });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Settings overflow');
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Conversation settings', exact: true }).click();
  await dialog.locator('dd').filter({ hasText: /^large$/ }).waitFor();
  await dialog.locator('dd').filter({ hasText: /^high$/ }).waitFor();
  await dialog.getByLabel('Effort for next turn', { exact: true }).selectOption('default');
  await dialog.getByRole('button', { name: 'Use effort', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="Effort for next turn"]')?.value === 'low');
  await page.keyboard.press('Escape');
  if (await dialog.isVisible()) throw Error('Escape did not close settings');
}
