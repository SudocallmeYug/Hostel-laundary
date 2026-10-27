import pkg from '../lib/db/node_modules/pg/lib/index.js';
const { Pool } = pkg;

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!CLERK_SECRET_KEY || !DATABASE_URL) {
  console.error('Missing CLERK_SECRET_KEY or DATABASE_URL');
  process.exit(1);
}

const accounts = [
  {
    firstName: 'Aarav',
    lastName: 'Sharma',
    rollNumber: '23BCE1001',
    room: 'A-101',
    email: 'aarav.sharma.hostel@gmail.com',
    password: 'Washroom2026#Secure',
    role: 'student'
  },
  {
    firstName: 'Rohan',
    lastName: 'Verma',
    rollNumber: '23BCE1002',
    room: 'A-102',
    email: 'rohan.verma.hostel@gmail.com',
    password: 'Washroom2026#Secure',
    role: 'student'
  },
  {
    firstName: 'Priya',
    lastName: 'Patel',
    rollNumber: '23BCE1003',
    room: 'B-201',
    email: 'priya.patel.hostel@gmail.com',
    password: 'Washroom2026#Secure',
    role: 'student'
  },
  {
    firstName: 'Ananya',
    lastName: 'Iyer',
    rollNumber: '23BCE1004',
    room: 'B-202',
    email: 'ananya.iyer.hostel@gmail.com',
    password: 'Washroom2026#Secure',
    role: 'student'
  },
  {
    firstName: 'Kabir',
    lastName: 'Singh',
    rollNumber: '23BCE1005',
    room: 'C-301',
    email: 'kabir.singh.hostel@gmail.com',
    password: 'Washroom2026#Secure',
    role: 'student'
  },
  {
    firstName: 'Vikram',
    lastName: 'Malhotra',
    rollNumber: '23BCE1006',
    room: 'M-001',
    email: 'vikram.manager.hostel@gmail.com',
    password: 'Washroom2026#Secure',
    role: 'manager'
  },
  {
    firstName: 'Admin',
    lastName: 'WASHROOM',
    rollNumber: 'admin',
    room: 'ADMIN',
    email: 'admin.washroom.hostel@gmail.com',
    password: 'Adm!nW@sh2026#X9',
    role: 'admin'
  }
];

async function seed() {
  console.log('--- Seeding Clerk Users ---');
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  
  // Fetch existing users from Clerk to avoid duplicate username errors
  const existingUsersRes = await fetch('https://api.clerk.com/v1/users?limit=50', {
    headers: { 'Authorization': `Bearer ${CLERK_SECRET_KEY}` }
  });
  const existingUsers = await existingUsersRes.json();
  const existingByUsername = new Map();
  if (Array.isArray(existingUsers)) {
    for (const u of existingUsers) {
      if (u.username) existingByUsername.set(u.username.toLowerCase(), u);
    }
  }

  for (const acc of accounts) {
    const cleanUsername = acc.rollNumber.toLowerCase();
    let clerkUserId = null;

    if (existingByUsername.has(cleanUsername)) {
      const u = existingByUsername.get(cleanUsername);
      clerkUserId = u.id;
      console.log(`User ${acc.rollNumber} already exists in Clerk (${clerkUserId}). Updating password...`);
      // Update password and metadata to ensure correct credentials
      await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${CLERK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          password: acc.password,
          skip_password_checks: true,
          bypass_client_trust: true,
          public_metadata: {
            room: acc.room,
            rollNumber: acc.rollNumber,
            role: acc.role
          }
        })
      });
    } else {
      console.log(`Creating ${acc.rollNumber} (${acc.firstName} ${acc.lastName})...`);
      const createRes = await fetch('https://api.clerk.com/v1/users', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CLERK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email_address: [acc.email],
          username: cleanUsername,
          first_name: acc.firstName,
          last_name: acc.lastName,
          password: acc.password,
          skip_password_checks: true,
          bypass_client_trust: true,
          public_metadata: {
            room: acc.room,
            rollNumber: acc.rollNumber,
            role: acc.role
          }
        })
      });
      const data = await createRes.json();
      if (data.id) {
        clerkUserId = data.id;
        console.log(`Created Clerk user: ${clerkUserId}`);
      } else {
        console.error(`Failed to create ${acc.rollNumber}:`, JSON.stringify(data));
        continue;
      }
    }

    // Upsert into Neon DB
    await pool.query(`
      INSERT INTO laundry_students (clerk_user_id, name, room, roll_number, email, role)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (clerk_user_id) 
      DO UPDATE SET 
        name = EXCLUDED.name,
        room = EXCLUDED.room,
        roll_number = EXCLUDED.roll_number,
        email = EXCLUDED.email,
        role = EXCLUDED.role;
    `, [
      clerkUserId,
      `${acc.firstName} ${acc.lastName}`,
      acc.room,
      acc.rollNumber,
      acc.email,
      acc.role
    ]);
    console.log(`Synced ${acc.rollNumber} to Neon PostgreSQL database.`);
  }

  // Ensure default laundry machines exist
  await pool.query(`
    INSERT INTO laundry_machines (name, is_active)
    VALUES ('Washer 01', true), ('Washer 02', true)
    ON CONFLICT (name) DO NOTHING;
  `);

  console.log('\n--- Seeding Complete! ---');
  await pool.end();
}

seed().catch(err => {
  console.error('Seed script error:', err);
  process.exit(1);
});
