/** Seeds rooms, two weeks of bookings, the exam blackout and the 4 demo users. Needs SUPABASE_SERVICE_ROLE_KEY. */
import { seedDatabase, serviceClient } from "@/lib/remote/supabaseStorage";

seedDatabase(serviceClient(), { users: true })
  .then((r) => console.log(`seeded ${r.bookings} bookings + demo users (password: $DEMO_PASSWORD or xie-demo-2026)`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
