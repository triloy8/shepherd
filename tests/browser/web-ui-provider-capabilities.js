// Firefox fixture check: capabilities constrain controls independently of provider identity.
async page => {
  const errors = [], settingsRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/settings')) settingsRequests.push(request.url()); });
  await page.route(/\/api\/conversations\/[^/?]+$/, async route => {
    const response = await route.fetch();
    const data = await response.json();
    Object.assign(data.state.capabilities, { rename: false, archive: false, steer: false,
      interrupt: false, modelCatalog: false, modelSelection: false, effortSelection: false });
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Model and effort"]')?.disabled, null, { timeout: 10000 });
  if (!(await page.getByRole('button', { name: 'Rename conversation', exact: true }).isDisabled())) throw Error('Rename was enabled');
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
  if (!(await page.getByRole('menuitem', { name: 'Archive conversation', exact: true }).isDisabled())) throw Error('Archive was enabled');
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('provider question capability check');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Interrupt response', exact: true }).waitFor();
  if (!(await page.getByRole('button', { name: 'Interrupt response', exact: true }).isDisabled())) throw Error('Interrupt was enabled');
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('follow-up');
  if (!(await page.getByRole('button', { name: 'Send follow-up', exact: true }).isDisabled())) throw Error('Steering was enabled');
  if (settingsRequests.length) throw Error('Settings were requested without model catalog support');
  if (errors.length) throw Error(errors.join('\n'));
}
