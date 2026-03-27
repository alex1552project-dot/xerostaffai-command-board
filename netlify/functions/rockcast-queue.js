// rockcast-queue.js
// POST { id, action: 'approve'|'reject'|'update', platforms?: {fb,ig,yt} }
// Mutates publishStatus or platforms on a rockcast_posts document

const { MongoClient, ObjectId } = require('mongodb');

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

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { id, action, platforms } = JSON.parse(event.body);

    if (!id || !action) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'id and action are required' }) };
    }

    const db = await getDb();
    const col = db.collection('rockcast_posts');
    const _id = new ObjectId(id);

    let update = {};

    if (action === 'approve') {
      update = { $set: { publishStatus: 'approved', updatedAt: new Date() } };
    } else if (action === 'reject') {
      update = { $set: { publishStatus: 'rejected', updatedAt: new Date() } };
    } else if (action === 'update' && platforms) {
      update = { $set: { platforms, updatedAt: new Date() } };
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action or missing platforms for update' }) };
    }

    const result = await col.updateOne({ _id }, update);

    if (result.matchedCount === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Post not found' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error('[rockcast-queue] error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
