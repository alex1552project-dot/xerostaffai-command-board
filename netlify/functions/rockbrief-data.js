// rockbrief-data.js
// RockBrief Intelligence Dashboard — data API
// ?type=brief    → latest doc from daily_briefs
// ?type=metrics  → revenue today, open quotes, posts today, GSC clicks
// ?type=social   → recent posts from social_posts
// ?type=ops      → quote log + delivery count from quote_log + delivery_schedule
// ?type=env      → which env vars are set (values never exposed)

const { MongoClient } = require('mongodb');

let cachedDb = null;
async function getDb() {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  cachedDb = client.db('gotrocks');
  return cachedDb;
}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const type = event.queryStringParameters?.type || 'brief';

  try {
    if (type === 'env') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          mongo:      !!process.env.MONGODB_URI,
          anthropic:  !!process.env.ANTHROPIC_API_KEY,
          brevo:      !!process.env.BREVO_API_KEY,
          buffer:     !!process.env.BUFFER_API_KEY,
          gsc:        !!process.env.GSC_CREDENTIALS,
        }),
      };
    }

    const db = await getDb();

    // ── DAILY BRIEF ───────────────────────────────────────────────────
    if (type === 'brief') {
      const brief = await db.collection('daily_briefs')
        .findOne({}, { sort: { date: -1 } });
      return { statusCode: 200, headers, body: JSON.stringify({ brief: brief || null }) };
    }

    // ── METRICS ───────────────────────────────────────────────────────
    if (type === 'metrics') {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const [revenueAgg, openQuotes, postsToday] = await Promise.all([
        // Revenue: sum of paid orders today
        db.collection('orders').aggregate([
          { $match: { status: 'paid', updatedAt: { $gte: todayStart } } },
          { $group: { _id: null, total: { $sum: '$totals.total' } } }
        ]).toArray(),

        // Open quotes: status sent or pending
        db.collection('quote_log').countDocuments({
          status: { $in: ['sent', 'pending', 'draft'] }
        }),

        // Posts today: scheduled or posted today
        db.collection('social_posts').countDocuments({
          scheduledDate: { $gte: todayStart }
        }),
      ]);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          revenue:    revenueAgg[0]?.total || 0,
          openQuotes: openQuotes,
          postsToday: postsToday,
          gscClicks:  null,   // GSC not yet wired — shows — in UI
        }),
      };
    }

    // ── SOCIAL PIPELINE ───────────────────────────────────────────────
    if (type === 'social') {
      const posts = await db.collection('social_posts')
        .find({})
        .sort({ scheduledDate: -1 })
        .limit(50)
        .project({ caption: 1, theme: 1, status: 1, scheduledDate: 1, fb: 1, ig: 1, gbp: 1 })
        .toArray();
      return { statusCode: 200, headers, body: JSON.stringify({ posts }) };
    }

    // ── OPERATIONS ────────────────────────────────────────────────────
    if (type === 'ops') {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const [quotes, quoteCount, deliveries] = await Promise.all([
        db.collection('quote_log')
          .find({})
          .sort({ sentAt: -1, createdAt: -1 })
          .limit(30)
          .project({ quoteNumber: 1, customerSnapshot: 1, customerName: 1, projectName: 1, totals: 1, total: 1, via: 1, status: 1, sentAt: 1, createdAt: 1 })
          .toArray(),

        db.collection('quote_log').countDocuments({
          $or: [{ sentAt: { $gte: monthStart } }, { createdAt: { $gte: monthStart } }]
        }),

        db.collection('delivery_schedule').countDocuments({
          deliveryDate: todayStart.toISOString().split('T')[0]
        }),
      ]);

      const lastQ = quotes[0];
      const lastQuote = lastQ
        ? (lastQ.customerSnapshot?.name || lastQ.customerName || '—') + ' · ' + (lastQ.quoteNumber || '')
        : '—';

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ quotes, quoteCount, deliveries, lastQuote }),
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown type' }) };

  } catch (err) {
    console.error('rockbrief-data error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
