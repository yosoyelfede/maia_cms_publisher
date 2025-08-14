// api/publish.js
const ORIGINS = (process.env.PUBLISH_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function json(res, status, data, origin) {
  res.status(status);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data));
}

async function gh(path, method, token, body) {
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`${method} ${path} ${resp.status}: ${txt}`);
  }
  return resp.json();
}

async function getShaIfExists(owner, repo, branch, path, token) {
  try {
    const r = await gh(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`,
      'GET',
      token
    );
    return r.sha;
  } catch {
    return null;
  }
}

async function upsertFile(owner, repo, branch, path, content, token, isBase64) {
  const sha = await getShaIfExists(owner, repo, branch, path, token);
  const body = {
    message: `CMS publish: ${path}`,
    branch,
    content: isBase64 ? content : Buffer.from(content, 'utf8').toString('base64')
  };
  if (sha) body.sha = sha;
  return gh(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    'PUT',
    token,
    body
  );
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    if (ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Publish-Key');
    }
    return res.status(204).end();
  }
  if (!ORIGINS.includes(origin)) {
    return json(res, 403, { error: 'Origin not allowed' });
  }
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' }, origin);
  }
  const clientKey = req.headers['x-publish-key'];
  if (!clientKey || clientKey !== process.env.PUBLISH_KEY) {
    return json(res, 401, { error: 'Unauthorized' }, origin);
  }

  try {
    const { posts, images = [], branch = 'main' } = req.body || {};
    if (!Array.isArray(posts)) {
      return json(res, 400, { error: 'Invalid posts' }, origin);
    }

    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.REPO_OWNER;
    const repo = process.env.REPO_NAME;

    await upsertFile(
      owner, repo, branch,
      'public/data/blog-posts.json',
      JSON.stringify(posts, null, 2),
      token, false
    );

    for (const img of images) {
      if (!img?.path || !img?.contentBase64) continue;
      const clean = img.contentBase64.split(',').pop(); // strip "data:...;base64,"
      await upsertFile(owner, repo, branch, img.path, clean, token, true);
    }

    return json(res, 200, { ok: true }, origin);
  } catch (e) {
    return json(res, 500, { error: e.message }, origin);
  }
}