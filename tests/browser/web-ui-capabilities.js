// Exercises an unrelated text-only descriptor and then a fully capable descriptor without provider branches in UI.
async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  async function create(provider) {
    if (!(await page.getByRole('button', { name: 'New conversation', exact: true }).isVisible())) await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    const project = page.locator('dialog[open]');
    await project.getByLabel('Agent', { exact: true }).selectOption(provider);
    await project.getByLabel('Project', { exact: true }).fill('~');
    await project.getByRole('button', { name: 'Create conversation', exact: true }).click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('Capability check');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Let’s make it happen.', { exact: true }).waitFor();
    await page.getByText('Connected', { exact: true }).waitFor();
  }
  await create('fixture-text-only');
  if (!(await page.getByRole('button', { name: 'Attach images', exact: true }).isDisabled())) throw Error('Unsupported image attachment enabled');
  if (!(await page.getByRole('button', { name: 'Revert from here', exact: true }).first().isDisabled())) throw Error('Unsupported revert enabled');
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
  for (const name of ['Skills', 'Compact conversation', 'Fork conversation']) {
    if (!(await page.getByRole('menuitem', { name, exact: true }).isDisabled())) throw Error(`Unsupported ${name} enabled`);
  }
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Conversation context', exact: true }).click();
  const context = page.getByRole('dialog', { name: 'Conversation context', exact: true });
  if (!(await context.getByRole('button', { name: 'Compact conversation', exact: true }).isDisabled())) throw Error('Unsupported context compaction enabled');
  await context.getByRole('button', { name: 'Close context', exact: true }).click();
  await create('codex');
  await page.getByRole('button', { name: 'Attach images', exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'Attach images', exact: true }).isDisabled()) throw Error('Supported image attachment disabled after switching');
  if (await page.getByRole('button', { name: 'Revert from here', exact: true }).first().isDisabled()) throw Error('Supported revert disabled after switching');
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
  for (const name of ['Skills', 'Compact conversation', 'Fork conversation']) {
    if (await page.getByRole('menuitem', { name, exact: true }).isDisabled()) throw Error(`Supported ${name} disabled after switching`);
  }
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Conversation context', exact: true }).click();
  const supportedContext = page.getByRole('dialog', { name: 'Conversation context', exact: true });
  if (await supportedContext.getByRole('button', { name: 'Compact conversation', exact: true }).isDisabled()) throw Error('Supported context compaction disabled after switching');
  await supportedContext.getByRole('button', { name: 'Close context', exact: true }).click();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile overflow');
  if (errors.length) throw Error(errors.join('\n'));
}
