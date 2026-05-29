import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Pure normalisation helper — extracted so it can be tested without DynamoDB
function normaliseName(name) {
  return (name || '').toLowerCase().trim();
}

test('normaliseName lowercases and trims', () => {
  assert.equal(normaliseName('  19822 - เซเว่นอีเลฟเว่น  '), '19822 - เซเว่นอีเลฟเว่น');
});

test('normaliseName handles null', () => {
  assert.equal(normaliseName(null), '');
});
