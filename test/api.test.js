const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

let child;
let baseUrl;
const tempDir = mkdtempSync(path.join(tmpdir(), 'ledger-api-'));

test.before(async () => {
  const port = 3400 + Math.floor(Math.random() * 200);
  child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), DATABASE_FILE: path.join(tempDir, 'test.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  baseUrl = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server startup timeout')), 5000);
    child.stdout.on('data', (data) => {
      if (data.toString().includes('listening')) { clearTimeout(timeout); resolve(); }
    });
    child.on('error', reject);
  });
});

test.after(async () => {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  rmSync(tempDir, { recursive: true, force: true });
});

async function request(method, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('creates accounts and applies immutable transactions atomically', async () => {
  const account = await request('POST', '/accounts', { name: 'Main' });
  assert.equal(account.status, 201);
  const credit = await request('POST', `/accounts/${account.body.data.id}/transactions`, { type: 'credit', amount: 100, reference_id: 'a' });
  assert.equal(credit.status, 201);
  const duplicate = await request('POST', `/accounts/${account.body.data.id}/transactions`, { type: 'credit', amount: 50, reference_id: 'a' });
  assert.equal(duplicate.status, 409);
  const debit = await request('POST', `/accounts/${account.body.data.id}/transactions`, { type: 'debit', amount: 30, reference_id: 'b' });
  assert.equal(debit.status, 201);
  const rejected = await request('POST', `/accounts/${account.body.data.id}/transactions`, { type: 'debit', amount: 1000, reference_id: 'c' });
  assert.equal(rejected.status, 409);
  const current = await request('GET', `/accounts/${account.body.data.id}`);
  assert.equal(current.body.data.balance, 70);
  const transactions = await request('GET', `/accounts/${account.body.data.id}/transactions?page=1&limit=1`);
  assert.equal(transactions.body.pagination.total_records, 2);
  assert.equal(transactions.body.pagination.total_pages, 2);
});

test('transfers both sides atomically', async () => {
  const source = await request('POST', '/accounts', { name: 'Source' });
  const destination = await request('POST', '/accounts', { name: 'Destination' });
  await request('POST', `/accounts/${source.body.data.id}/transactions`, { type: 'credit', amount: 100, reference_id: 'seed' });
  const transfer = await request('POST', '/transfers', {
    source_account_id: source.body.data.id,
    destination_account_id: destination.body.data.id,
    amount: 40,
    reference_id: 'move-1',
  });
  assert.equal(transfer.status, 201);
  assert.equal(transfer.body.data.source_account.balance, 60);
  assert.equal(transfer.body.data.destination_account.balance, 40);
});
