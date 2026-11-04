const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function query(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

function genId() {
  return require('crypto').randomBytes(16).toString('hex');
}
function now() {
  return Date.now();
}
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}
function comparePassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

module.exports = { pool, query, genId, now, hashPassword, comparePassword };
