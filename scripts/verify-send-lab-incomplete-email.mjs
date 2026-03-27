/**
 * Mock Resend HTTP — ensures sendLabImportIncompleteEmail builds a valid request.
 */
import assert from 'node:assert/strict';
import { sendLabImportIncompleteEmail } from '../lib/sendLabImportIncompleteEmail.js';

const prev = globalThis.fetch;
try {
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /resend\.com\/emails/);
    const body = JSON.parse(init.body);
    assert.ok(body.to && body.to[0] === 'user@example.com');
    assert.match(body.text, /Lab/);
    assert.match(body.subject, /השלמת/);
    return { ok: true, json: async () => ({ id: 're_mock' }) };
  };

  const r = await sendLabImportIncompleteEmail({
    apiKey: 're_test_key',
    fromEmail: 'noreply@example.com',
    toEmail: 'user@example.com',
    replyTo: null,
    missing: ['חסר ניסוי'],
    filename: 'f.xlsx'
  });
  assert.equal(r.sent, true);
} finally {
  globalThis.fetch = prev;
}

console.log('verify-send-lab-incomplete-email: OK');
