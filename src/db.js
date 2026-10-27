const Database = require('better-sqlite3');

function createDatabase(filename = process.env.DATABASE_FILE || 'ledger.db') {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      description TEXT,
      reference_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS transactions_account_reference
      ON transactions(account_id, reference_id);
    CREATE INDEX IF NOT EXISTS transactions_account_created
      ON transactions(account_id, created_at DESC, id DESC);
  `);
  return db;
}

module.exports = { createDatabase };
