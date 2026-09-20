// Run against the isolated web-ui-host fixture using playwright-cli run-code.
async (page) => {
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Conversation settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Conversation settings', exact: true });
  await dialog.getByText('Skills', { exact: true }).click();
  const skills = dialog.getByRole('region', { name: 'Skills', exact: true });
  await skills.getByText('/workspace/broken/SKILL.md: Missing description', { exact: true }).waitFor();
  await skills.getByRole('button', { name: 'Enable review (user)', exact: true }).click();
  await skills.getByRole('button', { name: 'Disable review (user)', exact: true }).waitFor();
  await skills.getByRole('button', { name: 'Disable review (repo)', exact: true }).click();
  await skills.getByRole('button', { name: 'Enable review (repo)', exact: true }).waitFor();
  await skills.getByLabel('Filter skills', { exact: true }).fill('personal');
  if (await skills.getByRole('article').count() !== 1) throw Error('Skill filter failed');
  await skills.getByLabel('Filter skills', { exact: true }).fill('not-found');
  await skills.getByText('No skills match this filter.', { exact: true }).waitFor();
  await skills.getByLabel('Filter skills', { exact: true }).fill('');
  await skills.getByRole('button', { name: 'Reload skills', exact: true }).click();
  await skills.getByText('Skill discovery reloaded.', { exact: true }).waitFor();
  await skills.getByRole('button', { name: 'Enable review (repo)', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/shepherd-skills-mobile.png' });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Skills overflow');
  await page.route('**/api/v1/conversations/*/skills', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 502, json: { error: { code: 'operation_failed', message: 'Skill update failed' } } }) : route.continue());
  await skills.getByRole('button', { name: 'Enable review (repo)', exact: true }).click();
  await skills.getByText('Skill update failed', { exact: false }).waitFor();
  if (await skills.getByRole('article').count()) throw Error('Stale toggle controls remain after error');
  await page.unroute('**/api/v1/conversations/*/skills');
  await skills.getByRole('button', { name: 'Reload skills', exact: true }).click();
  await skills.getByRole('button', { name: 'Enable review (repo)', exact: true }).waitFor();
  await page.route('**/api/v1/conversations/*/skills', route => route.request().method() === 'POST'
    ? route.fulfill({ json: { effectiveEnabled: false } }) : route.continue());
  await skills.getByRole('button', { name: 'Enable review (repo)', exact: true }).click();
  await skills.getByText('Setting saved, but the effective state differs.', { exact: false }).waitFor();
  await skills.getByRole('button', { name: 'Enable review (repo)', exact: true }).waitFor();
  await page.unroute('**/api/v1/conversations/*/skills');
  await page.route('**/api/v1/conversations/*/skills-reload', route => route.fulfill({ json: { data: [] } }));
  await skills.getByRole('button', { name: 'Reload skills', exact: true }).click();
  await skills.getByText('No skills found in this workspace.', { exact: true }).waitFor();
  await page.unroute('**/api/v1/conversations/*/skills-reload');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Conversation settings', exact: true }).click();
  await skills.getByRole('button', { name: 'Enable review (repo)', exact: true }).waitFor();
  await page.keyboard.press('Escape');
}
