import { test, expect, type Page } from '@playwright/test';

/** Scope all selectors to the Risk Calculator section to avoid ambiguity. */
function rcSection(page: Page) {
  return page.locator('section[aria-label="Risk Calculator"]');
}

test.describe('Risk Calculator', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('renders risk calculator section with sell mode by default', async ({
    page,
  }) => {
    const section = rcSection(page);
    await expect(section).toBeVisible();

    // Sell mode is active by default
    const modeGroup = section.getByRole('radiogroup', {
      name: 'Trade mode',
    });
    await expect(modeGroup).toBeVisible();

    // Sell button should be visually active (has active chip styling)
    const sellBtn = modeGroup.getByText('Sell');
    await expect(sellBtn).toBeVisible();

    // Core sell-mode inputs visible
    await expect(section.getByLabel('Account Balance')).toBeVisible();
    await expect(section.getByLabel('Credit Received')).toBeVisible();
    await expect(section.getByLabel('Delta')).toBeVisible();
    await expect(section.getByLabel('PoP %')).toBeVisible();

    // Wing width radiogroup visible in sell mode
    await expect(
      section.getByRole('radiogroup', { name: 'Wing width' }),
    ).toBeVisible();

    // Contracts counter visible
    await expect(section.getByLabel('Decrease contracts')).toBeVisible();
    await expect(section.getByLabel('Increase contracts')).toBeVisible();
  });

  test('switching to buy mode shows premium and target inputs', async ({
    page,
  }) => {
    const section = rcSection(page);
    const modeGroup = section.getByRole('radiogroup', {
      name: 'Trade mode',
    });

    // Click Buy
    await modeGroup.getByText('Buy').click();

    // Buy-specific inputs appear
    await expect(section.getByLabel('Premium Paid')).toBeVisible();
    await expect(section.getByLabel('Target Exit')).toBeVisible();

    // Sell-specific inputs disappear
    await expect(section.getByLabel('Credit Received')).not.toBeVisible();

    // Wing width radiogroup hidden in buy mode
    await expect(
      section.getByRole('radiogroup', { name: 'Wing width' }),
    ).not.toBeVisible();
  });

  test('entering balance and credit shows risk calculations', async ({
    page,
  }) => {
    const section = rcSection(page);

    await section.getByLabel('Account Balance').fill('25000');
    await section.getByLabel('Credit Received').fill('1.50');

    // Results should appear: Total Max Loss, % of Account, BP Required, etc.
    await expect(section.getByText('Total Max Loss')).toBeVisible();
    await expect(section.getByText('% of Account')).toBeVisible();
    await expect(section.getByText('BP Required')).toBeVisible();
    await expect(section.getByText('Risk / Reward')).toBeVisible();

    // With balance=25000, credit=1.50, wing=10 (default):
    // netLoss = (10*100) - (1.50*100) = 850 per contract, 1 contract
    // lossPct = 850/25000 = 3.4%
    // Total Max Loss card shows $850 (multiple elements match, so use first)
    await expect(section.getByText('$850').first()).toBeVisible();
    await expect(section.getByText('3.4%').first()).toBeVisible();
  });

  test('stop loss multiplier changes max loss display', async ({ page }) => {
    const section = rcSection(page);

    await section.getByLabel('Account Balance').fill('25000');
    await section.getByLabel('Credit Received').fill('1.50');

    // Default: no stop (em dash active), net loss = $850
    await expect(section.getByText('$850').first()).toBeVisible();

    // Click 2x stop loss
    await section.getByRole('button', { name: '2\u00D7' }).click();

    // With 2x stop: stopLoss = (2-1) * 150 = $150 per contract
    // min(150, 850) = $150 total max loss
    await expect(section.getByText('$150').first()).toBeVisible();
  });

  test('cap selection changes max positions', async ({ page }) => {
    const section = rcSection(page);

    await section.getByLabel('Account Balance').fill('25000');
    await section.getByLabel('Credit Received').fill('1.50');

    // Default cap is 100%
    await expect(section.getByText(/Max Positions \(at 100%\)/)).toBeVisible();

    // Switch to 25% cap
    await section.getByRole('button', { name: '25%' }).click();

    await expect(section.getByText(/Max Positions \(at 25%\)/)).toBeVisible();
  });

  test('entering PoP shows expected value', async ({ page }) => {
    const section = rcSection(page);

    await section.getByLabel('Account Balance').fill('25000');
    await section.getByLabel('Credit Received').fill('1.50');
    await section.getByLabel('PoP %').fill('85');

    // Expected Value should now show a dollar amount (not em dash)
    await expect(section.getByText('Expected Value')).toBeVisible();

    // EV = (0.85 * 150) - (0.15 * 850) = 127.5 - 127.5 = 0
    // Actually: maxProfit = credit*100 = 150, lossPerContract = 850
    // EV = (85/100)*150 - (15/100)*850 = 127.5 - 127.5 = 0
    // With EV = 0 exactly, it shows $0
    // But with different values, let's use a credit that gives positive EV
    await section.getByLabel('Credit Received').fill('2.00');
    // maxProfit = 200, netLoss = 800
    // EV = 0.85*200 - 0.15*800 = 170 - 120 = +50
    await expect(section.getByText(/\+\$50/).first()).toBeVisible();
  });

  test('risk tier table renders with clickable contract counts', async ({
    page,
  }) => {
    const section = rcSection(page);

    await section.getByLabel('Account Balance').fill('25000');
    await section.getByLabel('Credit Received').fill('1.50');

    // Tier table should be visible
    const tierTable = section.getByRole('table', {
      name: 'Position sizing by risk percentage',
    });
    await expect(tierTable).toBeVisible();

    // Table should have header columns
    await expect(tierTable.getByText('Risk %')).toBeVisible();
    await expect(tierTable.getByText('Budget')).toBeVisible();
    await expect(tierTable.getByText('Max Contracts')).toBeVisible();
    await expect(tierTable.getByText('Max Loss')).toBeVisible();
    await expect(tierTable.getByText('Actual %')).toBeVisible();

    // Should have 5 data rows (tiers: 1%, 2%, 3%, 5%, 10%)
    const rows = tierTable.locator('tbody tr');
    await expect(rows).toHaveCount(5);

    // Click a contract count to set contracts
    // For tier 5% at balance 25000 with loss 850:
    // budget = 25000*0.05 = 1250, maxContracts = floor(1250/850) = 1
    // For tier 10%: budget = 2500, maxContracts = floor(2500/850) = 2
    const tenPctRow = rows.nth(4); // 10% tier is last
    const contractLink = tenPctRow.getByRole('button');
    await contractLink.click();

    // Contracts input should now reflect the clicked value
    const contractsInput = section.locator('#rc-contracts');
    const contractsVal = await contractsInput.inputValue();
    expect(Number.parseInt(contractsVal)).toBeGreaterThan(0);
  });

  test('buy mode with premium and target shows profit analysis', async ({
    page,
  }) => {
    const section = rcSection(page);

    // Switch to buy mode
    const modeGroup = section.getByRole('radiogroup', {
      name: 'Trade mode',
    });
    await modeGroup.getByText('Buy').click();

    await section.getByLabel('Account Balance').fill('25000');
    await section.getByLabel('Premium Paid').fill('3.50');
    await section.getByLabel('Target Exit').fill('7.00');

    // Results should show profit analysis
    await expect(section.getByText('Total Max Loss')).toBeVisible();
    await expect(section.getByText('Cost / Contract')).toBeVisible();
    await expect(
      section.getByText('Profit at Target', { exact: true }),
    ).toBeVisible();

    // Cost = 3.50 * 100 = $350
    await expect(section.getByText('$350').first()).toBeVisible();

    // Profit at target = (7.00 - 3.50) * 100 = $350
    // R:R = 350/350 = 1:1.0 (appears in summary and card, use first())
    await expect(section.getByText('1:1.0').first()).toBeVisible();

    // Buy-mode summary line shows profit at target with per-contract amount
    await expect(section.getByText(/Profit at target.*\/ct/)).toBeVisible();
  });

  test('contracts increment and decrement buttons work', async ({ page }) => {
    const section = rcSection(page);
    const contractsInput = section.locator('#rc-contracts');

    // Default is 1
    await expect(contractsInput).toHaveValue('1');

    // Increment
    await section.getByLabel('Increase contracts').click();
    await expect(contractsInput).toHaveValue('2');

    // Increment again
    await section.getByLabel('Increase contracts').click();
    await expect(contractsInput).toHaveValue('3');

    // Decrement
    await section.getByLabel('Decrease contracts').click();
    await expect(contractsInput).toHaveValue('2');

    // Decrement below 1 should stay at 1
    await section.getByLabel('Decrease contracts').click();
    await expect(contractsInput).toHaveValue('1');
    await section.getByLabel('Decrease contracts').click();
    await expect(contractsInput).toHaveValue('1');
  });
});
