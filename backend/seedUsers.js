// Run once to create your first accounts: node seedUsers.js
// Safe to run again later too - it skips any staff_id that already exists
// rather than overwriting it.

const pool = require('./db');
const { hashPassword } = require('./auth');

const ACCOUNTS = [
  { staff_id: 'admin', password: 'admin123', full_name: 'System Administrator', role: 'admin' },
  { staff_id: 'staff1', password: 'staff123', full_name: 'Library Staff', role: 'staff' },
];

async function seed() {
  for (const acc of ACCOUNTS) {
    const [existing] = await pool.query('SELECT id FROM users WHERE staff_id = ?', [acc.staff_id]);
    if (existing.length) {
      console.log(`Skipped "${acc.staff_id}" - already exists.`);
      continue;
    }
    const password_hash = hashPassword(acc.password);
    await pool.query(
      'INSERT INTO users (staff_id, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      [acc.staff_id, password_hash, acc.full_name, acc.role]
    );
    console.log(`Created ${acc.role} account: staff_id="${acc.staff_id}" password="${acc.password}"`);
  }
  console.log('\nDone. Change these passwords before using this for anything beyond a demo.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});