// Firefox, against UI_TEST_PORT=19087 bun tests/fixtures/web-ui-host.ts.
async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:19087');
  await page.getByRole('button', { name: 'Start a conversation', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Project', { exact: true }).fill('owner/repo');
  await dialog.getByRole('button', { name: 'Create conversation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('Run five watcher checks.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Swarm · 5', exact: true }).waitFor();

  const updates = page.locator('.message-automated').filter({ hasText: 'Watched thread update' });
  const changes = update => update.locator('.prose-chat ul').first().getByRole('listitem');
  await updates.nth(1).waitFor();
  const readBatches = async () => Promise.all([0, 1].map(i => changes(updates.nth(i)).allTextContents()));
  const batches = await readBatches();
  if (await updates.count() !== 2 || batches[0].length !== 3 || batches[1].length !== 2) {
    throw Error(`Expected a three-worker batch and two-worker follow-up: ${JSON.stringify(batches)}`);
  }
  const workers = await page.evaluate(async () => {
    const { groups } = await (await fetch('/api/swarms')).json();
    return groups[0].members.map(member => ({ name: member.name, turnId: member.dispatches[0].turnId }));
  });
  for (const [index, worker] of workers.entries()) {
    const batch = batches[index < 3 ? 0 : 1];
    if (!batch.some(line => line.includes(worker.name) && line.includes(worker.turnId) && line.includes('completed'))) {
      throw Error(`Missing completion for ${worker.name} and turn ${worker.turnId}`);
    }
  }
  await page.reload();
  await updates.nth(1).waitFor();
  if (JSON.stringify(await readBatches()) !== JSON.stringify(batches)) throw Error('Watch batches changed after reload');

  const swarmButton = page.getByRole('button', { name: 'Swarm · 5', exact: true });
  const composer = page.getByRole('textbox', { name: 'Message Shepherd' });
  await composer.fill('Follow up with Luna.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await swarmButton.click();
  const team = page.getByRole('dialog', { name: 'Swarm', exact: true });
  const luna = team.getByRole('button').filter({ hasText: 'Luna' });
  await luna.getByText("Watcher smoke check for Luna's follow-up.", { exact: true }).waitFor();
  await luna.getByText('Working', { exact: true }).waitFor();
  await luna.click();
  const inspector = page.getByRole('dialog', { name: 'Luna', exact: true });
  await inspector.getByText('Watcher smoke check for Luna.', { exact: true }).first().waitFor();
  await page.keyboard.press('Escape');
  await inspector.waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await team.waitFor({ state: 'hidden' });

  await composer.fill("Finish Luna's follow-up.");
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await swarmButton.click();
  await luna.getByText('Turn finished', { exact: true }).waitFor();
  await luna.getByText("Watcher smoke check for Luna's follow-up.", { exact: true }).waitFor();
  return 'Passed: five completions in two watch cards, plus Luna’s live follow-up and original assignment in the inspector';
}
