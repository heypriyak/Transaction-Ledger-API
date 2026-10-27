const http = require('node:http');
const { URL } = require('node:url');
const { createDatabase } = require('./db');

const db = createDatabase();
const PORT = Number(process.env.PORT || 3000);

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function parseId(value, field = 'id') {
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a positive integer`);
  }
  return Number(value);
}

function parseAmount(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'amount must be a positive integer in the smallest currency unit');
  }
  return value;
}

function parsePagination(url) {
  const pageValue = url.searchParams.get('page') || '1';
  const limitValue = url.searchParams.get('limit') || '20';
  if (!/^[1-9]\d*$/.test(pageValue) || !/^[1-9]\d*$/.test(limitValue)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'page and limit must be positive integers');
  }
  const page = Number(pageValue);
  const limit = Number(limitValue);
  if (limit > 100) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'limit must not exceed 100');
  }
  return { page, limit, offset: (page - 1) * limit };
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (!body) return {};
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must contain valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
  }
  return parsed;
}

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function getAccount(accountId) {
  const account = db.prepare('SELECT id, name, balance, created_at FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  return account;
}

function createAccount(body) {
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'name is required');
  }
  const result = db.prepare('INSERT INTO accounts (name, created_at) VALUES (?, ?)').run(body.name.trim(), now());
  return getAccount(result.lastInsertRowid);
}

function listAccounts(url) {
  const { page, limit, offset } = parsePagination(url);
  const total = db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count;
  const accounts = db.prepare(
    'SELECT id, name, balance, created_at FROM accounts ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
  ).all(limit, offset);
  return { data: accounts, pagination: { current_page: page, page_size: limit, total_records: total, total_pages: Math.ceil(total / limit) } };
}

function validateTransaction(body) {
  if (body.type !== 'credit' && body.type !== 'debit') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'type must be either credit or debit');
  }
  parseAmount(body.amount);
  if (typeof body.reference_id !== 'string' || !body.reference_id.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'reference_id is required');
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'description must be a string');
  }
}

function createTransaction(accountId, body) {
  validateTransaction(body);
  getAccount(accountId);
  try {
    const transaction = db.transaction(() => {
      const account = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(accountId);
      if (body.type === 'debit' && account.balance < body.amount) {
        throw new ApiError(409, 'INSUFFICIENT_BALANCE', 'Insufficient account balance');
      }
      const delta = body.type === 'credit' ? body.amount : -body.amount;
      db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').run(delta, accountId);
      const result = db.prepare(
        'INSERT INTO transactions (account_id, type, amount, description, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(accountId, body.type, body.amount, body.description || null, body.reference_id.trim(), now());
      return db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
    })();
    return transaction;
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new ApiError(409, 'DUPLICATE_TRANSACTION', 'reference_id already exists for this account');
    }
    throw error;
  }
}

function listTransactions(accountId, url) {
  getAccount(accountId);
  const { page, limit, offset } = parsePagination(url);
  const total = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE account_id = ?').get(accountId).count;
  const data = db.prepare(
    'SELECT id, account_id, type, amount, description, reference_id, created_at FROM transactions WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
  ).all(accountId, limit, offset);
  return { data, pagination: { current_page: page, page_size: limit, total_records: total, total_pages: Math.ceil(total / limit) } };
}

function transfer(body) {
  const sourceId = parseId(body.source_account_id, 'source_account_id');
  const destinationId = parseId(body.destination_account_id, 'destination_account_id');
  if (sourceId === destinationId) throw new ApiError(400, 'VALIDATION_ERROR', 'source and destination accounts must differ');
  parseAmount(body.amount);
  if (typeof body.reference_id !== 'string' || !body.reference_id.trim()) throw new ApiError(400, 'VALIDATION_ERROR', 'reference_id is required');
  if (body.description !== undefined && typeof body.description !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', 'description must be a string');
  try {
    return db.transaction(() => {
      const source = getAccount(sourceId);
      const destination = getAccount(destinationId);
      if (source.balance < body.amount) throw new ApiError(409, 'INSUFFICIENT_BALANCE', 'Insufficient source account balance');
      const timestamp = now();
      db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').run(body.amount, sourceId);
      db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').run(body.amount, destinationId);
      const insert = db.prepare('INSERT INTO transactions (account_id, type, amount, description, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      insert.run(sourceId, 'debit', body.amount, body.description || 'Transfer', `${body.reference_id}:debit`, timestamp);
      insert.run(destinationId, 'credit', body.amount, body.description || 'Transfer', `${body.reference_id}:credit`, timestamp);
      return { source_account: getAccount(sourceId), destination_account: getAccount(destinationId) };
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ApiError(409, 'DUPLICATE_TRANSACTION', 'reference_id already exists for this transfer');
    throw error;
  }
}

async function handler(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'GET' && parts.length === 0) {
      return send(response, 200, {
        name: 'Transaction Ledger API',
        status: 'ok',
        documentation: '/API.md',
        endpoints: {
          accounts: '/accounts',
          transfers: '/transfers',
        },
      });
    }
    if (request.method === 'POST' && parts.length === 1 && parts[0] === 'accounts') return send(response, 201, { data: createAccount(await readJson(request)) });
    if (request.method === 'GET' && parts.length === 1 && parts[0] === 'accounts') return send(response, 200, listAccounts(url));
    if (request.method === 'GET' && parts.length === 2 && parts[0] === 'accounts') return send(response, 200, { data: getAccount(parseId(parts[1], 'account_id')) });
    if (request.method === 'POST' && parts.length === 3 && parts[0] === 'accounts' && parts[2] === 'transactions') return send(response, 201, { data: createTransaction(parseId(parts[1], 'account_id'), await readJson(request)) });
    if (request.method === 'GET' && parts.length === 3 && parts[0] === 'accounts' && parts[2] === 'transactions') return send(response, 200, listTransactions(parseId(parts[1], 'account_id'), url));
    if (request.method === 'POST' && parts.length === 1 && parts[0] === 'transfers') return send(response, 201, { data: transfer(await readJson(request)) });
    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_ERROR', 'Internal server error');
    if (!(error instanceof ApiError)) console.error(error);
    send(response, apiError.status, { error: { code: apiError.code, message: apiError.message, details: apiError.details } });
  }
}

const server = http.createServer(handler);
if (require.main === module) server.listen(PORT, () => console.log(`Transaction Ledger API listening on port ${PORT}`));

module.exports = { server, db };
