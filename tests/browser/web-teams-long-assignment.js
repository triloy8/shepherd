async page => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole('button', { name: 'Open conversations' }).click();
  await page.locator('button.new-conversation').click();
  const newDialog = page.getByRole('dialog');
  await newDialog.getByLabel('Project', { exact: true }).fill('owner/mobile-overflow');
  await newDialog.getByRole('button', { name: 'Create conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Swarm · 0', exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message Shepherd' });
  await composer.fill('Review the inbox with a small team.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await composer.fill('Yes, use that team.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Swarm · 3', exact: true }).waitFor();
  const ready = await page.waitForFunction(async () => {
    const response = await fetch('/api/swarms');
    const groups = (await response.json()).groups;
    const selected = JSON.parse(localStorage.getItem('shepherd.selection') || 'null');
    const group = groups.find(group => group.lifecycle === 'active' && group.managerThreadId === selected?.threadId);
    return group?.members.length === 3 && group.members.every(member => member.dispatches?.length && member.dispatches.every(receipt => receipt.status === 'sent')) ? group : false;
  });
  const group = await ready.jsonValue();
  if (!group) throw new Error('No active group');
  const assignment = 'A'.repeat(4096);
  const add = await page.evaluate(async ({ id, revision, assignment }) => {
    const response = await fetch('/api/swarms/' + id + '/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, name: 'LongAssignment3', assignment }) });
    return { status: response.status, body: await response.json() };
  }, { id: group.id, revision: group.revision, assignment });
  if (add.status !== 201) throw new Error(JSON.stringify(add));
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Swarm · 4/ }).click();
  await page.getByRole('dialog', { name: 'Swarm', exact: true }).getByRole('button').filter({ hasText: 'LongAssignment3' }).click();
  const worker = page.getByRole('dialog', { name: 'LongAssignment3', exact: true });
  await worker.waitFor();
  const dimensions = await worker.evaluate(element => ({ dialogWidth: element.clientWidth, dialogScrollWidth: element.scrollWidth, documentWidth: document.documentElement.scrollWidth, innerWidth }));
  if (dimensions.dialogScrollWidth > dimensions.dialogWidth || dimensions.documentWidth > dimensions.innerWidth) throw new Error(JSON.stringify(dimensions));
  return dimensions;
}
