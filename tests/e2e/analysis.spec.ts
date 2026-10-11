import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { createDemoDependencies } from "../../src/server/analysis/demo-fixture.js";
import { createAnalysisPipeline } from "../../src/server/analysis/pipeline.js";

const articleUrl = "https://example.com/sol-news";
const screenshotDirectory = path.resolve("test-results/visual");

async function submitAnalysis(page: Page) {
  await page.goto("/");
  await page.getByLabel("News URL").fill(articleUrl);
  await page.getByLabel("Token symbol").fill("SOL");
  await page.getByLabel("Balanced").check();
  await page.getByRole("button", { name: "Analyze evidence" }).click();
  await expect(page.getByRole("heading", { name: "LONG" })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true);
}

async function expectControlFits(control: Locator) {
  await expect(control).toBeVisible();
  const fit = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      insideViewport: rect.left >= 0 && rect.right <= window.innerWidth,
      textFits: element.scrollWidth <= element.clientWidth + 1
        && element.scrollHeight <= element.clientHeight + 1,
    };
  });
  expect(fit).toEqual({ insideViewport: true, textFits: true });
}

test("creates and replays a supported practice decision", async ({ page }, testInfo) => {
  await submitAnalysis(page);

  await expect(page.getByText("SignalCourt is for evidence review and simulated practice only. It is not financial advice."))
    .toBeVisible();
  await expect(page.getByText("Practice decision only. Not a trade instruction."))
    .toBeVisible();
  if (testInfo.project.name === "mobile") {
    await page.getByRole("tab", { name: "Evidence" }).click();
  }
  await expect(page.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible();
  await expect(page.getByText("Simulated", { exact: true }).first()).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await page.getByRole("tab", { name: "Decision" }).click();
  }
  await expect(page.getByRole("heading", { name: "Decision receipt" })).toBeVisible();

  await page.getByRole("button", { name: "Replay receipt" }).click();
  await expect(page.getByText("Replay matched stored decision")).toBeVisible();

  await mkdir(screenshotDirectory, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: path.join(screenshotDirectory, `${testInfo.project.name}-success.png`),
    fullPage: true,
    animations: "disabled",
  });
});

test("renders an evidence-insufficient decision without a practice position", async ({ page }) => {
  const receipt = await createAnalysisPipeline(
    createDemoDependencies("insufficient"),
  ).run({ articleUrl, token: "SOL", riskLevel: "balanced" });

  await page.route("**/api/analyses", async (route) => {
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(receipt) });
  });
  await page.goto("/");
  await page.getByLabel("News URL").fill(articleUrl);
  await page.getByRole("button", { name: "Analyze evidence" }).click();

  await expect(page.getByRole("heading", { name: "NO_TRADE" })).toBeVisible();
  await expect(page.getByText("Claim unsupported")).toBeVisible();
  await expect(page.getByText("No practice position was created.")).toBeVisible();
  await expect(page.getByText("Practice size")).toHaveCount(0);
});

test("keeps the successful workspace within desktop and narrow viewport bounds", async ({ page }) => {
  await submitAnalysis(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page);
    await expectControlFits(page.getByRole("button", { name: "Analyze evidence" }));
    if (viewport.width <= 820) {
      await expectControlFits(page.getByRole("tab", { name: "Decision" }));
      await expectControlFits(page.getByRole("tab", { name: "Evidence" }));
    }
  }
});

test("supports four mobile analysis tabs and keyboard navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile interaction contract");
  await submitAnalysis(page);

  const tabs = page.getByRole("tablist", { name: "Analysis views" });
  await expect(tabs.getByRole("tab")).toHaveCount(4);

  const claimsTab = tabs.getByRole("tab", { name: "Claims" });
  await claimsTab.click();
  await expect(page.getByRole("heading", { name: "Claim ledger" })).toBeVisible();

  const debateTab = tabs.getByRole("tab", { name: "Debate" });
  await debateTab.click();
  await expect(page.getByRole("heading", { name: "Evidence debate" })).toBeVisible();

  const evidenceTab = tabs.getByRole("tab", { name: "Evidence" });
  await evidenceTab.click();
  await expect(page.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible();
  await evidenceTab.press("ArrowRight");

  const decisionTab = tabs.getByRole("tab", { name: "Decision" });
  await expect(decisionTab).toBeFocused();
  await expect(decisionTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Decision receipt" })).toBeVisible();
});

test("shows a safe analysis-stage message when the network fails", async ({ page }) => {
  await page.route("**/api/analyses", async (route) => {
    await route.abort("failed");
  });
  await page.goto("/");
  await page.getByLabel("News URL").fill(articleUrl);
  await page.getByRole("button", { name: "Analyze evidence" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "Analysis request could not reach the service. Check your connection and try again.",
  );
  await expect(alert).not.toContainText("Failed to fetch");
  await expect(page.getByRole("button", { name: "Analyze evidence" })).toBeEnabled();
});
