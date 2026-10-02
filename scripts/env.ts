/** Load .env, .env.local etc. exactly like Next.js does, so scripts see the same variables as the app. */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
