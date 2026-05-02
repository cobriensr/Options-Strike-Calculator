/**
 * Auto-login for SpotGamma TRACE.
 *
 * SpotGamma uses a simple email + password form (no MFA per user
 * confirmation). If the form selectors drift, capture a screenshot to
 * /tmp on failure for diagnosis (via failWithDiagnostics).
 */

import type { Locator, Page } from '@playwright/test';
import { SEL } from './selectors.js';
import { failWithDiagnostics } from './diagnostics.js';

export interface LoginEnv {
  email: string;
  password: string;
  traceUrl: string;
  loginUrl: string;
}

export async function loginIfNeeded(page: Page, env: LoginEnv): Promise<void> {
  const { email, password, traceUrl, loginUrl } = env;

  // First check if /trace is already authenticated (e.g., a stale cookie
  // from a prior tick still works — rare in our spawn-per-tick model
  // but possible if browserless reuses connection state).
  await page.goto(traceUrl);
  await page.waitForTimeout(2000);

  const dashboardVisible = await SEL.chartTypeDropdown(page)
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  if (dashboardVisible) {
    return;
  }

  // Not authenticated — navigate directly to the login page. Going to
  // the explicit /login URL is more reliable than clicking through
  // SpotGamma's anonymous /trace preview ("Subscribe Now" / "Login"
  // buttons), which is layout-fragile.
  await page.goto(loginUrl);
  await page.waitForTimeout(2000);

  const formVisible = await page
    .locator('#login-password, input[type="password"]')
    .first()
    .isVisible({ timeout: 8000 })
    .catch(() => false);

  if (!formVisible) {
    await failWithDiagnostics(page, {
      label: 'trace-no-loginform',
      extra: { loginUrl },
    });
  }

  // SpotGamma uses MUI form with id="login-username" (note: type="text",
  // NOT type="email") + id="login-password". MUI wires
  // `<label for="login-username">Email *</label>`, so getByLabel works
  // as a robust fallback if the IDs ever change.
  const emailField = page
    .locator('#login-username')
    .or(page.getByLabel('Email').first())
    .first();
  const passwordField = page
    .locator('#login-password')
    .or(page.getByLabel('Password').first())
    .first();

  await emailField.waitFor({ state: 'visible', timeout: 8000 });
  await emailField.fill(email);
  await passwordField.fill(password);

  // SpotGamma's submit button literally reads "Login" (case-sensitive).
  const submitCandidates: Locator[] = [
    page.getByRole('button', { name: 'Login', exact: true }),
    page.locator('button[type="submit"]').first(),
    page.getByRole('button', { name: /sign\s*in|log\s*in|login/i }).first(),
  ];
  let submitted = false;
  for (const c of submitCandidates) {
    try {
      await c.click({ timeout: 3000 });
      submitted = true;
      break;
    } catch {
      /* try next */
    }
  }
  if (!submitted) {
    await passwordField.press('Enter');
  }

  // Wait for ANY authenticated path. Observed: SpotGamma redirects to
  // /home (e.g. /home?eh-model=legacy) after a successful login, NOT
  // /trace. Accept either, then we'll navigate to /trace explicitly.
  // Important: pathname predicate (not substring regex) — the URL
  // `dashboard.spotgamma.com/login` contains `/dashboard` as host
  // substring, which would falsely satisfy a regex like /\/dashboard/
  // INSTANTLY before submit processes.
  await page
    .waitForURL(
      (urlObj) => {
        try {
          const path = new URL(urlObj.toString()).pathname;
          return (
            path.startsWith('/trace') ||
            path.startsWith('/home') ||
            path.startsWith('/dashboard')
          );
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .catch(async (waitErr: unknown) => {
      await failWithDiagnostics(page, {
        label: 'trace-login-fail',
        originalErr: waitErr,
        extra: {
          note: 'Login did not redirect to authenticated path within 30s',
        },
      });
    });
  await page.waitForTimeout(1000);

  // Navigate explicitly to /trace. Whether SpotGamma redirected us to
  // /home, /dashboard, or /trace, the chart-type combobox lives at /trace.
  if (!new URL(page.url()).pathname.startsWith('/trace')) {
    await page.goto(traceUrl);
    await page.waitForTimeout(2000);
  }
}
