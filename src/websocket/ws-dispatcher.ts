import { WebSocket } from 'ws';
import { logger } from '../config/logger';

export interface WSClientInfo {
  ws: WebSocket;
  isAlive: boolean;
  subscriptions: Set<string>;
  userId?: string;
  role?: string;
}

export class WSDispatcher {
  private clients = new Set<WSClientInfo>();

  registerClient(client: WSClientInfo): void {
    this.clients.add(client);
    logger.debug(`WebSocket client registered. Total active: ${this.clients.size}`);
  }

  unregisterClient(client: WSClientInfo): void {
    this.clients.delete(client);
    logger.debug(`WebSocket client disconnected. Total active: ${this.clients.size}`);
  }

  getClients(): Set<WSClientInfo> {
    return this.clients;
  }

  getActiveCount(): number {
    return this.clients.size;
  }

  /**
   * Broadcast message to clients subscribed to a given channel
   */
  broadcast(channel: string, payload: any): void {
    const message = JSON.stringify({
      channel,
      data: payload,
      timestamp: new Date().toISOString(),
    });

    for (const client of this.clients) {
      if (
        client.ws.readyState === WebSocket.OPEN &&
        (client.subscriptions.has(channel) || client.subscriptions.has('*'))
      ) {
        try {
          client.ws.send(message);
        } catch (err) {
          logger.error('Error broadcasting to WS client:', err);
        }
      }
    }
  }

  broadcastLocation(locationEvent: any): void {
    this.broadcast('locations:live', locationEvent);
  }

  broadcastAlert(alertEvent: any): void {
    this.broadcast('alerts:security', alertEvent);
  }

  broadcastDevice(deviceEvent: any): void {
    this.broadcast('devices:stream', deviceEvent);
  }
}

export const wsDispatcher = new WSDispatcher();

