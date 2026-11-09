import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { describeSpawnFailure } from '../lib/probe.mjs';

test('Error text: a start failure without stdout/stderr shows message and code, never "undefined"', () => {
  const error = Object.assign(new Error('spawn /x/node EACCES'), { code: 'EACCES' });
  const text = describeSpawnFailure({ error, status: null, signal: null });
  assert.match(text, /spawn \/x\/node EACCES \(EACCES\)/);
  assert.doesNotMatch(text, /undefined|null/);
});

test('Error text: exit status with stdout and stderr', () => {
  const text = describeSpawnFailure({ status: 3, stdout: 'output\n', stderr: 'error\n' });
  assert.match(text, /Exit status 3/);
  assert.match(text, /stdout:\noutput/);
  assert.match(text, /stderr:\nerror/);
});

test('Error text: empty outputs and signal', () => {
  assert.match(describeSpawnFailure({ status: null, signal: 'SIGKILL', stdout: '', stderr: null }), /signal SIGKILL/);
  assert.doesNotMatch(describeSpawnFailure({ status: 1, stdout: '', stderr: '' }), /stdout|stderr/);
  assert.match(describeSpawnFailure({}), /unknown error/);
});

test('Error text: real spawnSync failure (file does not exist)', () => {
  const result = spawnSync('/does/not/exist-cm-probe', [], { encoding: 'utf8' });
  assert.match(describeSpawnFailure(result), /ENOENT/);
});
