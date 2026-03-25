// netlify/functions/rockcast-process.js
// RockCast pipeline: Cloudinary assets → Claude caption → Buffer → MongoDB log

const { MongoClient } = require('mongodb');
const Anthropic = require('@anthropic-ai/sdk');

let cachedClient = null;

async function getDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(process.env.MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db('gotrocks');
}

const THEME_ROTATION = [
  'educational',    // What is this material? Why use it?
  'social_proof',   // Happy customer / job result
  'behind_scenes',  // How we do it / the crew
  'local_pride',    // Texas / Houston area focus
  'product_focus',  // Highlight a specific material
  'cta',            // Call to action / quote offer
];

async function getNextTheme(db) {
  const lastPost = await db.collection('rockcast_posts')
    .findOne({}, { sort: { createdAt: -1 } });

  if (!lastPost || !lastPost.theme) return THEME_ROTATION[0];

  const lastIndex = THEME_ROTATION.indexOf(lastPost.theme);
  return THEME_ROTATION[(lastIndex + 1) % THEME_ROTATION.length];
}

async function generateCaption(assets, jobType, notes, theme) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const assetDesc = assets.map((a, i) =>
    `Asset ${i + 1}: ${a.resourceType} (${a.format}, ${a.width}x${a.height}) at ${a.url}`
  ).join('\n');

  const prompt = `You are Rocky — Texas Got Rocks' AI mascot. You speak like a hospitable Texan: warm, confident, plain-spoken. No corporate fluff.

Write a social media caption for this job post. Keep it under 200 characters for the main caption, then add 3-5 relevant hashtags on a new line.

Job type: ${jobType || 'general job'}
Notes from crew: ${notes || 'none provided'}
Assets uploaded: ${assetDesc}
Theme for this post: ${theme}

Theme guide:
- educational: teach something about the material or process
- social_proof: focus on the result and happy customer outcome
- behind_scenes: spotlight the crew and how hard they work
- local_pride: make it feel local to Houston/Conroe/Texas Hill Country
- product_focus: highlight the specific material being delivered
- cta: invite folks to get a quote, mention how easy it is

Write ONLY the caption and hashtags. No preamble, no explanation.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });

  return message.content[0].text.trim();
}

async function scheduleInBuffer(caption, assets) {
  if (!process.env.BUFFER_API_KEY) {
    console.log('Buffer API key not set — skipping Buffer scheduling');
    return { skipped: true };
  }

  // Get Buffer profiles
  const profilesRes = await fetch('https://api.bufferapp.com/1/profiles.json', {
    headers: { Authorization: `Bearer ${process.env.BUFFER_API_KEY}` }
  });
  const profiles = await profilesRes.json();

  // Target Facebook, Instagram, Google Biz
  const targetNetworks = ['facebook', 'instagram', 'googlebusiness'];
  const targetProfiles = profiles.filter(p =>
    targetNetworks.some(n => p.service.toLowerCase().includes(n))
  );

  if (targetProfiles.length === 0) {
    return { skipped: true, reason: 'No matching Buffer profiles found' };
  }

  const profileIds = targetProfiles.map(p => p.id);

  // Use first image/video as the media
  const primaryAsset = assets[0];
  const body = {
    text: caption,
    profile_ids: profileIds,
    media: { link: primaryAsset.url, photo: primaryAsset.resourceType === 'image' ? primaryAsset.url : undefined }
  };

  const res = await fetch('https://api.bufferapp.com/1/updates/create.json', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.BUFFER_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      text: caption,
      ...Object.fromEntries(profileIds.map((id, i) => [`profile_ids[${i}]`, id])),
      'media[link]': primaryAsset.url
    })
  });

  const text = await res.text();
  try {
    return text ? JSON.parse(text) : { success: true };
  } catch (e) {
    return { raw: text };
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { assets, jobType, notes, uploadedAt } = JSON.parse(event.body);

    if (!assets || assets.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No assets provided' }) };
    }

    const db = await getDb();

    // 1. Get next theme in rotation
    const theme = await getNextTheme(db);

    // 2. Generate caption with Claude
    const caption = await generateCaption(assets, jobType, notes, theme);

    // 3. Schedule in Buffer
    const bufferResult = await scheduleInBuffer(caption, assets);

    // 4. Log to MongoDB
    const post = {
      assets,
      jobType: jobType || 'other',
      notes,
      caption,
      theme,
      bufferResult,
      status: bufferResult.skipped ? 'caption_only' : 'scheduled',
      uploadedAt: new Date(uploadedAt),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('rockcast_posts').insertOne(post);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        caption,
        theme,
        assetsCount: assets.length,
        bufferStatus: bufferResult.skipped ? 'skipped' : 'scheduled'
      })
    };

  } catch (err) {
    console.error('RockCast process error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
