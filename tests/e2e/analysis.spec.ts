import { expect, test, type Locator, type Page } from "@playwright/test";

const articleUrl = "https://example.com/sol-news";
const supportedBaseUrl = "http://127.0.0.1:5173";
const insufficientBaseUrl = "http://127.0.0.1:5174";

type Verdict = "LONG" | "NO_TRADE";

async function submitAnalysis(
  page: Page,
  options: { baseUrl?: string; verdict?: Verdict } = {},
) {
  const baseUrl = options.baseUrl ?? supportedBaseUrl;
  const verdict = options.verdict ?? "LONG";
  await page.goto(baseUrl);
  await page.getByLabel("News URL").fill(articleUrl);
  await page.getByLabel("Token symbol").fill("SOL");
  await page.getByLabel("Balanced").check();

  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/analyses",
  );
  await page.getByRole("button", { name: "Analyze evidence" }).click();
  expect((await responsePromise).status()).toBe(201);
  await expect(page.getByRole("heading", { name: verdict })).toBeVisible();
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

async function expectPanelFits(panel: Locator, keyContent: Locator) {
  await expect(panel).toBeVisible();
  await expect(keyContent).toBeVisible();
  const fit = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      insideViewport: rect.left >= 0 && rect.right <= window.innerWidth,
      noInternalOverflow: element.scrollWidth <= element.clientWidth + 1,
    };
  });
  expect(fit).toEqual({ insideViewport: true, noInternalOverflow: true });

  const contentFit = await keyContent.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= window.innerWidth;
  });
  expect(contentFit).toBe(true);
}

async function expectWorkspaceScreenshot(
  page: Page,
  name: string,
  maskReceipt: boolean,
) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page).toHaveScreenshot(name, {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    mask: maskReceipt
      ? [page.locator(".receipt-id-row code"), page.locator(".receipt-panel time")]
      : [],
    maskColor: "#6b7280",
    scale: "css",
  });
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
});

test("persists and replays a full-stack evidence-insufficient decision", async ({ page }) => {
  await submitAnalysis(page, { baseUrl: insufficientBaseUrl, verdict: "NO_TRADE" });

  await expect(page.getByText("Claim unsupported")).toBeVisible();
  await expect(page.getByText("No practice position was created.")).toBeVisible();
  await expect(page.getByText("Practice size")).toHaveCount(0);

  const receiptId = await page.locator(".receipt-id-row code").textContent();
  expect(receiptId).toBeTruthy();
  const storedStatus = await page.evaluate(async (id) => {
    const response = await fetch(`/api/receipts/${encodeURIComponent(id)}`);
    return response.status;
  }, receiptId!);
  expect(storedStatus).toBe(200);

  await page.getByRole("button", { name: "Replay receipt" }).click();
  await expect(page.getByText("Replay matched stored decision")).toBeVisible();
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

test("supports bounded mobile panels and keyboard navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile interaction contract");
  await submitAnalysis(page);

  const tabs = page.getByRole("tablist", { name: "Analysis views" });
  await expect(tabs.getByRole("tab")).toHaveCount(4);
  const panelChecks = [
    { id: "decision", tab: "Decision", heading: "LONG" },
    { id: "claims", tab: "Claims", heading: "Claim ledger" },
    { id: "debate", tab: "Debate", heading: "Evidence debate" },
    { id: "evidence", tab: "Evidence", heading: "Evidence" },
  ] as const;

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    for (const panelCheck of panelChecks) {
      await tabs.getByRole("tab", { name: panelCheck.tab }).click();
      const panel = page.locator(`#view-${panelCheck.id}`);
      await expectPanelFits(
        panel,
        panel.getByRole("heading", { name: panelCheck.heading, exact: true }),
      );
      await expectNoHorizontalOverflow(page);
    }
  }

  const evidenceTab = tabs.getByRole("tab", { name: "Evidence" });
  await evidenceTab.press("ArrowRight");
  const decisionTab = tabs.getByRole("tab", { name: "Decision" });
  await expect(decisionTab).toBeFocused();
  await expect(decisionTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Decision receipt" })).toBeVisible();
});

test("matches deterministic supported workspace visuals", async ({ page }, testInfo) => {
  await submitAnalysis(page);

  if (testInfo.project.name === "desktop") {
    await expectWorkspaceScreenshot(page, "supported-workspace.png", true);
    return;
  }

  for (const panel of ["Decision", "Claims", "Debate", "Evidence"] as const) {
    await page.getByRole("tab", { name: panel }).click();
    await expectWorkspaceScreenshot(
      page,
      `supported-${panel.toLowerCase()}.png`,
      panel === "Decision",
    );
  }
});

test("shows a safe analysis-stage message when the network fails", async ({ page }) => {
  await page.route("**/api/analyses", async (route) => {
    await route.abort("failed");
  });
  await page.goto(supportedBaseUrl);
  await page.getByLabel("News URL").fill(articleUrl);
  await page.getByRole("button", { name: "Analyze evidence" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "Analysis request could not reach the service. Check your connection and try again.",
  );
  await expect(alert).not.toContainText("Failed to fetch");
  await expect(page.getByRole("button", { name: "Analyze evidence" })).toBeEnabled();
});
