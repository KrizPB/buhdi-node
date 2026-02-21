/**
 * Health check HTTP endpoint for buhdi-node
 */

import http from 'http';
import { getDashboardToken } from './dashboard';

const VERSION = '0.3.0';
const startTime = Date.now();

// Mutable state — set by connection module
let _state = {
  connectionState: 'DISCONNECTED' as string,
  nodeId: null as string | null,
  lastTaskAt: null as string | null,
  wsConnected: false,
  pluginCount: 0,
  pluginStatuses: [] as Array<{ name: string; version: string; status: string }>,
};

export function updateHealthState(partial: Partial<typeof _state>): void {
  Object.assign(_state, partial);
}

export function startHealthServer(port: number): http.Server | null {
  if (!port || port === 0) return null;

  const server = http.createServer((_req, res) => {
    const healthy = _state.wsConnected || _state.connectionState === 'POLLING';
    const isLocal = _req.socket.remoteAddress === '127.0.0.1'
      || _req.socket.remoteAddress === '::1'
      || _req.socket.remoteAddress === '::ffff:127.0.0.1';

    const responseData: Record<string, unknown> = {
      status: healthy ? 'healthy' : 'unhealthy',
      version: VERSION,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      connectionState: _state.connectionState,
      nodeId: _state.nodeId,
      lastTaskAt: _state.lastTaskAt,
      wsConnected: _state.wsConnected,
      plugins: {
        count: _state.pluginCount,
        statuses: _state.pluginStatuses,
      },
    };

    // Show dashboard token only from localhost
    if (isLocal) {
      const dashToken = getDashboardToken();
      if (dashToken) {
        responseData.dashboardToken = dashToken;
      }
    }

    const body = JSON.stringify(responseData);

    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(body);
  });

  server.listen(port, '127.0.0.1', () => {
    // logged by caller
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`⚠️  Health port ${port} already in use`);
    }
  });

  return server;
}
