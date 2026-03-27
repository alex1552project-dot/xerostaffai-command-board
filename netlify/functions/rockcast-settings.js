// rockcast-settings.js
// GET  → return current RockCast publishing settings (with defaults)
// POST → save settings to MongoDB rockcast_settings collection

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

const DEFAULTS = {
  platforms: { fb: true, ig: true, yt: false },
  postsPerDay: 1,
  preferredTimes: ['09:00'],
  activeDays: 'mon-sat',
  autoPublish: false,
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const db = await getDb();
    const col = db.collection('rockcast_settings');

    if (event.httpMethod === 'GET') {
      const settings = await col.findOne({});
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(settings ? { ...DEFAULTS, ...settings } : DEFAULTS),
      };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body);
      await col.updateOne(
        {},
        { $set: { ...body, updatedAt: new Date() } },
        { upsert: true }
      );
      const updated = await col.findOne({});
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(updated),
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('[rockcast-settings] error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
