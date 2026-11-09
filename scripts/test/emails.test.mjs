import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTACT_ADDRESS, findAddresses, forbiddenInCommit, forbiddenInFile } from '../lib/emails.mjs';

// Addresses are put together at run time: a literal one in this file would be reported by the very check it tests.
const at = (user, domain) => [user, domain].join('@');
const PRIVATE = at('jane.doe', 'mailbox.org');
const GITHUB_NOREPLY = at('12345+someone', 'users.noreply.github.com');

test('Emails: finds addresses, but not npm specifiers or file names', () => {
  const first = at('someone', 'mail.example.org');
  const second = at('a.b+c', 'host.io');
  assert.deepEqual(findAddresses(`write to ${first} or ${second}.`), [first, second]);
  assert.deepEqual(findAddresses('"@fastify/static": "^10.1.10", react@19.3.1, icon@2x.png, @worldfoundry/backend'), []);
});

test('Emails: files may carry the contact address and placeholders only', () => {
  assert.deepEqual(forbiddenInFile(`Contact: <${CONTACT_ADDRESS}>`), []);
  assert.deepEqual(forbiddenInFile([at('admin', 'example.com'), at('x', 'host.invalid'), at('y', 'service.test')].join(', ')), []);
  assert.deepEqual(forbiddenInFile(`Maintainer: ${PRIVATE}`), [PRIVATE]);
  // a no-reply address still names an account: it belongs into commits, not into files
  assert.deepEqual(forbiddenInFile(GITHUB_NOREPLY), [GITHUB_NOREPLY]);
});

test('Emails: commits may come from no-reply addresses only', () => {
  assert.deepEqual(forbiddenInCommit(`${GITHUB_NOREPLY} ${at('noreply', 'github.com')}`), []);
  assert.deepEqual(forbiddenInCommit(`Co-Authored-By: Claude <${at('noreply', 'anthropic.com')}>`), []);
  assert.deepEqual(forbiddenInCommit(PRIVATE), [PRIVATE]);
  const lookalike = at('someone', 'users.noreply.github.com.evil.org');
  assert.deepEqual(forbiddenInCommit(lookalike), [lookalike]);
});
