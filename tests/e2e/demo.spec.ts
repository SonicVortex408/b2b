import { expect, test, type Page } from "@playwright/test";

/** The spec's demo order: map → AI booking → conflict + bump explanation → QR no-show release → Simulate Chaos → analytics. */

async function openRoom(page: Page, id: string) {
  await page.locator(`[data-room-id="${id}"].room`).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
const closeCard = (page: Page) => page.getByRole("dialog").getByRole("button", { name: "Close" }).click({ force: true });
const asRole = (page: Page, email: string) => page.getByLabel("Demo role").selectOption({ label: email });

test.beforeEach(async ({ page }) => {
  await page.goto("/map");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('[data-room-id="F1-13"].room')).toBeVisible();
});

test("1. map: every floor renders, room morphs into a card, booking goes through hold + preview", async ({ page }) => {
  for (const [lvl, id] of [
    ["Level 2", "F2-01"],
    ["Level 3", "F3-01"],
    ["Level 1", "F1-14"],
  ] as const) {
    await page.getByRole("tab", { name: lvl }).click();
    await expect(page.locator(`[data-room-id="${id}"].room`)).toBeVisible();
  }
  await openRoom(page, "F1-14");
  await page.getByRole("dialog").getByRole("button", { name: /^(Book|Request) for / }).click();
  await expect(page.getByRole("dialog").getByText(/held \d+s/)).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Free. Confirms instantly.")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("dialog").getByText("Booked ✓")).toBeVisible();
});

test("2. AI booking: 'hall for 80 with a projector' ranks the Seminar Hall first", async ({ page }) => {
  await page.getByRole("button", { name: "Ask XIE Spaces" }).click();
  await page.getByRole("button", { name: /hall for 80 people/ }).click();
  await expect(page.locator("[data-option]").first()).toContainText("Seminar Hall");
});

test("3. conflict: an exam bumps a club booking and the loser gets an explanation + offers", async ({ page }) => {
  const card = page.getByRole("dialog");
  await openRoom(page, "F1-14");
  await card.getByLabel("Purpose").selectOption("club_event");
  await card.getByRole("button", { name: /^(Book|Request) for / }).click();
  await card.getByRole("button", { name: "Confirm booking" }).click();
  const text = (await card.getByText(/Demo Student booked Conference Room/).textContent()) ?? "";
  const [, h, m, ap] = text.match(/(\d{1,2}):(\d{2}) ([AP]M)–/)!;
  const minutes = ((Number(h) % 12) + (ap === "PM" ? 12 : 0)) * 60 + Number(m);
  await closeCard(page);

  await asRole(page, "admin@xie.demo");
  await page.getByLabel("Time scrubber").fill(String(minutes));
  await openRoom(page, "F1-14");
  await card.getByLabel("Purpose").selectOption("exam");
  await card.getByRole("button", { name: /anyway/ }).click();
  await expect(card.getByText(/would be bumped/)).toBeVisible();
  await card.getByRole("button", { name: "Confirm booking" }).click();
  await expect(card.getByText("Booked · lower-priority booking bumped")).toBeVisible();
  await closeCard(page);

  await asRole(page, "student@xie.demo");
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const notice = page.getByRole("complementary").getByText(/was moved because Exam/).first();
  await expect(notice).toBeVisible();
  await expect(notice.locator("xpath=ancestor::li[1]").getByRole("button").first()).toBeVisible(); // rebooking offers
  await page.getByRole("button", { name: "Conflict center" }).click();
  await expect(page.getByRole("complementary")).toContainText("Demo Student: 1");
});

test("4. QR: a missed check-in (no-show) releases the slot", async ({ page }) => {
  await page.getByRole("button", { name: "My bookings" }).click();
  await expect(page.getByRole("complementary")).toContainText("Points");
  await page.getByRole("button", { name: "My bookings" }).click();
  await openRoom(page, "F1-14");
  await page.getByRole("dialog").getByRole("button", { name: /^(Book|Request) for / }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm booking" }).click();
  await closeCard(page);
  await page.getByRole("button", { name: "My bookings" }).click();
  await page.getByRole("complementary").getByRole("button", { name: "Simulate no-show" }).first().click();
  await expect(page.getByText(/No QR check-in within 10 min/).first()).toBeVisible();
});

test("5. Simulate Chaos finishes with 0 double bookings and a readable log", async ({ page }) => {
  await page.getByRole("button", { name: /Simulate Chaos/ }).click();
  await expect(page.getByText("Chaos resolved")).toBeVisible({ timeout: 30_000 });
  const tile = page.getByRole("complementary").getByText("double bookings").locator("..");
  await expect(tile).toContainText("0");
  await expect(page.getByRole("complementary").getByRole("listitem").first()).toBeVisible();
});

test("6. analytics + admin tools render; occupancy simulator flags squatters", async ({ page }) => {
  await asRole(page, "admin@xie.demo");
  await page.getByRole("button", { name: "Admin" }).click();
  await expect(page.getByText("Utilisation heatmap")).toBeVisible();
  await expect(page.getByText("Rules editor · blackouts")).toBeVisible();
  await page.getByRole("button", { name: "Run occupancy simulator" }).click();
  await expect(page.getByText(/Forecast: labs next wk/)).toBeVisible();
});
