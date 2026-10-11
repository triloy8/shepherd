// Run against a fresh tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async page => {
  await page.route('**/api/conversations/*/turns?*', async route => {
    const response = await route.fetch();
    const history = await response.json();
    history.data[0].items = [{ id: 'long-answer', type: 'assistant_message', phase: 'final', text: Array.from({length:45}, (_, i) => `Paragraph ${i + 1}: a conversation long enough to scroll through older messages.`).join('\n\n') }];
    await route.fulfill({response, json:history});
  });
  await page.getByRole('button', {name:'A new home for Shepherd', exact:true}).click();
  await page.getByRole('status', {name:'Connected', exact:true}).waitFor();
  const scroll = page.locator('.chat-scroll');
  const latest = page.getByRole('button', {name:'Go to latest message', exact:true});
  const composer = page.getByRole('textbox', {name:'Message Shepherd', exact:true});
  await page.waitForFunction(() => { const el = document.querySelector('.chat-scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 120; });
  if (await latest.count()) throw Error('Latest button appears at the bottom');
  await scroll.evaluate(el => el.scrollTop = 0);
  await latest.waitFor();
  await composer.fill('Keep this draft');
  await latest.click();
  await latest.waitFor({state:'hidden'});
  if (await composer.inputValue() !== 'Keep this draft') throw Error('Jump changed the draft');
  if (await composer.evaluate(el => el === document.activeElement)) throw Error('Jump focused the composer');
  if (!await scroll.evaluate(el => el === document.activeElement)) throw Error('Jump did not keep focus in the conversation');
  await page.waitForFunction(() => { const el = document.querySelector('.chat-scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 2; });
  for (const width of [320,390,768,1280]) {
    await page.setViewportSize({width,height:844});
    await scroll.evaluate(el => el.scrollTop = 0);
    await latest.waitFor();
    const button = await latest.boundingBox();
    const input = await page.locator('.composer').boundingBox();
    const header = await page.locator('.main-header').boundingBox();
    if (button.width < 44 || button.height < 44 || button.x < 0 || button.x + button.width > width || button.y < header.y + header.height || button.y + button.height >= input.y) throw Error(`Latest button placement invalid at ${width}`);
  }
  await page.setViewportSize({width:390,height:844});
  await composer.fill('First line\nSecond line\nThird line');
  await latest.waitFor();
  await page.screenshot({path:'/tmp/shepherd-go-to-latest.png'});
  await page.evaluate(() => { Object.defineProperty(window.visualViewport,'height',{configurable:true,value:430}); window.visualViewport.dispatchEvent(new Event('resize')); });
  await page.waitForFunction(() => document.querySelector('.app-shell').getBoundingClientRect().height === 430);
  const button = await latest.boundingBox();
  const input = await page.locator('.composer').boundingBox();
  if (button.y + button.height >= input.y || button.y < 56) throw Error('Keyboard hides the latest button');
  await composer.fill(Array.from({length:40}, () => 'A longer draft').join('\n'));
  await page.waitForFunction(() => { const button = document.querySelector('.latest-button').getBoundingClientRect(); const input = document.querySelector('.composer').getBoundingClientRect(); return button.bottom < input.top && button.top >= 56; });
  await page.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize')); });
  // New responses must not pull a reader away from older messages.
  await composer.fill('markdown streaming');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await latest.waitFor();
  await page.getByRole('button',{name:'Interrupt response',exact:true}).waitFor({state:'hidden'});
  if (await scroll.evaluate(el => el.scrollTop) > 100) throw Error('Response pulled the reader to the bottom');
  await latest.click();
  await latest.waitFor({state:'hidden'});
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'Paginated history',exact:true}).click();
  await page.getByRole('status',{name:'Connected',exact:true}).waitFor();
  await page.waitForFunction(() => { const el = document.querySelector('.chat-scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 120; });
  if (await latest.count()) throw Error('Conversation switch retained the latest button');
  return 'Latest visibility, draft preservation, focus, 320/390/768/1280 placement, keyboard, reader position and conversation switch passed';
}
