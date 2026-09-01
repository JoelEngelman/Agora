const SESSION_DAYS = 30;
const SESSION_COOKIE = 'agora_session';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});

const id = () => crypto.randomUUID();
const now = () => Date.now();

function cookie(name, value, options = {}) {
  const parts = [`${name}=${value}`];
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  parts.push('Path=/');
  parts.push('HttpOnly');
  parts.push('Secure');
  parts.push('SameSite=Lax');
  return parts.join('; ');
}

function clearCookie(name) {
  return cookie(name, '', { maxAge: 0 });
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

function cleanUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validUsername(username) {
  return /^[a-z0-9_]{3,24}$/.test(username);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `post-${Date.now()}`;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesFromHex(value) {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hashPassword(password, saltHex = null) {
  const salt = saltHex ? bytesFromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, material, 256);
  return `${hex(salt)}:${hex(bits)}`;
}

async function verifyPassword(password, stored) {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = (await hashPassword(password, salt)).split(':')[1];
  return actual === expected;
}

function sessionId() { return id().replaceAll('-', ''); }

async function getUser(request, env) {
  const raw = request.headers.get('Cookie') || '';
  const match = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const session = await env.DB.prepare(
    'SELECT users.id, users.username, users.email, users.bio, users.avatar_url, users.website_data FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.expires_at > ?'
  ).bind(match[1], now()).first();
  return session || null;
}

function requireUser(user) {
  return user ? null : json({ error: 'You must be signed in.' }, 401);
}

async function createSession(env, userId) {
  const sid = sessionId();
  const expires = now() + SESSION_DAYS * 86400000;
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(sid, userId, expires).run();
  return cookie(SESSION_COOKIE, sid, { maxAge: SESSION_DAYS * 86400 });
}

async function notify(env, userId, actorId, type, postId = null) {
  if (!userId || userId === actorId) return;
  await env.DB.prepare('INSERT INTO notifications (id, user_id, actor_id, type, post_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id(), userId, actorId, type, postId, now()).run();
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const method = request.method.toUpperCase();
  const user = await getUser(request, env);

  if (method === 'GET' && path === 'health') return json({ status: 'ok', service: 'agora-api' });

  if (method === 'POST' && path === 'auth/signup') {
    const body = await readBody(request);
    const username = cleanUsername(body.username);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!validUsername(username)) return json({ error: 'Username must be 3–24 characters using letters, numbers, or underscores.' }, 400);
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
    if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);
    const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ? OR email = ?').bind(username, email).first();
    if (existing) return json({ error: 'That username or email is already in use.' }, 409);
    const userId = id();
    await env.DB.prepare('INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, username, email, await hashPassword(password), now()).run();
    const headers = { 'set-cookie': await createSession(env, userId) };
    return json({ user: { id: userId, username, email, bio: '', avatar_url: '' } }, 201, headers);
  }

  if (method === 'POST' && path === 'auth/login') {
    const body = await readBody(request);
    const login = String(body.login || '').trim().toLowerCase();
    const password = String(body.password || '');
    const found = await env.DB.prepare('SELECT * FROM users WHERE username = ? OR email = ?').bind(login, login).first();
    if (!found || !(await verifyPassword(password, found.password_hash))) return json({ error: 'Incorrect username/email or password.' }, 401);
    return json({ user: { id: found.id, username: found.username, email: found.email, bio: found.bio, avatar_url: found.avatar_url } }, 200, { 'set-cookie': await createSession(env, found.id) });
  }

  if (method === 'POST' && path === 'auth/logout') {
    const raw = request.headers.get('Cookie') || '';
    const match = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    if (match) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(match[1]).run();
    return json({ ok: true }, 200, { 'set-cookie': clearCookie(SESSION_COOKIE) });
  }

  if (method === 'GET' && path === 'auth/me') {
    return json({ user: user ? { id: user.id, username: user.username, email: user.email, bio: user.bio, avatar_url: user.avatar_url } : null });
  }

  if (method === 'GET' && path === 'posts') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20), 1), 50);
    const q = String(url.searchParams.get('q') || '').trim();
    let result;
    if (q) {
      const like = `%${q}%`;
      result = await env.DB.prepare(`SELECT p.id, p.slug, p.title, p.excerpt, p.genre, p.created_at, u.username,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) likes,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) comments
        FROM posts p JOIN users u ON u.id = p.author_id
        WHERE p.published = 1 AND (p.title LIKE ? OR p.excerpt LIKE ? OR p.body LIKE ?)
        ORDER BY p.created_at DESC LIMIT ?`).bind(like, like, like, limit).all();
    } else {
      result = await env.DB.prepare(`SELECT p.id, p.slug, p.title, p.excerpt, p.genre, p.created_at, u.username,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) likes,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) comments
        FROM posts p JOIN users u ON u.id = p.author_id
        WHERE p.published = 1 ORDER BY p.created_at DESC LIMIT ?`).bind(limit).all();
    }
    return json({ posts: result.results });
  }

  if (method === 'GET' && path === 'following') {
    if (!user) return json({ posts: [] });
    const result = await env.DB.prepare(`SELECT p.id, p.slug, p.title, p.excerpt, p.genre, p.created_at, u.username,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) likes,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) comments
      FROM posts p JOIN users u ON u.id = p.author_id
      JOIN follows f ON f.following_id = p.author_id AND f.follower_id = ?
      WHERE p.published = 1 ORDER BY p.created_at DESC LIMIT 50`).bind(user.id).all();
    return json({ posts: result.results });
  }

  if (method === 'POST' && path === 'posts') {
    const authError = requireUser(user); if (authError) return authError;
    const body = await readBody(request);
    const title = String(body.title || '').trim();
    const content = String(body.body || '').trim();
    const excerpt = String(body.excerpt || '').trim().slice(0, 400);
    const genre = String(body.genre || 'Opinion').trim().slice(0, 40) || 'Opinion';
    if (title.length < 3 || content.length < 1) return json({ error: 'A title and body are required.' }, 400);
    let slug = slugify(body.slug || title);
    const existing = await env.DB.prepare('SELECT id FROM posts WHERE author_id = ? AND slug = ?').bind(user.id, slug).first();
    if (existing) slug = `${slug}-${Date.now().toString(36)}`;
    const postId = id();
    const timestamp = now();
    await env.DB.prepare('INSERT INTO posts (id, author_id, slug, title, excerpt, body, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(postId, user.id, slug, title, excerpt, content, genre, timestamp, timestamp).run();
    const tags = Array.isArray(body.tags) ? body.tags : [];
    for (const rawTag of tags.slice(0, 8)) {
      const name = String(rawTag || '').trim().toLowerCase().slice(0, 32);
      if (!name) continue;
      const tagId = id();
      await env.DB.prepare('INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)').bind(tagId, name).run();
      const tag = await env.DB.prepare('SELECT id FROM tags WHERE name = ?').bind(name).first();
      if (tag) await env.DB.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)').bind(postId, tag.id).run();
    }
    return json({ post: { id: postId, slug, title, excerpt, genre, username: user.username } }, 201);
  }

  const postMatch = path.match(/^posts\/([^/]+)$/);
  if (method === 'GET' && postMatch) {
    const post = await env.DB.prepare(`SELECT p.*, u.username, u.bio, u.avatar_url,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) likes,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) comments
      FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ? OR (u.username = ? AND p.slug = ?)`)
      .bind(postMatch[1], postMatch[1], postMatch[1]).first();
    if (!post) return json({ error: 'Post not found.' }, 404);
    const comments = await env.DB.prepare(`SELECT c.id, c.body, c.created_at, u.username FROM comments c JOIN users u ON u.id = c.author_id WHERE c.post_id = ? ORDER BY c.created_at ASC`).bind(post.id).all();
    const tags = await env.DB.prepare('SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ? ORDER BY t.name').bind(post.id).all();
    return json({ post, comments: comments.results, tags: tags.results.map(x => x.name) });
  }

  if (method === 'POST' && postMatch && postMatch[1] && path.startsWith('posts/')) {
    const authError = requireUser(user); if (authError) return authError;
    const postId = postMatch[1];
    const body = await readBody(request);
    const post = await env.DB.prepare('SELECT author_id FROM posts WHERE id = ?').bind(postId).first();
    if (!post) return json({ error: 'Post not found.' }, 404);
    if (body.action === 'like') {
      const existing = await env.DB.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').bind(user.id, postId).first();
      if (existing) await env.DB.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').bind(user.id, postId).run();
      else { await env.DB.prepare('INSERT INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(user.id, postId, now()).run(); await notify(env, post.author_id, user.id, 'like', postId); }
      return json({ liked: !existing });
    }
    if (body.action === 'bookmark') {
      const existing = await env.DB.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND post_id = ?').bind(user.id, postId).first();
      if (existing) await env.DB.prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?').bind(user.id, postId).run();
      else await env.DB.prepare('INSERT INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(user.id, postId, now()).run();
      return json({ bookmarked: !existing });
    }
    if (body.action === 'comment') {
      const text = String(body.body || '').trim();
      if (!text) return json({ error: 'Comment cannot be empty.' }, 400);
      const commentId = id();
      await env.DB.prepare('INSERT INTO comments (id, post_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)').bind(commentId, postId, user.id, text.slice(0, 5000), now()).run();
      await notify(env, post.author_id, user.id, 'comment', postId);
      return json({ id: commentId }, 201);
    }
  }

  const userMatch = path.match(/^users\/([a-z0-9_]+)$/);
  if (method === 'GET' && userMatch) {
    const profile = await env.DB.prepare(`SELECT id, username, bio, avatar_url, website_data, created_at,
      (SELECT COUNT(*) FROM posts WHERE author_id = users.id AND published = 1) posts_count,
      (SELECT COUNT(*) FROM follows WHERE following_id = users.id) followers_count,
      (SELECT COUNT(*) FROM follows WHERE follower_id = users.id) following_count
      FROM users WHERE username = ?`).bind(userMatch[1]).first();
    if (!profile) return json({ error: 'User not found.' }, 404);
    let following = false;
    if (user) following = !!(await env.DB.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').bind(user.id, profile.id).first());
    const posts = await env.DB.prepare('SELECT id, slug, title, excerpt, genre, created_at FROM posts WHERE author_id = ? AND published = 1 ORDER BY created_at DESC LIMIT 20').bind(profile.id).all();
    return json({ profile: { ...profile, following }, posts: posts.results });
  }

  if (method === 'POST' && userMatch && userMatch[1] === user?.username) {
    const target = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(userMatch[1]).first();
    if (!target || target.id === user.id) return json({ error: 'Invalid follow target.' }, 400);
    const existing = await env.DB.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').bind(user.id, target.id).first();
    if (existing) { await env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').bind(user.id, target.id).run(); return json({ following: false }); }
  }

  if (method === 'POST' && path.startsWith('follow/')) {
    const authError = requireUser(user); if (authError) return authError;
    const username = cleanUsername(path.slice(7));
    const target = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (!target || target.id === user.id) return json({ error: 'Invalid follow target.' }, 400);
    const existing = await env.DB.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').bind(user.id, target.id).first();
    if (existing) { await env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').bind(user.id, target.id).run(); return json({ following: false }); }
    await env.DB.prepare('INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)').bind(user.id, target.id, now()).run();
    await notify(env, target.id, user.id, 'follow');
    return json({ following: true });
  }

  if (method === 'PUT' && path === 'me') {
    const authError = requireUser(user); if (authError) return authError;
    const body = await readBody(request);
    const bio = String(body.bio ?? user.bio).slice(0, 500);
    const avatar = String(body.avatar_url ?? user.avatar_url).slice(0, 1000);
    await env.DB.prepare('UPDATE users SET bio = ?, avatar_url = ? WHERE id = ?').bind(bio, avatar, user.id).run();
    return json({ ok: true });
  }

  if (method === 'PUT' && path === 'website') {
    const authError = requireUser(user); if (authError) return authError;
    const body = await readBody(request);
    const data = body.data;
    if (!data || typeof data !== 'object') return json({ error: 'Invalid website data.' }, 400);
    const safe = JSON.stringify({ theme: String(data.theme || 'midnight').slice(0, 40), components: Array.isArray(data.components) ? data.components.slice(0, 100) : [] });
    await env.DB.prepare('UPDATE users SET website_data = ? WHERE id = ?').bind(safe, user.id).run();
    return json({ ok: true });
  }

  if (method === 'GET' && path === 'notifications') {
    const authError = requireUser(user); if (authError) return authError;
    const result = await env.DB.prepare(`SELECT n.id, n.type, n.read, n.created_at, n.post_id, u.username AS actor FROM notifications n LEFT JOIN users u ON u.id = n.actor_id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 50`).bind(user.id).all();
    return json({ notifications: result.results });
  }

  if (method === 'POST' && path === 'notifications/read') {
    const authError = requireUser(user); if (authError) return authError;
    await env.DB.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').bind(user.id).run();
    return json({ ok: true });
  }

  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env); }
      catch (error) { console.error(error); return json({ error: 'Agora encountered a server error.' }, 500); }
    }
    return env.ASSETS.fetch(request);
  }
};
