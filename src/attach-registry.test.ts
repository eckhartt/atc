import { expect, test } from 'bun:test';
import { AttachRegistry } from './attach-registry';

test('it reports the smallest width and height across attached clients', () => {
  const registry = new AttachRegistry<string>();

  registry.attach('s1', 'a', { cols: 100, rows: 24 });
  registry.attach('s1', 'b', { cols: 80, rows: 30 });

  expect(registry.findEffectiveDims('s1')).toStrictEqual({ cols: 80, rows: 24 });
});

test('it reports no dims for a session with no attached clients', () => {
  const registry = new AttachRegistry<string>();

  expect(registry.findEffectiveDims('s1')).toBeNull();
});

test('it updates dims only for an attached client', () => {
  const registry = new AttachRegistry<string>();

  registry.attach('s1', 'a', { cols: 100, rows: 24 });

  expect(registry.updateDims('s1', 'a', { cols: 90, rows: 20 })).toBeTrue();
  expect(registry.updateDims('s1', 'stranger', { cols: 10, rows: 10 })).toBeFalse();
  expect(registry.findEffectiveDims('s1')).toStrictEqual({ cols: 90, rows: 20 });
});

test('it detaches one client from every session it watched', () => {
  const registry = new AttachRegistry<string>();

  registry.attach('s1', 'a', { cols: 80, rows: 24 });
  registry.attach('s2', 'a', { cols: 80, rows: 24 });
  registry.attach('s2', 'b', { cols: 100, rows: 30 });

  const affected = registry.detachAll('a');

  expect(affected).toStrictEqual(['s1', 's2']);
  expect(registry.collectClients('s1')).toStrictEqual([]);
  expect(registry.collectClients('s2')).toStrictEqual(['b']);
});

test('it keeps other sessions when one is removed', () => {
  const registry = new AttachRegistry<string>();

  registry.attach('s1', 'a', { cols: 80, rows: 24 });
  registry.attach('s2', 'a', { cols: 80, rows: 24 });
  registry.removeSession('s1');

  expect(registry.hasClient('s1', 'a')).toBeFalse();
  expect(registry.hasClient('s2', 'a')).toBeTrue();
});
