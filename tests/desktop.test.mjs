import test from 'node:test';
import assert from 'node:assert/strict';
import {props, desktopScope} from '../server/desktop.mjs';

test('props parses systemctl/loginctl key=value output', () => {
  assert.deepEqual(props('Id=gdm.service\nLoadState=loaded\nActiveState=active\nMemoryCurrent=7204864'),
    {Id: 'gdm.service', LoadState: 'loaded', ActiveState: 'active', MemoryCurrent: '7204864'});
  assert.deepEqual(props('Description=a=b'), {Description: 'a=b'});
  assert.deepEqual(props(''), {});
});

test('desktop memory counts desktop app scopes, not tmux sessions kept by Homebase', () => {
  assert.equal(desktopScope('app-gnome-firefox-4321.scope'), true);
  assert.equal(desktopScope('homebase-tmux-claude-1794372364748.scope'), false);
  assert.equal(desktopScope('init.scope'), false);
  assert.equal(desktopScope('homebase.service'), false);
});
