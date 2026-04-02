/**
 * Shared alert utilities for the real-time market monitors.
 *
 * Both monitor-iv and monitor-flow-ratio crons use these functions
 * to write alerts to the market_alerts table with cooldown dedup.
 * Also handles combined alert detection and Twilio SMS delivery.
 */

import { getDb } from './db.js';
import logger from './logger.js';
import { ALERT_THRESHOLDS } from './alert-thresholds.js';

// ── Types ──────────────────────────────────────────────────

export type AlertType = 'iv_spike' | 'ratio_surge' | 'combined';
export type AlertSeverity = 'warning' | 'critical' | 'extreme';
export type AlertDirection = 'BEARISH' | 'BULLISH' | 'NEUTRAL';

export interface AlertPayload {
  type: AlertType;
  severity: AlertSeverity;
  direction: AlertDirection;
  title: string;
  body: string;
  currentValues: Record<string, number>;
  deltaValues: Record<string, number>;
}

// ── Severity ordering (for SMS gate) ───────────────────────

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  warning: 1,
  critical: 2,
  extreme: 3,
};

// ── Cooldown check ─────────────────────────────────────────

/**
 * Returns true if an alert of the same type was already written
 * within the cooldown window. Prevents alert spam.
 */
async function isOnCooldown(today: string, type: AlertType): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    SELECT 1 FROM market_alerts
    WHERE type = ${type}
      AND date = ${today}
      AND created_at > NOW() - make_interval(mins => ${ALERT_THRESHOLDS.COOLDOWN_MINUTES})
    LIMIT 1
  `;
  return rows.length > 0;
}

// ── Twilio SMS ─────────────────────────────────────────────

/**
 * Send an SMS via Twilio REST API. No SDK — just a raw fetch.
 * Returns true if sent, false if env vars missing or send failed.
 */
export async function sendTwilioSms(alert: AlertPayload): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_FROM;
  const to = process.env.ALERT_PHONE_TO;

  if (!sid || !token || !from || !to) return false;

  const smsBody = `[${alert.severity.toUpperCase()}] ${alert.direction} — ${alert.title}\n${alert.body}`;

  try {
    const credentials = btoa(`${sid}:${token}`);
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: smsBody }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body: text.slice(0, 200) },
        'Twilio SMS failed',
      );
      return false;
    }

    logger.info({ to, type: alert.type }, 'SMS alert sent');
    return true;
  } catch (err) {
    logger.error({ err }, 'Twilio SMS error');
    return false;
  }
}

// ── Write alert ────────────────────────────────────────────

/**
 * Write an alert to market_alerts if not on cooldown.
 * Sends SMS when severity >= SMS_MIN_SEVERITY and Twilio is configured.
 * Returns true if the alert was actually written.
 */
export async function writeAlertIfNew(
  today: string,
  alert: AlertPayload,
): Promise<boolean> {
  if (await isOnCooldown(today, alert.type)) {
    logger.debug({ type: alert.type }, 'Alert suppressed — cooldown active');
    return false;
  }

  const sql = getDb();
  const now = new Date().toISOString();

  const minSeverity = ALERT_THRESHOLDS.SMS_MIN_SEVERITY;
  const shouldSms = SEVERITY_RANK[alert.severity] >= SEVERITY_RANK[minSeverity];
  const smsSent = shouldSms ? await sendTwilioSms(alert) : false;

  await sql`
    INSERT INTO market_alerts (
      date, timestamp, type, severity, direction,
      title, body, current_values, delta_values, sms_sent
    )
    VALUES (
      ${today}, ${now}, ${alert.type}, ${alert.severity}, ${alert.direction},
      ${alert.title}, ${alert.body},
      ${JSON.stringify(alert.currentValues)}, ${JSON.stringify(alert.deltaValues)},
      ${smsSent}
    )
  `;

  logger.warn(
    {
      type: alert.type,
      severity: alert.severity,
      direction: alert.direction,
      title: alert.title,
      smsSent,
    },
    'Market alert fired',
  );

  return true;
}

// ── Combined alert detection ───────────────────────────────

/**
 * After writing an iv_spike or ratio_surge alert, check if the OTHER
 * alert type also fired within the combined window. If so, write a
 * combined alert at extreme severity.
 *
 * Call this from each monitor cron after writeAlertIfNew succeeds.
 */
export async function checkForCombinedAlert(
  today: string,
  justFired: 'iv_spike' | 'ratio_surge',
): Promise<boolean> {
  const otherType = justFired === 'iv_spike' ? 'ratio_surge' : 'iv_spike';
  const window = ALERT_THRESHOLDS.COMBINED_WINDOW_MINUTES;

  const sql = getDb();
  const rows = await sql`
    SELECT direction, current_values, delta_values
    FROM market_alerts
    WHERE type = ${otherType}
      AND date = ${today}
      AND created_at > NOW() - make_interval(mins => ${window})
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (rows.length === 0) return false;

  // Both signals fired — write extreme combined alert
  const other = rows[0]!;
  const otherDirection = other.direction as AlertDirection;

  // Ratio surge has proper directional decomposition; IV spike is
  // always BEARISH. Use the ratio_surge direction when available.
  const direction =
    otherType === 'ratio_surge'
      ? otherDirection
      : ('BEARISH' as AlertDirection);

  const combinedAlert: AlertPayload = {
    type: 'combined',
    severity: 'extreme',
    direction,
    title: 'COMBINED: IV Spike + Ratio Surge',
    body: [
      'Both canary signals fired within',
      `${window} minutes — IV expanded while the put/call ratio surged.`,
      'This pattern preceded the sharpest institutional moves.',
      'Tighten all stops immediately.',
    ].join(' '),
    currentValues: {
      ...(other.current_values as Record<string, number>),
    },
    deltaValues: {
      ...(other.delta_values as Record<string, number>),
    },
  };

  return writeAlertIfNew(today, combinedAlert);
}
