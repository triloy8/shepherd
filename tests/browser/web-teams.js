// Firefox, against UI_TEST_PORT=19087 bun tests/fixtures/web-ui-host.ts.
async page => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:19087');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Project', { exact: true }).fill('owner/repo');
  await dialog.getByRole('button', { name: 'Create conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Swarm · 0', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Swarm · 0', exact: true }).click();
  await page.getByText('No workers yet.', { exact: false }).waitFor();
  const groups = await page.evaluate(async () => (await (await fetch('/api/swarms')).json()).groups);
  if (groups.length) throw Error('Opening the panel allocated a team');
  await page.keyboard.press('Escape');
  const composer = page.getByRole('textbox', { name: 'Message Shepherd' });
  await composer.fill('Review the inbox with a small team.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await composer.fill('Yes, use that team.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Swarm · 3', exact: true }).waitFor();
  await composer.fill('Keep my manager draft');
  for (const width of [320, 390, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Swarm · 3', exact: true }).click();
    const team = page.getByRole('dialog', { name: 'Swarm', exact: true });
    await team.getByRole('button').filter({ hasText: 'Solu' }).click();
    const worker = page.getByRole('dialog', { name: 'Solu', exact: true });
    await worker.waitFor();
    if (await worker.getByRole('textbox').count()) throw Error('Worker has an editable composer');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error(`Overflow at ${width}`);
    await page.keyboard.press('Escape');
    await worker.waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await team.waitFor({ state: 'hidden' });
    if (await composer.inputValue() !== 'Keep my manager draft') throw Error('Manager draft lost during inspection');
  }
  await page.reload();
  await page.getByRole('button', { name: 'Swarm · 3', exact: true }).waitFor();
  const visible = await page.evaluate(async () => {
    const [{ groups }, { conversations }] = await Promise.all(['/api/swarms', '/api/conversations'].map(async p => (await fetch(p)).json()));
    return conversations.some(c => groups.some(g => g.members.some(m => m.threadId === c.threadId)));
  });
  if (visible) throw Error('Worker leaked into main conversation list');
  if (errors.length) throw Error(errors.join('\n'));
  return 'Passed: zero-worker chat, lazy delegation, live count, read-only inspection, manager draft preservation, reload and layouts at 320/390/1440/1920px';
}
