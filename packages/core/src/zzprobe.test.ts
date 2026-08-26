import { test, expect, describe } from 'bun:test';
import { homedir } from 'os';

test('plain failure with homedir', () => {
  expect(homedir()).toBe('/definitely/not/the/homedir');
});

describe('isInCooldown > cooldown', () => {
  test('nested failure & entity <check>', () => {
    expect({ path: homedir(), n: 1 }).toEqual({ path: '/nope', n: 2 });
  });
  test('passing one', () => { expect(1).toBe(1); });
});

test('thrown error failure', () => {
  throw new Error(`boom in ${homedir()}/secret-project`);
});
