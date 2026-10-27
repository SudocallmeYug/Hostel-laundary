import pkg from '../lib/db/node_modules/pg/lib/index.js';
const { Pool } = pkg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function seedBookings() {
  const studentsRes = await pool.query(`SELECT id, name, roll_number, role FROM laundry_students ORDER BY id`);
  const students = studentsRes.rows;
  if (!students.length) return;

  const machinesRes = await pool.query(`SELECT id FROM laundry_machines ORDER BY id`);
  const machines = machinesRes.rows;

  const now = new Date();
  // Saturday of this week
  const day = now.getDay();
  const diffToSat = (6 - day + 7) % 7;
  const sat = new Date(now);
  sat.setDate(now.getDate() + diffToSat);
  sat.setHours(9, 0, 0, 0);

  const slot1Start = new Date(sat);
  const slot1End = new Date(sat.getTime() + 30 * 60 * 1000);

  const slot2Start = new Date(sat.getTime() + 60 * 60 * 1000);
  const slot2End = new Date(sat.getTime() + 90 * 60 * 1000);

  if (students.length >= 2 && machines.length >= 2) {
    await pool.query(`
      INSERT INTO laundry_bookings (student_id, machine_id, start_at, end_at, status)
      VALUES 
        ($1, $2, $3, $4, 'upcoming'),
        ($5, $6, $7, $8, 'upcoming')
      ON CONFLICT DO NOTHING;
    `, [
      students[0].id, machines[0].id, slot1Start, slot1End,
      students[1].id, machines[1].id, slot2Start, slot2End
    ]);
    console.log('Sample laundry bookings created.');
  }

  await pool.end();
}

seedBookings().catch(console.error);
