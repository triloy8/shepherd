// Run with playwright-cli run-code against a fresh isolated web-ui-host fixture.
async (page) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  const send = async (text) => {
    await page.getByRole('textbox', { name: 'Message Shepherd' }).fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
  };
  await send('answer screenshot');
  const answer = page.locator('.message-assistant').filter({ has: page.locator('img[alt="Desktop view"]') });
  await answer.locator('img').waitFor();
  await page.locator('.progress-disclosure').filter({ has: page.locator('.viewed-image-disclosure') }).locator(':scope > summary').click();
  await page.locator('.viewed-image-disclosure > summary').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.message-assistant img, .viewed-image-disclosure img')].every(img => img.complete && img.naturalWidth > 0));
  await page.evaluate(() => {
    window.imageStabilityNodes = [...document.querySelectorAll('.message-assistant img, .viewed-image-disclosure img')];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } });
  });
  await answer.getByRole('button', { name: 'Copy response', exact: true }).click();
  await answer.getByText('Copied', { exact: true }).waitFor();
  const assertStable = async (reason) => {
    if (!await page.evaluate(() => window.imageStabilityNodes.length === 2 && window.imageStabilityNodes.every(node => node.isConnected && node.complete && node.naturalWidth > 0))) {
      throw Error('Loaded inline/viewed image was replaced during ' + reason);
    }
  };
  await assertStable('Copy state update');
  await send('generate unicorn');
  await page.locator('.assistant-response img[alt="A white unicorn in an enchanted meadow"]').waitFor();
  await page.getByText('Your unicorn is ready.', { exact: true }).waitFor();
  await assertStable('streaming and history updates');
  await page.evaluate(() => {
    window.imageStabilityNodes.push(document.querySelector('.assistant-response img[alt="A white unicorn in an enchanted meadow"]'));
  });
  await send('another update');
  await page.locator('.message-user').getByText('another update', { exact: true }).waitFor();
  await page.waitForFunction(() => window.imageStabilityNodes.length === 3 && window.imageStabilityNodes.every(node => node.isConnected && node.complete && node.naturalWidth > 0));
  await page.waitForTimeout(16000); // Include the periodic history refresh.
  if (!await page.evaluate(() => window.imageStabilityNodes.every(node => node.isConnected))) throw Error('Image was replaced by periodic history refresh');
  if (!await page.locator('.viewed-image-disclosure').evaluate(node => node.open)) throw Error('Refresh closed the viewed image disclosure');
}
