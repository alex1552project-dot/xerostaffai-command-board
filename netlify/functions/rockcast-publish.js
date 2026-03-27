// rockcast-publish.js
// Scheduled Netlify function — runs every hour, publishes approved RockCast posts
// based on rockcast_settings (active days, preferred times, autoPublish flag).
//
// Phase 1: OAuth stubs only. Wire tokens in Phase 2.

const { schedule } = require('@netlify/functions');
const { MongoClient, ObjectId } = require('mongodb');

let cachedDb = null;
async function getDb() {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  cachedDb = client.db('gotrocks');
  return cachedDb;
}

// ── PLATFORM STUBS ─────────────────────────────────────────────────────────────
// Phase 2: replace each stub with real OAuth + API call

async function publishToFacebook(post) {
  // TODO: wire OAuth token here
  // Needs: FB Developer App + long-lived Page Access Token
  // Graph API endpoint: POST /{page-id}/videos or /{page-id}/photos
  // Page ID for "Texas Got Rocks": set FB_PAGE_ID env var
  // Access token: set FB_PAGE_ACCESS_TOKEN env var
  throw new Error('Facebook OAuth not yet configured');
}

async function publishToInstagram(post) {
  // TODO: wire OAuth token here
  // Needs: same FB Developer App (Instagram Graph API uses FB token)
  // Instagram Business Account ID: set IG_ACCOUNT_ID env var
  // Access token: same FB_PAGE_ACCESS_TOKEN (if page is linked to IG account)
  // Graph API: POST /{ig-user-id}/media → then POST /{ig-user-id}/media_publish
  throw new Error('Instagram OAuth not yet configured');
}

async function publishToYouTube(post) {
  // TODO: wire OAuth token here
  // Needs: Google Cloud project + YouTube Data API v3 OAuth credentials
  // YouTube requires uploading video bytes (cannot pass URL directly)
  // Use Cloudinary URL with /upload/f_mp4/ transformation to get an MP4 stream
  // Set YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN env vars
  throw new Error('YouTube OAuth not yet configured');
}

// ── HELPERS ────────────────────────────────────────────────────────────────────

const DAY_MAP = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };

function activeDaysSet(activeDays) {
  // activeDays format: 'mon-sat' or 'mon,wed,fri' or 'mon-fri,sun'
  const days = new Set();
  const parts = activeDays.split(',').map(s => s.trim());
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-');
      const s = DAY_MAP[start], e = DAY_MAP[end];
      if (s != null && e != null) {
        for (let d = s; d <= e; d++) days.add(d);
      }
    } else {
      const d = DAY_MAP[part];
      if (d != null) days.add(d);
    }
  }
  return days;
}

function isNearScheduledTime(preferredTimes, windowMinutes = 25) {
  // Returns true if the current CST time is within ±windowMinutes of any preferred time
  const nowUtc = new Date();
  const cstOffset = -6 * 60; // CST = UTC-6 (no DST adjustment for simplicity)
  const nowCst = new Date(nowUtc.getTime() + cstOffset * 60 * 1000);
  const nowMinutes = nowCst.getHours() * 60 + nowCst.getMinutes();

  for (const t of preferredTimes) {
    const [h, m] = t.split(':').map(Number);
    const slotMinutes = h * 60 + (m || 0);
    if (Math.abs(nowMinutes - slotMinutes) <= windowMinutes) return true;
  }
  return false;
}

// ── MAIN HANDLER ───────────────────────────────────────────────────────────────

const handler = async () => {
  try {
    const db = await getDb();

    // 1. Load settings
    const settings = await db.collection('rockcast_settings').findOne({});
    const autoPublish = settings?.autoPublish ?? false;
    const enabledPlatforms = settings?.platforms ?? { fb: true, ig: true, yt: false };
    const platformSchedules = settings?.platformSchedules ?? {
      fb: { times: ['09:00'], days: 'mon-sat' },
      ig: { times: ['12:00'], days: 'mon-sat' },
      yt: { times: ['10:00'], days: 'mon-fri' },
    };

    // 2. Guard: autoPublish must be on
    if (!autoPublish) {
      console.log('[rockcast-publish] autoPublish is off — skipping');
      return { statusCode: 200, body: 'autoPublish off' };
    }

    // 3. Determine which platforms are due right now (active day + near scheduled time)
    const todayDow = new Date().getDay();
    const duePlatforms = {};
    for (const plat of ['fb', 'ig', 'yt']) {
      if (!enabledPlatforms[plat]) continue;
      const sched = platformSchedules[plat] || { times: ['09:00'], days: 'mon-sat' };
      const activeToday = activeDaysSet(sched.days).has(todayDow);
      const nearTime = isNearScheduledTime(sched.times);
      if (activeToday && nearTime) duePlatforms[plat] = true;
    }

    if (Object.keys(duePlatforms).length === 0) {
      console.log('[rockcast-publish] no platforms due right now — skipping');
      return { statusCode: 200, body: 'no platforms due' };
    }

    // 4. Find next approved post
    const post = await db.collection('rockcast_posts').findOne({
      publishStatus: 'approved',
      publishedAt: null,
    }, { sort: { createdAt: 1 } });

    if (!post) {
      console.log('[rockcast-publish] no approved posts in queue');
      return { statusCode: 200, body: 'no posts' };
    }

    // 5. Intersect due platforms with per-post platform overrides
    const postPlatforms = post.platforms || enabledPlatforms;
    const publishResults = {};

    // 6. Attempt each due + enabled platform
    if (duePlatforms.fb && postPlatforms.fb) {
      try {
        const result = await publishToFacebook(post);
        publishResults.fb = { success: true, result };
      } catch (err) {
        publishResults.fb = { success: false, error: err.message };
      }
    }

    if (duePlatforms.ig && postPlatforms.ig) {
      try {
        const result = await publishToInstagram(post);
        publishResults.ig = { success: true, result };
      } catch (err) {
        publishResults.ig = { success: false, error: err.message };
      }
    }

    if (duePlatforms.yt && postPlatforms.yt) {
      try {
        const result = await publishToYouTube(post);
        publishResults.yt = { success: true, result };
      } catch (err) {
        publishResults.yt = { success: false, error: err.message };
      }
    }

    // 8. Determine overall status
    const anySuccess = Object.values(publishResults).some(r => r.success);
    const newStatus = anySuccess ? 'published' : 'failed';

    // 9. Update post record
    await db.collection('rockcast_posts').updateOne(
      { _id: post._id },
      {
        $set: {
          publishStatus: newStatus,
          publishResults,
          publishedAt: anySuccess ? new Date() : null,
          updatedAt: new Date(),
        }
      }
    );

    console.log(`[rockcast-publish] post ${post._id} → ${newStatus}`, publishResults);
    return { statusCode: 200, body: JSON.stringify({ status: newStatus, publishResults }) };

  } catch (err) {
    console.error('[rockcast-publish] fatal error:', err);
    return { statusCode: 500, body: err.message };
  }
};

exports.handler = schedule('0 * * * *', handler);
