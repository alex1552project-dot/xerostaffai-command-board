// rockbrief-watchdog.js
// Watchdog — fires at 6:30 AM CST (cron: 30 12 * * *)
// Checks if today's RockBrief was generated. If not, sends SMS alert via Brevo.

const { schedule } = require('@netlify/functions');
const { MongoClient } = require('mongodb');

let cachedDb = null;
async function getDb() {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  cachedDb = client.db('gotrocks');
  return cachedDb;
}

function todayDateString() {
  return new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
}

async function sendAlertSMS(todayStr) {
  const digits = process.env.ALEX_PHONE?.replace(/\D/g, '') || '';
  const recipient = digits.length === 10 ? '1' + digits : digits;

  const content = `⚠️ RockBrief alert: No morning brief was generated for ${todayStr}. Check Netlify logs — something went wrong.`;

  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: 'TXGotRocks',
      recipient,
      content: content.slice(0, 160),
      type: 'transactional',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo SMS error: ${err}`);
  }
  return await res.json();
}

async function runWatchdog() {
  const todayStr = todayDateString();
  console.log(`[watchdog] Checking for RockBrief on ${todayStr}...`);

  const db = await getDb();
  const brief = await db.collection('daily_briefs').findOne({ date: todayStr });

  if (brief) {
    console.log(`[watchdog] Brief found for ${todayStr}. All good.`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, briefFound: true, date: todayStr }) };
  }

  console.warn(`[watchdog] No brief found for ${todayStr}. Sending alert SMS...`);
  try {
    await sendAlertSMS(todayStr);
    console.log('[watchdog] Alert SMS sent.');
  } catch (err) {
    console.error('[watchdog] Alert SMS failed:', err.message);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, briefFound: false, alertSent: true, date: todayStr }) };
}

const handler = async (event) => {
  // HTTP test trigger — requires same secret as rockbrief
  if (event && event.httpMethod) {
    const secret = process.env.ROCKBRIEF_SECRET;
    if (!secret || event.headers?.['x-brief-secret'] !== secret) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    try {
      return await runWatchdog();
    } catch (err) {
      console.error('[watchdog] Fatal error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  // Cron invocation
  try {
    return await runWatchdog();
  } catch (err) {
    console.error('[watchdog] Fatal error:', err);
    return { statusCode: 500 };
  }
};

exports.handler = schedule('30 12 * * *', handler);
