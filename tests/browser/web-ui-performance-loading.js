// Run against a fresh tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async page => {
  let releaseApprovals;
  const approvalsGate = new Promise(resolve => { releaseApprovals = resolve; });
  await page.route('**/api/conversations/*/approvals', async route => {
    await approvalsGate;
    await route.continue();
  });
  const counts = { models: 0, context: 0, limits: 0, skills: 0 };
  page.on('request', request => {
    const name = new URL(request.url()).pathname.split('/').at(-1);
    if (Object.hasOwn(counts, name)) counts[name]++;
  });
  try {
    await page.getByRole('button', {name:'A new home for Shepherd',exact:true}).click();
    await page.getByText('The shared API is ready.', {exact:false}).waitFor({timeout:5000});
    if (counts.models || counts.limits || counts.skills) throw Error('Composer fetched optional catalogs');
    releaseApprovals();
    await page.getByRole('status', {name:'Connected',exact:true}).waitFor();
    await page.getByRole('button', {name:'Model and effort',exact:true}).click();
    await page.getByRole('button', {name:'More models',exact:true}).waitFor();
    if (counts.models !== 1 || counts.limits || counts.skills) throw Error('Model picker fetched unrelated data: '+JSON.stringify(counts));
    await page.keyboard.press('Escape');
    await page.getByRole('button', {name:'Conversation context',exact:true}).click();
    await page.getByText('No context telemetry yet. Send a turn first.', {exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', {name:'Conversation menu',exact:true}).click();
    await page.getByRole('menuitem', {name:'Skills',exact:true}).click();
    await page.getByRole('button', {name:'Reload skills',exact:true}).waitFor();
    if (!counts.context || !counts.skills || counts.limits) throw Error('Controls fetched unexpected data');
    return {historyLoadedBeforeApprovals:true, requests:counts};
  } finally {
    releaseApprovals();
    await page.unrouteAll({behavior:'wait'});
  }
}
