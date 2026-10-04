// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async page => {
  await page.setViewportSize({width:1280,height:900}); await page.goto('http://127.0.0.1:8799');
  const stored=page.getByRole('button',{name:'A new home for Shepherd',exact:true});
  const other=page.getByRole('button',{name:'Paginated history',exact:true});
  const connected=page.getByRole('status',{name:'Connected',exact:true});
  const composer=page.getByRole('textbox',{name:'Message Shepherd',exact:true});
  const select=async(button,title)=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await button.click();await page.getByRole('heading',{name:title,exact:true}).waitFor();await connected.waitFor();};
  await select(stored,'A new home for Shepherd');
  const sentText='Delayed receipt '+Date.now();
  let releaseSend,accepted;const receipt=new Promise(resolve=>accepted=resolve);
  await page.route('**/api/v1/conversations/*/messages',async route=>{
    const response=await route.fetch();const pending=new Promise(resolve=>releaseSend=resolve);accepted();await pending;await route.fulfill({response});
  });
  await composer.fill(sentText);await page.getByRole('button',{name:'Send message',exact:true}).click();await receipt;
  await page.locator('.message-user').filter({hasText:sentText}).waitFor();
  let holdHistory=true;const historyReleases=[];
  await page.route('**/api/v1/conversations/*/turns?*',async route=>{
    if(holdHistory)await new Promise(resolve=>historyReleases.push(resolve));await route.continue();
  });
  const response=page.waitForResponse(r=>r.url().endsWith('/messages'));releaseSend();await response;
  await page.waitForFunction(()=>document.querySelector('[aria-label="Message Shepherd"]').value==='');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const duplicateMessages=await page.locator('.message-user').filter({hasText:sentText}).count();
  if(duplicateMessages!==1)throw Error('Delayed receipt duplicated a canonical message');
  holdHistory=false;historyReleases.forEach(resolve=>resolve());await page.unrouteAll({behavior:'wait'});
  await page.getByRole('button',{name:'Interrupt response',exact:true}).waitFor({state:'hidden'});
  await page.evaluate(()=>{
    const original=FileReader.prototype.readAsDataURL;const pending=[];
    FileReader.prototype.readAsDataURL=function(blob){pending.push({reader:this,blob});};
    window.releaseAuditReads=()=>{
      FileReader.prototype.readAsDataURL=original;
      return Promise.all(pending.map(({reader,blob})=>new Promise(resolve=>{
        reader.addEventListener('loadend',resolve,{once:true});original.call(reader,blob);
      })));
    };
  });
  await page.getByLabel('Choose images',{exact:true}).setInputFiles({name:'first.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64')});
  await page.getByText('Reading images…',{exact:true}).waitFor();
  await select(other,'Paginated history');
  await select(stored,'A new home for Shepherd');
  await page.getByText('Reading images…',{exact:true}).waitFor();
  if(await page.getByLabel('Choose images',{exact:true}).isEnabled())throw Error('Returning to a pending image read unlocked the picker');
  await select(other,'Paginated history');
  await page.evaluate(()=>window.releaseAuditReads());
  if(await page.getByRole('button',{name:'Remove first.png',exact:true}).count())throw Error('Image arrived in another chat');
  await select(stored,'A new home for Shepherd');
  await page.getByRole('button',{name:'Remove first.png',exact:true}).waitFor();
  await page.getByRole('button',{name:'Remove first.png',exact:true}).click();
  await page.evaluate(()=>{
    const original=FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL=function(){window.failRead=()=>{FileReader.prototype.readAsDataURL=original;this.dispatchEvent(new Event('error'));};};
  });
  await page.getByLabel('Choose images',{exact:true}).setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('invalid')});
  await page.getByText('Reading images…',{exact:true}).waitFor();
  await select(other,'Paginated history');
  await page.evaluate(()=>window.failRead());
  if(await page.getByText('Could not read broken.png.',{exact:true}).count())throw Error('Image error arrived in another chat');
  await select(stored,'A new home for Shepherd');
  await page.getByText('Could not read broken.png.',{exact:true}).waitFor();
  await page.getByText('Reading images…',{exact:true}).waitFor({state:'hidden'});
  return 'Delayed receipts reconcile canonical messages; pending image reads remain locked and complete in their originating chat';
}
