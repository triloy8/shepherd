// Run against tests/fixtures/web-ui-host.ts with playwright-cli run-code.
async page => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  const menuButton = page.getByRole('button', { name: 'Conversation menu', exact: true });
  const details = page.getByRole('dialog', { name: 'Conversation details', exact: true });
  if (await page.locator('.main-header').getByRole('button').count() !== 4) throw Error('Header contains extra controls');
  if (await page.locator('.main-header').getByText('Connected', { exact: true }).evaluate(el => !el.classList.contains('sr-only'))) throw Error('Status label still consumes header space');
  if (await page.getByText('A little context goes a long way', { exact: true }).count()) throw Error('Composer helper remains');
  await page.screenshot({ path: '/tmp/shepherd-layout-desktop.png' });

  // Keyboard navigation, Escape and focus restoration in the consolidated menu.
  await menuButton.focus(); await page.keyboard.press('ArrowDown');
  if (!await page.getByRole('menuitem', { name: 'Conversation settings', exact: true }).evaluate(el => el === document.activeElement)) throw Error('Menu did not focus first option');
  await page.keyboard.press('End');
  if (!await page.getByRole('menuitem', { name: 'Archive conversation', exact: true }).evaluate(el => el === document.activeElement)) throw Error('Menu End navigation failed');
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Conversation settings', exact: true });
  await settings.waitFor(); await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  if (!await menuButton.evaluate(el => el === document.activeElement)) throw Error('Settings did not restore menu focus');
  await menuButton.click(); await page.keyboard.press('Escape');
  if (await page.getByRole('menu', { name: 'Conversation options', exact: true }).count()) throw Error('Escape left menu open');
  if (!await menuButton.evaluate(el => el === document.activeElement)) throw Error('Menu Escape lost focus');
  await menuButton.focus(); await page.keyboard.press('ArrowUp');
  if (!await page.getByRole('menuitem', { name: 'Archive conversation', exact: true }).evaluate(el => el === document.activeElement)) throw Error('ArrowUp did not open at the final option');
  await page.keyboard.press('Shift+Tab');
  if (!await page.getByRole('button', { name: 'Connection details: Connected', exact: true }).evaluate(el => el === document.activeElement)) throw Error('Menu Tab did not return to header navigation');
  await menuButton.click(); await composer.click();
  if (await page.getByRole('menu', { name: 'Conversation options', exact: true }).count()) throw Error('Outside click left menu open');
  await page.getByRole('button', { name: 'Connection details: Connected', exact: true }).click();
  await details.getByText('stored', { exact: true }).waitFor();
  const project = await details.locator('dt').filter({ hasText: /^Project$/ }).locator('..').locator('dd').innerText();
  if (!project.trim()) throw Error('Conversation details omitted the project');
  await details.getByRole('button', { name: 'Close conversation details', exact: true }).click();

  // Grow and shrink with content, bound long drafts, preserve drafts across widths.
  const initial = await composer.evaluate(el => el.getBoundingClientRect().height);
  await composer.fill('One\nTwo\nThree\nFour\nFive');
  const grown = await composer.evaluate(el => el.getBoundingClientRect().height);
  if (grown <= initial) throw Error('Composer did not grow');
  await composer.fill(Array.from({length:40}, (_, i) => `Line ${i}`).join('\n'));
  if (!await composer.evaluate(el => el.scrollHeight > el.clientHeight && el.getBoundingClientRect().height <= 241)) throw Error('Long draft is unbounded or unscrollable');
  await composer.fill('Compact draft');
  if (await composer.evaluate(el => el.getBoundingClientRect().height) > initial + 1) throw Error('Composer did not shrink');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    if (await composer.inputValue() !== 'Compact draft') throw Error('Resize lost draft');
    const geometry = await page.evaluate(() => {
      const header = document.querySelector('.main-header').getBoundingClientRect();
      const form = document.querySelector('.composer').getBoundingClientRect();
      const dock = document.querySelector('.composer-area').getBoundingClientRect();
      const stage = document.querySelector('.conversation-stage').getBoundingClientRect();
      return { headerHeight:header.height, inset:form.left - stage.left, bottom:form.bottom, stageBottom:stage.bottom,
        reserve:parseFloat(getComputedStyle(document.querySelector('.chat-content')).paddingBottom), dockHeight:dock.height,
        controls:[...document.querySelectorAll('.main-header .icon-button, .composer .icon-button, .composer .send-button')].map(el=>({w:el.getBoundingClientRect().width,h:el.getBoundingClientRect().height})).filter(size => size.w || size.h) };
    });
    if (geometry.headerHeight > 64 || geometry.inset < 10 || geometry.bottom >= geometry.stageBottom) throw Error(`Floating layout invalid at ${width}`);
    if (geometry.reserve < geometry.dockHeight) throw Error('Composer covers the last transcript message');
    if (geometry.controls.some(size => size.w < 44 || size.h < 44)) throw Error('Touch control too small');
    await menuButton.click();
    const menu = await page.getByRole('menu', { name: 'Conversation options', exact: true }).boundingBox();
    if (menu.x < 0 || menu.x + menu.width > width) throw Error('Menu overflows narrow viewport');
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  await page.screenshot({ path: '/tmp/shepherd-layout-mobile.png' });

  // A reduced visual viewport (keyboard) keeps the floating composer in view.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable:true, value:430 });
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => document.querySelector('.app-shell').getBoundingClientRect().height === 430);
  if (await page.locator('.composer').evaluate(el => el.getBoundingClientRect().bottom > 430)) throw Error('Keyboard viewport hides composer');
  // iOS can pan the visual viewport after focus, without another height resize.
  for (const offset of [260, 180, 0]) {
    await page.evaluate(offset => {
      Object.defineProperty(window.visualViewport, 'offsetTop', { configurable:true, value:offset });
      window.visualViewport.dispatchEvent(new Event('scroll'));
    }, offset);
    await page.waitForFunction(offset => {
      const app = document.querySelector('.app-shell').getBoundingClientRect();
      const composer = document.querySelector('.composer').getBoundingClientRect();
      const visibleBottom = offset + window.visualViewport.height;
      return Math.abs(app.top - offset) < 1 && Math.abs(app.bottom - visibleBottom) < 1 &&
        Math.abs(visibleBottom - composer.bottom - 4) < 1;
    }, offset);
  }
  await page.evaluate(() => window.scrollTo(0, 200));
  if (await page.evaluate(() => window.scrollY !== 0)) throw Error('Document scroll competes with the keyboard viewport');
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(Array.from({ length: 4 }, (_, i) => ({name: `compact-${i}.png`, mimeType:'image/png', buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')})));
  await page.getByRole('button', { name: 'Remove compact-3.png', exact: true }).waitFor();
  await composer.fill(Array.from({length:40}, () => 'Long attached draft').join('\n'));
  await page.waitForFunction(() => document.querySelector('.composer').getBoundingClientRect().top >= document.querySelector('.main-header').getBoundingClientRect().bottom);
  await page.getByRole('button', { name: 'Send message', exact: true }).scrollIntoViewIfNeeded();
  for (let i=0; i<4; i++) await page.getByRole('button', { name: `Remove compact-${i}.png`, exact: true }).click();
  await composer.fill('Compact draft');
  await page.evaluate(() => {
    delete window.visualViewport.height; delete window.visualViewport.offsetTop;
    window.visualViewport.dispatchEvent(new Event('resize'));
    window.visualViewport.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(() => Math.abs(document.querySelector('.app-shell').getBoundingClientRect().bottom - window.visualViewport.height) < 1);
  if (await page.locator('.composer-area').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom) < 12)) throw Error('Keyboard dismissal lost normal bottom padding');
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'scale', { configurable:true, value:2 });
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  if (await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-top') || document.documentElement.style.getPropertyValue('--app-height') || document.documentElement.style.getPropertyValue('--composer-bottom-gap'))) throw Error('Keyboard viewport override interferes with pinch zoom');
  await page.evaluate(() => { delete window.visualViewport.scale; window.visualViewport.dispatchEvent(new Event('resize')); });

  // Sidebar's host dialog must remain interactive after the mobile drawer closes.
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  await page.getByRole('dialog', { name: 'Conversations', exact: true }).waitFor();
  await page.keyboard.press('Shift+Tab'); // stay in the drawer rather than reaching the transcript
  if (!await page.locator('.sidebar').evaluate(el => el.contains(document.activeElement))) throw Error('Drawer focus escaped');
  await page.getByRole('button', { name: 'Host controls', exact: true }).click();
  const host = page.getByRole('dialog', { name: 'Host controls', exact: true });
  await host.getByRole('button', { name: 'Refresh host status', exact: true }).click();
  await host.getByRole('button', { name: 'Close host controls', exact: true }).click();
  if (await page.getByRole('dialog', { name: 'Conversations', exact: true }).count()) throw Error('Host dialog left drawer open');
  await composer.fill('Draft still here');
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  if (await page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().width > 1)) throw Error('Desktop sidebar did not collapse');
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  if (await composer.inputValue() !== 'Draft still here') throw Error('Sidebar toggle lost draft');
  await composer.fill('Compact layout still sends');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Interrupt response', exact: true }).waitFor({ state:'hidden' });
  await page.locator('.chat-scroll').evaluate(el => el.scrollTop = el.scrollHeight);
  const final = page.locator('.message-assistant').last();
  if (await final.evaluate(el => el.getBoundingClientRect().bottom) > await page.locator('.composer').evaluate(el=>el.getBoundingClientRect().top)) throw Error('Last response is obscured by composer');
  if (errors.length) throw Error(errors.join('\n'));
  return 'Compact header, menu keyboard/focus, connection details, bounded auto-grow, draft retention, 320/390/768/1280 widths, touch sizes, transcript clearance, keyboard viewport height/panning/dismissal, pinch zoom, sidebar host dialog, and send passed.';
}
