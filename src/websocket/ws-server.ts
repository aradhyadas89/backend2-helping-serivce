import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import url from 'url';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { wsDispatcher, WSClientInfo } from './ws-dispatcher';

export function setupWebSocketServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const parsedUrl = url.parse(request.url || '', true);
    const pathname = parsedUrl.pathname;

    // Only handle upgrades to /ws or /api/v1/ws
    if (pathname !== '/ws' && pathname !== '/api/v1/ws') {
      socket.destroy();
      return;
    }

    // Optional auth check via query parameters
    const token = (parsedUrl.query.token as string) || (parsedUrl.query.secret as string);
    let userId: string | undefined;
    let role: string | undefined;

    if (token) {
      if (token === env.ADMIN_SUB_BACKEND_SECRET || token === env.ANALYSIS_ENGINE_SECRET) {
        role = 'admin';
      } else {
        try {
          const decoded = jwt.verify(token, env.JWT_SECRET) as any;
          userId = decoded.userId || decoded.id;
          role = decoded.role;
        } catch {
          // Reject invalid token
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, { userId, role });
    });
  });

  wss.on('connection', (ws: WebSocket, _request: any, authInfo?: { userId?: string; role?: string }) => {
    const clientInfo: WSClientInfo = {
      ws,
      isAlive: true,
      subscriptions: new Set(['locations:live', 'alerts:security']), // Default channels
      userId: authInfo?.userId,
      role: authInfo?.role,
    };

    wsDispatcher.registerClient(clientInfo);

    // Send welcome payload
    ws.send(
      JSON.stringify({
        type: 'connection_established',
        message: 'Connected to Helping Services Sub-Backend WebSocket Stream',
        channels: Array.from(clientInfo.subscriptions),
        timestamp: new Date().toISOString(),
      })
    );

    ws.on('pong', () => {
      clientInfo.isAlive = true;
    });

    ws.on('message', (messageRaw: string) => {
      try {
        const msg = JSON.parse(messageRaw.toString());

        if (msg.action === 'subscribe' && msg.channel) {
          clientInfo.subscriptions.add(msg.channel);
          ws.send(
            JSON.stringify({
              type: 'subscribed',
              channel: msg.channel,
              activeChannels: Array.from(clientInfo.subscriptions),
            })
          );
        } else if (msg.action === 'unsubscribe' && msg.channel) {
          clientInfo.subscriptions.delete(msg.channel);
          ws.send(
            JSON.stringify({
              type: 'unsubscribed',
              channel: msg.channel,
              activeChannels: Array.from(clientInfo.subscriptions),
            })
          );
        } else if (msg.action === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        }
      } catch (err) {
        logger.debug('Malformed WebSocket message received:', err);
      }
    });

    ws.on('close', () => {
      wsDispatcher.unregisterClient(clientInfo);
    });

    ws.on('error', (err) => {
      logger.error('WebSocket connection error:', err);
      wsDispatcher.unregisterClient(clientInfo);
    });
  });

  // Heartbeat interval to detect stale / disconnected sockets
  const interval = setInterval(() => {
    for (const client of wsDispatcher.getClients()) {
      if (!client.isAlive) {
        client.ws.terminate();
        wsDispatcher.unregisterClient(client);
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  logger.info('WebSocket Server initialized on /ws and /api/v1/ws');
  return wss;
}

