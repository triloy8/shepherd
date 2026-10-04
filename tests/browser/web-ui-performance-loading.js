// Run against a fresh tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async page => {
  await page.goto('http://127.0.0.1:8799');
  let releaseApprovals;
  const approvalsGate = new Promise(resolve => { releaseApprovals = resolve; });
  await page.route('**/api/v1/conversations/*/approvals', async route => {
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
    if (Object.values(counts).some(value => value)) throw Error('Closed settings fetched optional data');
    releaseApprovals();
    await page.getByRole('status', {name:'Connected',exact:true}).waitFor();
    await page.getByRole('button', {name:'Conversation menu',exact:true}).click();
    await page.getByRole('menuitem', {name:'Conversation settings',exact:true}).click();
    await page.getByRole('button', {name:'More models',exact:true}).waitFor();
    if (counts.models !== 1 || counts.context || counts.limits || counts.skills) throw Error('Collapsed settings fetched optional data: '+JSON.stringify(counts));
    await page.getByText('Usage and account limits', {exact:true}).click();
    await page.getByText('Primary window: 25% used', {exact:true}).waitFor();
    await page.getByText('Skills', {exact:true}).click();
    await page.getByRole('button', {name:'Reload skills',exact:true}).waitFor();
    if (!counts.context || !counts.limits || !counts.skills) throw Error('Expanded settings did not fetch their data');
    return {historyLoadedBeforeApprovals:true, requests:counts};
  } finally {
    releaseApprovals();
    await page.unrouteAll({behavior:'wait'});
  }
}
