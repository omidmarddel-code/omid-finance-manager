import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const stores = {
  transactions: { key: 'id', fields: ['id', 'kind', 'title', 'amount', 'category', 'date', 'note'] },
  installments: { key: 'id', fields: ['id', 'name', 'monthly_amount', 'total_amount', 'months', 'paid_count', 'start_date', 'due_day', 'next_due_date', 'due_month'] },
  payments: { key: 'id', fields: ['id', 'installment_id', 'period', 'amount', 'paid_at'] },
  categories: { key: 'id', fields: ['id', 'name'] },
  settings: { key: 'key', fields: ['key', 'value'] },
  budgets: { key: 'month', fields: ['month', 'amount'] },
  savings_transfers: { key: 'period', fields: ['period', 'amount', 'created_at'] },
  savings_movements: { key: 'id', fields: ['id', 'kind', 'amount', 'date', 'note', 'transaction_id', 'payment_id'] },
  checks: { key: 'id', fields: ['id', 'title', 'amount', 'due_date', 'created_at'] }
};

const schema = `
  CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, amount REAL NOT NULL, category TEXT, date TEXT NOT NULL, note TEXT);
  CREATE TABLE IF NOT EXISTS installments (id TEXT PRIMARY KEY, name TEXT NOT NULL, monthly_amount REAL NOT NULL, total_amount REAL NOT NULL, months INTEGER NOT NULL, paid_count INTEGER NOT NULL DEFAULT 0, start_date TEXT NOT NULL, due_day INTEGER NOT NULL, next_due_date TEXT, due_month TEXT);
  CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, installment_id TEXT NOT NULL, period TEXT NOT NULL, amount REAL NOT NULL, paid_at TEXT NOT NULL, UNIQUE(installment_id, period));
  CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS budgets (month TEXT PRIMARY KEY, amount REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS savings_transfers (period TEXT PRIMARY KEY, amount REAL NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS savings_movements (id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL, note TEXT, transaction_id TEXT, payment_id TEXT);
  CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, title TEXT NOT NULL, amount REAL NOT NULL, due_date TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(date);
  CREATE INDEX IF NOT EXISTS payments_period_idx ON payments(period);
`;

let sqlite;
let connection;
let browserDb;
let native = false;

function openBrowserDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('hamrah-finance', 4);
    request.onupgradeneeded = () => {
      const db = request.result;
      Object.entries(stores).forEach(([name, definition]) => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: definition.key });
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function initializeDatabase() {
  native = Capacitor.isNativePlatform();
  if (native) {
    sqlite = new SQLiteConnection(CapacitorSQLite);
    const exists = await sqlite.isConnection('hamrah-finance', false);
    connection = exists.result
      ? await sqlite.retrieveConnection('hamrah-finance', false)
      : await sqlite.createConnection('hamrah-finance', false, 'no-encryption', 1, false);
    await connection.open();
    await connection.execute(schema);
    const installmentColumns = new Set((await connection.query('PRAGMA table_info(installments)')).values?.map((column) => column.name) ?? []);
    if (!installmentColumns.has('next_due_date')) await connection.execute('ALTER TABLE installments ADD COLUMN next_due_date TEXT');
    if (!installmentColumns.has('due_month')) await connection.execute('ALTER TABLE installments ADD COLUMN due_month TEXT');
    const movementColumns = new Set((await connection.query('PRAGMA table_info(savings_movements)')).values?.map((column) => column.name) ?? []);
    if (!movementColumns.has('transaction_id')) await connection.execute('ALTER TABLE savings_movements ADD COLUMN transaction_id TEXT');
    if (!movementColumns.has('payment_id')) await connection.execute('ALTER TABLE savings_movements ADD COLUMN payment_id TEXT');
  } else {
    browserDb = await openBrowserDatabase();
  }
  if ((await all('categories')).length === 0) {
    for (const name of ['غذا', 'خانه', 'خودرو', 'سوخت', 'خرید', 'درمان', 'تفریح', 'قبوض', 'موبایل', 'پوشاک', 'سایر']) {
      await save('categories', { id: crypto.randomUUID(), name });
    }
  }
  return { native };
}

function runBrowser(storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = browserDb.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function all(storeName) {
  if (!stores[storeName]) throw new Error('Unknown database table');
  if (!native) return (await runBrowser(storeName, 'readonly', (store) => store.getAll())) ?? [];
  const result = await connection.query(`SELECT * FROM ${storeName}`);
  return result.values ?? [];
}

export async function save(storeName, row) {
  const definition = stores[storeName];
  if (!definition) throw new Error('Unknown database table');
  if (!native) return runBrowser(storeName, 'readwrite', (store) => store.put(row));
  const columns = definition.fields.join(', ');
  const placeholders = definition.fields.map(() => '?').join(', ');
  const updates = definition.fields.filter((field) => field !== definition.key).map((field) => `${field}=excluded.${field}`).join(', ');
  const values = definition.fields.map((field) => row[field] ?? null);
  await connection.run(
    `INSERT INTO ${storeName} (${columns}) VALUES (${placeholders}) ON CONFLICT(${definition.key}) DO UPDATE SET ${updates}`,
    values
  );
}

export async function remove(storeName, key) {
  const definition = stores[storeName];
  if (!definition) throw new Error('Unknown database table');
  if (!native) return runBrowser(storeName, 'readwrite', (store) => store.delete(key));
  await connection.run(`DELETE FROM ${storeName} WHERE ${definition.key} = ?`, [key]);
}

export async function clearStore(storeName) {
  if (!stores[storeName]) throw new Error('Unknown database table');
  if (!native) return runBrowser(storeName, 'readwrite', (store) => store.clear());
  await connection.run(`DELETE FROM ${storeName}`);
}

export const isNativeDatabase = () => native;
