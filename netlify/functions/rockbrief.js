// rockbrief.js
// RockBrief — Scheduled morning brief generator
// Runs daily at 6 AM CDT (cron: 0 11 * * *)
// 1. Pulls data from MongoDB gotrocks DB
// 2. Pulls scheduled posts count from Buffer API
// 3. Calls Claude API to write Rocky's morning narrative
// 4. Saves narrative to daily_briefs collection
// 5. Sends HTML email + 3-line SMS via Brevo

const { schedule } = require('@netlify/functions');
const { MongoClient } = require('mongodb');

// ── MongoDB ───────────────────────────────────────────────────────────────────
let cachedDb = null;
async function getDb() {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  cachedDb = client.db('gotrocks');
  return cachedDb;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayDateString() {
  return new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
}

function formatCurrency(n) {
  return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Data Pull ─────────────────────────────────────────────────────────────────
async function pullData() {
  const db = await getDb();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const todayStr = todayDateString();

  const [
    revenueAgg,
    openQuotesCount,
    monthQuotesCount,
    recentQuotes,
    deliveriesToday,
    existingBrief,
  ] = await Promise.all([
    // Revenue today (paid orders)
    db.collection('orders').aggregate([
      { $match: { status: 'paid', updatedAt: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: '$totals.total' } } },
    ]).toArray(),

    // Open quotes (sent/pending/draft)
    db.collection('quote_log').countDocuments({
      status: { $in: ['sent', 'pending', 'draft'] },
    }),

    // Quotes this month
    db.collection('quote_log').countDocuments({
      $or: [{ sentAt: { $gte: monthStart } }, { createdAt: { $gte: monthStart } }],
    }),

    // Last 5 quotes for context
    db.collection('quote_log')
      .find({})
      .sort({ sentAt: -1, createdAt: -1 })
      .limit(5)
      .project({ customerSnapshot: 1, customerName: 1, projectName: 1, totals: 1, total: 1, status: 1 })
      .toArray(),

    // Deliveries scheduled today
    db.collection('delivery_schedule').countDocuments({
      deliveryDate: todayStr,
    }),

    // Check if brief already exists for today
    db.collection('daily_briefs').findOne({ date: todayStr }),
  ]);

  return {
    revenueToday: revenueAgg[0]?.total || 0,
    openQuotesCount,
    monthQuotesCount,
    recentQuotes,
    deliveriesToday,
    existingBrief,
    todayStr,
  };
}

// ── Buffer API ────────────────────────────────────────────────────────────────
async function getBufferPostsCount() {
  try {
    const res = await fetch('https://api.bufferapp.com/1/updates/pending.json', {
      headers: { Authorization: `Bearer ${process.env.BUFFER_API_KEY}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.total || data.updates?.length || 0;
  } catch (err) {
    console.warn('Buffer API error:', err.message);
    return null;
  }
}

// ── Claude API ────────────────────────────────────────────────────────────────
async function generateNarrative(data, bufferPosts) {
  const { revenueToday, openQuotesCount, monthQuotesCount, recentQuotes, deliveriesToday, todayStr } = data;

  const quoteSummary = recentQuotes.length
    ? recentQuotes.map(q => {
        const name = q.customerSnapshot?.name || q.customerName || 'Unknown';
        const total = q.totals?.total || q.total || 0;
        return `  - ${name}: ${formatCurrency(total)} (${q.status || 'unknown'})`;
      }).join('\n')
    : '  - No recent quotes';

  const bufferLine = bufferPosts !== null
    ? `${bufferPosts} posts scheduled in the content queue`
    : 'Buffer data unavailable';

  const prompt = `You are Rocky, the Texas Got Rocks AI mascot — a warm, confident Texan with a Sam Elliott drawl. Write a brief morning intelligence summary for Alex, the owner of Texas Got Rocks (bulk landscaping materials delivery out of Conroe, TX).

Today is ${todayStr}.

Here's the morning data:
- Revenue booked today: ${formatCurrency(revenueToday)}
- Open quotes (sent/pending/draft): ${openQuotesCount}
- Quotes sent this month: ${monthQuotesCount}
- Deliveries scheduled today: ${deliveriesToday}
- Social content queue: ${bufferLine}

Recent quote activity:
${quoteSummary}

Write a 3–5 paragraph morning brief in Rocky's voice. Be warm, direct, and Texan. Highlight what matters:
1. How the day looks — deliveries, revenue momentum
2. Quotes pipeline health — any follow-up urgency?
3. One piece of actionable advice or encouragement for Alex

Keep it under 300 words. No bullet lists — full narrative paragraphs. End with a short Rocky-style sign-off.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const json = await res.json();
  return json.content?.[0]?.text || '';
}

// ── Save to MongoDB ───────────────────────────────────────────────────────────
async function saveBrief(db, todayStr, narrative, metrics) {
  await db.collection('daily_briefs').updateOne(
    { date: todayStr },
    {
      $set: {
        date: todayStr,
        narrative,
        metrics,
        generatedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

// ── Brevo Email ───────────────────────────────────────────────────────────────
async function sendEmail(todayStr, narrative, metrics) {
  const { revenueToday, openQuotesCount, deliveriesToday } = metrics;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: Georgia, serif; line-height: 1.7; color: #1a1a1a; max-width: 620px; margin: 0 auto; padding: 20px; background: #fafafa;">

  <div style="text-align: center; margin-bottom: 28px; border-bottom: 3px solid #d97706; padding-bottom: 20px;">
    <h1 style="color: #d97706; margin: 0; font-size: 28px;">🪨 RockBrief</h1>
    <p style="color: #666; margin: 6px 0 0; font-size: 15px;">Texas Got Rocks · Morning Intelligence · ${todayStr}</p>
  </div>

  <div style="display: flex; gap: 12px; margin-bottom: 24px;">
    <div style="flex: 1; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center;">
      <div style="font-size: 22px; font-weight: bold; color: #10b981;">${formatCurrency(revenueToday)}</div>
      <div style="font-size: 12px; color: #666; margin-top: 4px;">Revenue Today</div>
    </div>
    <div style="flex: 1; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center;">
      <div style="font-size: 22px; font-weight: bold; color: #3b82f6;">${openQuotesCount}</div>
      <div style="font-size: 12px; color: #666; margin-top: 4px;">Open Quotes</div>
    </div>
    <div style="flex: 1; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center;">
      <div style="font-size: 22px; font-weight: bold; color: #f59e0b;">${deliveriesToday}</div>
      <div style="font-size: 12px; color: #666; margin-top: 4px;">Deliveries Today</div>
    </div>
  </div>

  <div style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; margin-bottom: 20px;">
    <h2 style="color: #854d0e; margin: 0 0 16px; font-size: 18px;">Rocky's Morning Brief</h2>
    ${narrative.split('\n\n').filter(p => p.trim()).map(p => `<p style="margin: 0 0 14px;">${p.trim()}</p>`).join('')}
  </div>

  <div style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">
    <p>Texas Got Rocks · Conroe, TX · Generated by Rocky 🤖</p>
  </div>

</body>
</html>`;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Rocky @ TGR', email: 'info@texasgotrocks.com' },
      to: [{ email: process.env.ALEX_EMAIL, name: 'Alex' }],
      subject: `🪨 RockBrief — ${todayStr}`,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo email error: ${err}`);
  }
  return await res.json();
}

// ── Brevo SMS ─────────────────────────────────────────────────────────────────
async function sendSMS(todayStr, narrative, metrics) {
  const { revenueToday, openQuotesCount, deliveriesToday } = metrics;

  // Extract first sentence of narrative as the summary line
  const firstSentence = narrative.split(/[.!?]/)[0]?.trim() || 'Good morning!';

  const content = `RockBrief ${todayStr}: Rev ${formatCurrency(revenueToday)} | ${openQuotesCount} open quotes | ${deliveriesToday} deliveries. ${firstSentence.slice(0, 80)}. — Rocky`;

  // Format phone to E.164
  const digits = process.env.ALEX_PHONE?.replace(/\D/g, '') || '';
  const recipient = digits.length === 10 ? '1' + digits : digits;

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

// ── Main Handler ──────────────────────────────────────────────────────────────
const handler = async () => {
  console.log('[rockbrief] Starting morning brief generation...');

  try {
    const data = await pullData();
    const { existingBrief, todayStr, revenueToday, openQuotesCount, monthQuotesCount, deliveriesToday } = data;

    if (existingBrief) {
      console.log(`[rockbrief] Brief already exists for ${todayStr}, skipping.`);
      return { statusCode: 200 };
    }

    const bufferPosts = await getBufferPostsCount();
    const narrative = await generateNarrative(data, bufferPosts);

    const metrics = { revenueToday, openQuotesCount, monthQuotesCount, deliveriesToday, bufferPosts };

    const db = await getDb();
    await saveBrief(db, todayStr, narrative, metrics);
    console.log(`[rockbrief] Brief saved to daily_briefs for ${todayStr}`);

    // Send email
    try {
      await sendEmail(todayStr, narrative, metrics);
      console.log('[rockbrief] Email sent.');
    } catch (err) {
      console.error('[rockbrief] Email failed:', err.message);
    }

    // Send SMS
    try {
      await sendSMS(todayStr, narrative, metrics);
      console.log('[rockbrief] SMS sent.');
    } catch (err) {
      console.error('[rockbrief] SMS failed:', err.message);
    }

    console.log('[rockbrief] Done.');
    return { statusCode: 200 };

  } catch (err) {
    console.error('[rockbrief] Fatal error:', err);
    return { statusCode: 500 };
  }
};

exports.handler = schedule('0 11 * * *', handler);
