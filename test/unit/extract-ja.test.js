import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractCode } from '../../extension/core/extract.js';
import { POSITIVE_JA, NEGATIVE_JA } from '../fixtures/emails-ja.js';

for (const email of POSITIVE_JA) {
  test(`finds the code: ${email.name}`, () => {
    const result = extractCode(email);
    assert.equal(result?.code ?? null, email.expect, `reason: ${result?.reason}, score: ${result?.score}`);
  });
}

for (const email of NEGATIVE_JA) {
  test(`finds nothing: ${email.name}`, () => {
    const result = extractCode(email);
    assert.equal(result, null, `found ${result?.code} (${result?.reason}, score ${result?.score})`);
  });
}
