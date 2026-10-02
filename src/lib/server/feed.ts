import { createHmac } from "node:crypto";

const secret = () => process.env.QR_SECRET || "dev-only-qr-secret-change-me";
export const feedSig = (name: string) => createHmac("sha256", secret()).update(`feed:${name}`).digest("base64url").slice(0, 32);
