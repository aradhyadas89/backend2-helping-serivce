import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import url from 'url';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { wsDispatcher, WSClientInfo } from './ws-dispatcher';
import { getPartnerModel } from '../models/Partner';
import { getOrderModel } from '../models/Order';
import { googleMapsService } from '../services/google-maps.service';

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

    // Optional auth check via query parameters (accepts token, secret, apiKey, or key)
    const token =
      (parsedUrl.query.token as string) ||
      (parsedUrl.query.secret as string) ||
      (parsedUrl.query.key as string) ||
      (parsedUrl.query.apiKey as string);
    let userId: string | undefined;
    let role: string | undefined;

    if (token) {
      if (
        token === env.ADMIN_SUB_BACKEND_SECRET ||
        token === env.ANALYSIS_ENGINE_SECRET ||
        token === env.GOOGLE_MAPS_API_KEY ||
        token === env.MAPPLS_API_KEY
      ) {
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

    ws.on('message', async (messageRaw: string | Buffer) => {
      try {
        if (messageRaw.length > 65536) {
          ws.send(JSON.stringify({ type: 'error', message: 'Payload size exceeds 64KB limit' }));
          return;
        }

        const msg = JSON.parse(messageRaw.toString());

        if (msg.action === 'subscribe' && msg.channel) {
          if (clientInfo.subscriptions.size >= 50) {
            ws.send(JSON.stringify({ type: 'error', message: 'Maximum subscription channels limit reached (50)' }));
            return;
          }
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
        } else if (msg.action === 'location_update' || msg.action === 'partner_location') {
          // Real-time location stream over WebSocket
          const { partnerId, orderId, latitude, longitude, speed, heading } = msg;

          if (latitude !== undefined && longitude !== undefined) {
            // 1. Update Partner location in DB
            if (partnerId) {
              const Partner = getPartnerModel();
              await Partner.findOneAndUpdate(
                { partnerId },
                {
                  $set: {
                    latitude,
                    longitude,
                    currentLocation: {
                      type: 'Point',
                      coordinates: [longitude, latitude],
                    },
                    lastLocationUpdate: new Date(),
                  },
                }
              );
            }

            // 2. If orderId provided, calculate route & ETA to customer destination
            let remainingDistanceMeters: number | undefined;
            let etaSeconds: number | undefined;
            let routePolyline: string | undefined;

            if (orderId) {
              const Order = getOrderModel();
              const order = await Order.findOne({ orderId }).lean();
              if (order) {
                const route = await googleMapsService.calculateRoute(
                  { latitude, longitude },
                  { latitude: order.latitude, longitude: order.longitude },
                  (order.partnerTransportMode as any) || 'cycle'
                );
                remainingDistanceMeters = route.distanceMeters;
                etaSeconds = route.durationSeconds;
                routePolyline = route.polyline;

                // Broadcast directly to order channel for customer live tracking
                wsDispatcher.broadcast(`order:${orderId}`, {
                  type: 'LIVE_LOCATION_UPDATE',
                  orderId,
                  partnerId: partnerId || order.assignedPartnerId,
                  partnerLocation: {
                    latitude,
                    longitude,
                    speed,
                    heading,
                  },
                  remainingDistanceMeters,
                  estimatedRemainingSeconds: etaSeconds,
                  routePolyline,
                  routeSource: route.source,
                  timestamp: new Date().toISOString(),
                });
              }
            }

            // 3. Broadcast to fleet monitoring channel
            wsDispatcher.broadcastLocation({
              userId: partnerId || clientInfo.userId || 'anonymous_partner',
              role: 'partner',
              latitude,
              longitude,
              speed,
              heading,
              orderId,
              remainingDistanceMeters,
              etaSeconds,
              lastPingAt: new Date(),
            });

            // 4. Send acknowledgment back to the partner
            ws.send(
              JSON.stringify({
                type: 'location_ack',
                status: 'received',
                partnerId,
                orderId,
                remainingDistanceMeters,
                etaSeconds,
                timestamp: new Date().toISOString(),
              })
            );
          }
        } else if (msg.action === 'ping' || msg.action === 'live_ping') {
          const clientTime = typeof msg.clientTime === 'number' ? msg.clientTime : undefined;
          const latencyMs = clientTime ? Date.now() - clientTime : undefined;
          ws.send(
            JSON.stringify({
              type: msg.action === 'live_ping' ? 'live_pong' : 'pong',
              status: 'live',
              service: env.PROJECT_NAME,
              timestamp: new Date().toISOString(),
              clientTime,
              latencyMs,
              activeConnections: wsDispatcher.getActiveCount(),
              uptimeSeconds: Math.round(process.uptime()),
            })
          );
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

