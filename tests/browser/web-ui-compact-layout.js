// Run against tests/fixtures/web-ui-host.ts with playwright-cli run-code.
async page => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/host/battery', route => route.fulfill({ json: { battery: { percentage: 100, status: 'full' } } }));
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  const menuButton = page.getByRole('button', { name: 'Conversation menu', exact: true });
  const details = page.getByRole('dialog', { name: 'Conversation details', exact: true });
  await page.locator('.main-header').getByRole('button', { name: 'Swarm · 0', exact: true }).waitFor();
  await page.getByRole('img', { name: /^Host battery: 100%/ }).waitFor();
  if (await page.locator('.main-header').getByRole('button').count() !== 5) throw Error('Unexpected header controls');
  if (await page.locator('.main-header').getByText('Connected', { exact: true }).evaluate(el => !el.classList.contains('sr-only'))) throw Error('Status label still consumes header space');
  if (await page.getByText('A little context goes a long way', { exact: true }).count()) throw Error('Composer helper remains');
  await page.screenshot({ path: '/tmp/shepherd-layout-desktop.png' });

  // Keyboard navigation, Escape and focus restoration in the consolidated menu.
  await menuButton.focus(); await page.keyboard.press('ArrowDown');
  if (!await page.getByRole('menuitem', { name: 'Skills', exact: true }).evaluate(el => el === document.activeElement)) throw Error('Menu did not focus first option');
  await page.keyboard.press('End');
  if (!await page.getByRole('menuitem', { name: 'Archive conversation', exact: true }).evaluate(el => el === document.activeElement)) throw Error('Menu End navigation failed');
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Skills', exact: true });
  await settings.waitFor(); await settings.getByRole('button', { name: 'Close skills', exact: true }).click();
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
      const headerElement = document.querySelector('.main-header');
      const header = headerElement.getBoundingClientRect();
      const items = [...headerElement.children].filter(el => el.getBoundingClientRect().width > 0).map(el => el.getBoundingClientRect());
      const actionGroup = headerElement.querySelector('.conversation-header-actions');
      const statusButton = headerElement.querySelector('[aria-label^="Connection details:"]');
      const statusBounds = statusButton.getBoundingClientRect();
      const dot = statusButton.querySelector('.status-dot').getBoundingClientRect();
      const batteryIndicator = actionGroup.querySelector('[role="img"]');
      const battery = batteryIndicator.getBoundingClientRect();
      const sidebarButton = headerElement.querySelector('[aria-label="Open conversations"]');
      const sidebarBounds = sidebarButton.getBoundingClientRect();
      const hamburger = sidebarButton.querySelector('path').getBoundingClientRect();
      const menuButton = actionGroup.querySelector('[aria-label="Conversation menu"]');
      const menuBounds = menuButton.getBoundingClientRect();
      const ellipsis = menuButton.querySelector('path').getBoundingClientRect();
      const swarm = actionGroup.querySelector('button[aria-haspopup="dialog"]').getBoundingClientRect();
      const compactWidths = new Map([[sidebarButton, 20], [statusButton, 16], [menuButton, 22]]);
      const titleButton = headerElement.querySelector('h1 button');
      const titleBounds = titleButton.getBoundingClientRect();
      const labelInsets = [titleButton, batteryIndicator].flatMap(element => {
        const { paddingLeft, paddingRight } = getComputedStyle(element);
        return [parseFloat(paddingLeft), parseFloat(paddingRight)];
      });
      const form = document.querySelector('.composer').getBoundingClientRect();
      const dock = document.querySelector('.composer-area').getBoundingClientRect();
      const stage = document.querySelector('.conversation-stage').getBoundingClientRect();
      return { headerHeight:header.height, inset:form.left - stage.left, bottom:form.bottom, stageBottom:stage.bottom,
        headerGaps: items.slice(1).map((item, index) => item.left - items[index].right),
        headerGap: parseFloat(getComputedStyle(headerElement).columnGap),
        mobileGaps: [sidebarBounds, titleBounds, statusBounds, menuBounds, swarm, battery].map((item, index, bounds) =>
          item.left - (bounds[index - 1]?.right ?? header.left)
        ).concat(header.right - battery.right),
        iconInsets: [
          hamburger.left - sidebarBounds.left, sidebarBounds.right - hamburger.right,
          dot.left - statusBounds.left, statusBounds.right - dot.right,
          ellipsis.left - menuBounds.left, menuBounds.right - ellipsis.right,
          ...labelInsets,
        ],
        statusDotCentered: Math.abs(dot.left + dot.width / 2 - (statusBounds.left + statusBounds.width / 2)) <= 1 &&
          Math.abs(dot.top + dot.height / 2 - (statusBounds.top + statusBounds.height / 2)) <= 1,
        headerAligned: items.every(item => Math.abs(item.top + item.height / 2 - (header.top + header.height / 2)) <= 1),
        headerOverflow: items.some(item => item.left < header.left || item.right > header.right),
        titleWidth: headerElement.querySelector('h1').getBoundingClientRect().width,
        reserve:parseFloat(getComputedStyle(document.querySelector('.chat-content')).paddingBottom), dockHeight:dock.height,
        controls:[...document.querySelectorAll('.main-header .icon-button, .composer .icon-button, .composer .send-button')].map(el => {
          const { width, height } = el.getBoundingClientRect();
          return { width, height, compactWidth: compactWidths.get(el) ?? null };
        }).filter(control => control.width || control.height) };
    });
    if (geometry.headerHeight > 64 || geometry.inset < 10 || geometry.bottom >= geometry.stageBottom) throw Error(`Floating layout invalid at ${width}`);
    if (!geometry.headerAligned || geometry.headerOverflow || geometry.headerGaps.some(gap => Math.abs(gap - geometry.headerGap) > 1)) throw Error(`Uneven header spacing at ${width}`);
    if (!geometry.statusDotCentered) throw Error(`Status dot is off-center at ${width}`);
    if (width < 640 && geometry.mobileGaps.some(gap => Math.abs(gap - 4) > 1)) throw Error(`Header controls lack uniform 4px spacing at ${width}`);
    if (width < 640 && geometry.iconInsets.some(inset => Math.abs(inset - 4) > 1)) throw Error(`Header icons lack 4px tap insets at ${width}`);
    if (width < 640 && geometry.titleWidth < (width === 320 ? 20 : 90)) throw Error(`Header controls crowd the title at ${width}`);
    if (await page.getByRole('button', { name: 'Swarm · 0', exact: true }).innerText() !== 'Swarm · 0') throw Error(`Swarm label is hidden at ${width}`);
    if (geometry.reserve < geometry.dockHeight) throw Error('Composer covers the last transcript message');
    if (geometry.controls.some(control => {
      if (width < 640 && control.compactWidth !== null) return control.height < 44 || Math.abs(control.width - control.compactWidth) > 1;
      return control.height < 44 || control.width < 44;
    })) throw Error(`Unexpected touch target size at ${width}`);
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
      const composer = document.querySelector('.composer-dock').getBoundingClientRect();
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

  const drawer = page.getByRole('dialog', { name: 'Conversations', exact: true });
  const sidebarButton = page.getByRole('button', { name: 'Open conversations', exact: true });
  const swipe = (points, cancelled = false) => page.locator('.chat-scroll').evaluate((element, { points, cancelled }) => {
    const emit = (type, [clientX, clientY], active) => {
      const touch = { identifier: 1, clientX, clientY };
      element.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), {
        touches: active ? [touch] : [], changedTouches: [touch],
      }));
    };
    emit('touchstart', points[0], true);
    for (const point of points.slice(1)) emit('touchmove', point, true);
    emit(cancelled ? 'touchcancel' : 'touchend', points.at(-1), false);
  }, { points, cancelled });
  await swipe([[80, 180], [175, 181]]);
  await swipe([[14, 180], [22, 235], [115, 235]]);
  await swipe([[14, 180], [115, 181]], true);
  if (await drawer.count()) throw Error('Unrelated or cancelled touch gesture opened the sidebar');
  await swipe([[14, 180], [48, 184], [115, 185]]);
  await drawer.waitFor();
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  if (!await sidebarButton.evaluate(el => el === document.activeElement)) throw Error('Swipe-opened sidebar lost return focus');

  // Sidebar's host dialog must remain interactive after the mobile drawer closes.
  await sidebarButton.click();
  await drawer.waitFor();
  await page.keyboard.press('Shift+Tab'); // stay in the drawer rather than reaching the transcript
  if (!await page.locator('.sidebar').evaluate(el => el.contains(document.activeElement))) throw Error('Drawer focus escaped');
  await page.getByRole('button', { name: 'Host controls', exact: true }).click();
  const host = page.getByRole('dialog', { name: 'Host controls', exact: true });
  await host.getByRole('button', { name: 'Refresh host status', exact: true }).click();
  await host.getByRole('button', { name: 'Close host controls', exact: true }).click();
  if (await drawer.count()) throw Error('Host dialog left drawer open');
  await composer.fill('Draft still here');
  await page.setViewportSize({width:1280,height:900});
  await sidebarButton.click();
  if (await page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().width > 1)) throw Error('Desktop sidebar did not collapse');
  await swipe([[14, 180], [115, 185]]);
  if (await page.locator('.sidebar-open').count()) throw Error('Edge swipe opened the mobile drawer on desktop');
  await sidebarButton.click();
  if (await composer.inputValue() !== 'Draft still here') throw Error('Sidebar toggle lost draft');
  await composer.fill('Compact layout still sends');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Interrupt response', exact: true }).waitFor({ state:'hidden' });
  await page.locator('.chat-scroll').evaluate(el => el.scrollTop = el.scrollHeight);
  const final = page.locator('.message-assistant').last();
  if (await final.evaluate(el => el.getBoundingClientRect().bottom) > await page.locator('.composer').evaluate(el=>el.getBoundingClientRect().top)) throw Error('Last response is obscured by composer');
  if (errors.length) throw Error(errors.join('\n'));
  return 'Compact header, menu keyboard/focus, connection details, bounded auto-grow, draft retention, 320/390/768/1280 widths, touch sizes, transcript clearance, keyboard viewport height/panning/dismissal, pinch zoom, mobile edge swipe, sidebar host dialog, and send passed.';
}
