/**
 * Native Antigravity Session Monitor Sidecar Server.
 *
 * Exposes read-only JSON stats endpoints for the active conversation and serves
 * the Auxiliary Pane Web UI.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { ID_RE, getConversationStats, listRecentConversations } from './parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const app = new SidecarApp();

app.page('/', () => {
  try {
    return new Response(readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf-8'), {
      contentType: 'text/html; charset=utf-8',
    });
  } catch (err) {
    return new Response(`UI unavailable: ${err.message}`, { status: 500 });
  }
});

for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () => {
      try {
        return new Response(readFileSync(join(PUBLIC_DIR, file), 'utf-8'), {
          contentType,
          headers: { 'Cache-Control': 'no-cache' },
        });
      } catch (err) {
        return new Response(`Asset error: ${err.message}`, { status: 404 });
      }
    },
    'GET',
  );
}

app.api(
  '/api/stats',
  (data) => {
    const recent = listRecentConversations(20);
    const requestedConv = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
    const boundConv = app.config.conversationId || '';
    const activeConv = ID_RE.test(requestedConv)
      ? requestedConv
      : ID_RE.test(boundConv)
        ? boundConv
        : recent[0]?.id || '';

    if (!activeConv) {
      return {
        conversationId: null,
        boundConversationId: boundConv || null,
        stats: null,
        recent,
      };
    }

    const stats = getConversationStats(activeConv);
    const recentDigest = recent
      .slice(0, 5)
      .map((r) => `${r.id}:${r.mtime}`)
      .join(',');
    const etag = `${activeConv}|${stats?.etag || 'none'}|${recentDigest}`;

    if (data.etag && data.etag === etag) {
      return {
        conversationId: activeConv,
        boundConversationId: boundConv || null,
        unchanged: true,
        etag,
      };
    }

    return {
      conversationId: activeConv,
      boundConversationId: boundConv || null,
      stats,
      recent,
      etag,
    };
  },
  'GET',
);

app.run();
