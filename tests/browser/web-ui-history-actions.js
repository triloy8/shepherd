// Run with playwright-cli run-code against the isolated web-ui-host fixture.
async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message Shepherd' });
  const user = text => page.locator('article.message-user').filter({ has: page.getByText(text, { exact: true }) });
  const revert = text => user(text).getByRole('button', { name: 'Revert from here', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Revert conversation', exact: true });
  const confirm = dialog.getByRole('button', { name: 'Confirm revert', exact: true });
  const send = async text => {
    await composer.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await user(text).waitFor();
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
    await revert(text).waitFor();
  };
  await send('Keep this turn');
  await send('Remove this turn');
  await send('Remove the later turn too');
  const row = user('Remove this turn');
  if (await row.getByRole('button', { name: 'Copy message', exact: true }).count() !== 1) throw Error('User copy missing');
  await revert('Remove this turn').click();
  await dialog.getByText('including the selected message and its response', { exact: false }).waitFor();
  if (!await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el === document.activeElement)) throw Error('Cancel is not initially focused');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await user('Remove this turn').waitFor();

  // Another browser connected to the same handle must replace its transcript.
  const second = await page.context().newPage();
  await second.goto(page.url());
  await second.getByText('Remove the later turn too', { exact: true }).waitFor();
  await second.locator('article.message-user').filter({ has: second.getByText('Remove this turn', { exact: true }) }).getByRole('button', { name: 'Revert from here', exact: true }).click();
  // Hold a pre-revert snapshot across the mutation to exercise stale-response recovery.
  let release;
  let captured;
  const waiting = new Promise(resolve => { captured = resolve; });
  let first = true;
  await page.route('**/api/v1/conversations/*/turns?*', async route => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    await new Promise(resolve => { release = resolve; captured(); });
    await route.fulfill({ response }).catch(() => {});
  });
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await waiting;
  await page.getByText('Connected', { exact: true }).waitFor();
  await revert('Remove this turn').click();
  const response = page.waitForResponse(response => response.url().endsWith('/revert'));
  await confirm.click();
  const mutation = await response;
  if (mutation.status() !== 200) throw Error('Revert failed');
  release();
  await page.getByText('Conversation reverted. Files were not changed.', { exact: true }).waitFor();
  await page.unroute('**/api/v1/conversations/*/turns?*');
  await user('Keep this turn').waitFor();
  await second.locator('article.message-user').filter({ has: second.getByText('Remove this turn', { exact: true }) }).waitFor({ state: 'hidden' });
  await second.getByText('This turn is no longer in the displayed history.', { exact: false }).waitFor();
  if (await second.getByRole('button', { name: 'Confirm revert', exact: true }).isEnabled()) throw Error('Stale selection still enabled');
  await second.getByText('Remove the later turn too', { exact: true }).waitFor({ state: 'hidden' });
  await second.close();
  if (await user('Remove this turn').count() || await user('Remove the later turn too').count()) throw Error('Reverted history survived refresh');
  await page.reload();
  await page.getByText('Connected', { exact: true }).waitFor();
  await user('Keep this turn').waitFor();
  if (await user('Remove this turn').count()) throw Error('Old SSE replay restored removed turn');

  // Ambiguous outcomes cannot be retried by dismissing/reopening confirmation.
  await page.route('**/api/v1/conversations/*/revert', route => route.fulfill({ status: 502, json: { error: { code: 'operation_failed', message: 'Revert unavailable' } } }));
  await revert('Keep this turn').click();
  await confirm.click();
  await dialog.getByText('Revert unavailable', { exact: true }).waitFor();
  if (await confirm.isEnabled()) throw Error('Uncertain mutation allows immediate retry');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await revert('Keep this turn').click();
  if (await confirm.isEnabled()) throw Error('Closing dialog bypassed recovery');
  await page.route('**/api/v1/conversations/*/turns?*', route => route.fulfill({ status: 502, json: { error: { code: 'operation_failed', message: 'History unavailable' } } }));
  await dialog.getByRole('button', { name: 'Reload conversation to check outcome', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'Could not reach Shepherd' }).waitFor();
  if (await confirm.isEnabled()) throw Error('Failed reload enabled retry');
  await page.unroute('**/api/v1/conversations/*/turns?*');
  await dialog.getByRole('button', { name: 'Reload conversation to check outcome', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.unroute('**/api/v1/conversations/*/revert');
  await revert('Keep this turn').click();
  if (!await confirm.isEnabled()) throw Error('Successful recovery did not enable revert');
  await page.keyboard.press('Escape');

  // Compaction remains available in the header; the count-based control is gone.
  const actions = page.getByRole('dialog', { name: 'Conversation actions', exact: true });
  await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
  if (await actions.getByText('Roll back conversation', { exact: true }).count()) throw Error('Old rollback UI remains');
  await actions.getByRole('button', { name: 'Compact conversation', exact: true }).click();
  await actions.getByText('Compaction started.', { exact: false }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
  await composer.fill('approval');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
  if (await revert('Keep this turn').isEnabled()) throw Error('Revert enabled during approval');
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });

  // Revert from an older page and clear every subsequent page, including the oldest turn.
  await page.getByRole('button', { name: 'Paginated history', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  await user('History turn 2').waitFor();
  await revert('History turn 2').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/shepherd-revert-mobile.png' });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Revert confirmation overflows mobile');
  await confirm.click();
  await page.getByText('Conversation reverted. Files were not changed.', { exact: true }).waitFor();
  await user('History turn 1').waitFor();
  if (await user('History turn 2').count() || await user('History turn 34').count()) throw Error('Older-page revert retained later turns');
  if (await page.getByRole('button', { name: 'Load earlier messages', exact: true }).count()) throw Error('Old pagination survived revert');
  await revert('History turn 0').click();
  await confirm.click();
  await page.getByRole('heading', { name: 'A new thread of thought', exact: true }).waitFor();
  if (await page.locator('article.message').count()) throw Error('Reverting the first turn did not empty history');
  await send('Conversation still works after reverting everything');
  await page.getByLabel('Choose images', { exact: true }).setInputFiles('/tmp/shepherd-image-input-fixtures/only.png');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
  const imageMessage = page.locator('article.message-user').filter({ has: page.getByRole('img', { name: 'Attached image 1', exact: true }) });
  await imageMessage.getByRole('button', { name: 'Revert from here', exact: true }).click();
  await dialog.getByText('[Image message]', { exact: true }).waitFor();
  await confirm.click();
  await imageMessage.waitFor({ state: 'hidden' });
  await user('Conversation still works after reverting everything').waitFor();
  if (errors.length) throw Error(errors.join('\n'));
  return 'Copy/revert placement, cancellation, cutoff inclusion, multi-client reset, stale selections, image-only turns, stale snapshots, replay, uncertain recovery, compaction, approval guards, older pages, first-turn revert, mobile layout, and continued input passed.';
}
