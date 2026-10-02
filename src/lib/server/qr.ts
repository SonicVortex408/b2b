import { createHmac, timingSafeEqual } from "node:crypto";

/** Signed, rotating QR check-in tokens: HS256 JWT, 60 s TTL, per-room secret derived from QR_SECRET. */
const MASTER = process.env.QR_SECRET || "dev-only-qr-secret-change-me";
const TTL = 60;

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const roomSecret = (roomId: string) => createHmac("sha256", MASTER).update(`room:${roomId}`).digest();

export function issueQr(roomId: string, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(JSON.stringify({ room: roomId, iat, exp: iat + TTL, nonce: b64(createHmac("sha256", MASTER).update(`${roomId}:${iat}`).digest().subarray(0, 6)) }));
  const sig = b64(createHmac("sha256", roomSecret(roomId)).update(`${header}.${payload}`).digest());
  return { token: `${header}.${payload}.${sig}`, exp: iat + TTL };
}

export function verifyQr(token: string, roomId: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return { ok: false, reason: "malformed" };
  const expect = createHmac("sha256", roomSecret(roomId)).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, "base64url");
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return { ok: false, reason: "bad signature or wrong room" };
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  if (claims.room !== roomId) return { ok: false, reason: "wrong room" };
  if (Math.floor(now / 1000) > claims.exp) return { ok: false, reason: "expired" };
  return { ok: true };
}
