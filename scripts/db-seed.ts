/** Seeds rooms, two weeks of bookings, the exam blackout and the 4 demo users. Needs SUPABASE_SERVICE_ROLE_KEY. */
import "./env";
import { seedDatabase, serviceClient } from "@/lib/remote/supabaseStorage";

seedDatabase(serviceClient(), { users: true })
  .then((r) => console.log(`seeded ${r.bookings} bookings + demo users (password: $DEMO_PASSWORD or xie-demo-2026)`))
  .catch((e) => {
    const msg = String(e?.message ?? e);
    if (/schema cache|does not exist|relation/i.test(msg)) console.error("Tables not found. Run `npm run db:migrate` first (or paste supabase/migrations/0001_init.sql into the SQL Editor).");
    console.error(e);
    process.exit(1);
  });
