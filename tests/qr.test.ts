import { describe, expect, it } from "vitest";
import { issueQr, verifyQr } from "@/lib/server/qr";

describe("QR check-in tokens", () => {
  it("verifies for the right room within 60 s", () => {
    const { token } = issueQr("F1-05", 1_000_000);
    expect(verifyQr(token, "F1-05", 1_030_000)).toEqual({ ok: true });
  });
  it("rejects expired, wrong-room and tampered tokens", () => {
    const { token } = issueQr("F1-05", 1_000_000);
    expect(verifyQr(token, "F1-05", 1_061_000)).toMatchObject({ ok: false, reason: "expired" });
    expect(verifyQr(token, "F2-10", 1_000_000).ok).toBe(false);
    expect(verifyQr(token.slice(0, -2) + "xx", "F1-05", 1_000_000).ok).toBe(false);
  });
});
