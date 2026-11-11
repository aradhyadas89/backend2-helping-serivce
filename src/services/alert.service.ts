import {
  getSecurityAlertModel,
  ISecurityAlert,
  AlertType,
  AlertSeverity,
  AlertStatus,
} from '../models/SecurityAlert';
import { logger } from '../config/logger';
import { wsDispatcher } from '../websocket/ws-dispatcher';

export interface CreateAlertOptions {
  alertType: AlertType;
  severity: AlertSeverity;
  userId: string;
  userName?: string;
  userEmail?: string;
  role?: 'user' | 'partner' | 'admin';
  title: string;
  description: string;
  metadata?: Record<string, any>;
  location?: { latitude: number; longitude: number };
  deviceInfo?: {
    osName: string;
    osVersion?: string;
    deviceBrand?: string;
    deviceModel?: string;
  };
}

export class AlertService {
  /**
   * Create and persist a security/fleet alert, then broadcast it in real time via WebSocket
   */
  async createAlert(options: CreateAlertOptions): Promise<ISecurityAlert> {
    const SecurityAlert = getSecurityAlertModel();

    // Check for recent duplicate open alert within last 5 minutes to prevent spamming
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const existing = await SecurityAlert.findOne({
      userId: options.userId,
      alertType: options.alertType,
      status: 'open',
      createdAt: { $gte: fiveMinutesAgo },
    });

    if (existing) {
      logger.debug(`Suppressed duplicate alert for user ${options.userId} [${options.alertType}]`);
      return existing;
    }

    const alert = await SecurityAlert.create({
      alertType: options.alertType,
      severity: options.severity,
      status: 'open',
      userId: options.userId,
      userName: options.userName,
      userEmail: options.userEmail,
      role: options.role || 'user',
      title: options.title,
      description: options.description,
      metadata: options.metadata,
      location: options.location,
      deviceInfo: options.deviceInfo,
    });

    logger.warn(`[ALERT CREATED] [${options.severity.toUpperCase()}] ${options.title} - User: ${options.userId}`);

    // Broadcast to WebSocket clients subscribed to security alerts
    wsDispatcher.broadcastAlert({
      id: alert._id.toString(),
      alertType: alert.alertType,
      severity: alert.severity,
      title: alert.title,
      description: alert.description,
      userId: alert.userId,
      role: alert.role,
      location: alert.location,
      createdAt: alert.createdAt,
    });

    return alert;
  }

  /**
   * List alerts with pagination and filters
   */
  async listAlerts(query: {
    status?: AlertStatus;
    severity?: AlertSeverity;
    alertType?: AlertType;
    role?: string;
    limit?: number;
    page?: number;
  }): Promise<{ alerts: ISecurityAlert[]; total: number; page: number; totalPages: number }> {
    const SecurityAlert = getSecurityAlertModel();
    const filter: Record<string, any> = {};

    if (query.status) filter.status = query.status;
    if (query.severity) filter.severity = query.severity;
    if (query.alertType) filter.alertType = query.alertType;
    if (query.role) filter.role = query.role;

    const limit = query.limit || 50;
    const page = query.page || 1;
    const skip = (page - 1) * limit;

    const [alerts, total] = await Promise.all([
      SecurityAlert.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SecurityAlert.countDocuments(filter),
    ]);

    return {
      alerts: alerts as unknown as ISecurityAlert[],
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Update status of an alert (acknowledge, resolve, dismiss)
   */
  async updateAlertStatus(
    alertId: string,
    status: AlertStatus,
    updatedBy: string,
    note?: string
  ): Promise<ISecurityAlert | null> {
    const SecurityAlert = getSecurityAlertModel();
    const updateData: Record<string, any> = {
      status,
      updatedAt: new Date(),
    };

    if (status === 'acknowledged') {
      updateData.acknowledgedBy = updatedBy;
      updateData.acknowledgedAt = new Date();
    } else if (status === 'resolved') {
      updateData.resolvedBy = updatedBy;
      updateData.resolvedAt = new Date();
    }

    if (note) {
      updateData.$push = {
        notes: {
          text: note,
          author: updatedBy,
          createdAt: new Date(),
        },
      };
    }

    const updated = await SecurityAlert.findByIdAndUpdate(alertId, updateData, { new: true });
    return updated;
  }

  /**
   * Retrieve count of open alerts grouped by severity
   */
  async getAlertStats(): Promise<Record<string, number>> {
    const SecurityAlert = getSecurityAlertModel();
    const stats = await SecurityAlert.aggregate([
      { $match: { status: 'open' } },
      { $group: { _id: '$severity', count: { $sum: 1 } } },
    ]);

    const result: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      totalOpen: 0,
    };

    for (const item of stats) {
      if (item._id && result[item._id] !== undefined) {
        result[item._id] = item.count;
      }
      result.totalOpen += item.count;
    }

    return result;
  }
}

export const alertService = new AlertService();

