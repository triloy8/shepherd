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
  return 'Passed: five worker completions in two watch cards, grouped 3 + 2, with dispatch turn IDs and reload';
}
