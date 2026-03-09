const knex = require('knex');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'employees.db');

let db;

function getDb() {
  if (!db) {
    db = knex({
      client: 'sqlite3',
      connection: { filename: DB_PATH },
      useNullAsDefault: true,
    });
  }
  return db;
}

async function initializeSchema() {
  const database = getDb();
  const exists = await database.schema.hasTable('employees');
  if (!exists) {
    await database.schema.createTable('employees', (table) => {
      table.increments('id').primary();
      table.string('name').notNullable();
      table.string('email').notNullable().unique();
      table.string('department').notNullable();
      table.string('role').notNullable();
      table.string('hire_date').notNullable();
    });
  }
}

async function closeDb() {
  if (db) {
    await db.destroy();
    db = null;
  }
}

module.exports = { getDb, initializeSchema, closeDb };
