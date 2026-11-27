import axios from 'axios';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { getDatabaseHealth } from '../config/database';
import { wsDispatcher } from '../websocket/ws-dispatcher';

export interface PingHistoryEntry {
  timestamp: string;
  latencyMs: number;
  status: 'SUCCESS' | 'FAILED';
  statusCode?: number;
  error?: string;
  url: string;
}

export interface LivePingStats {
  totalPingsSent: number;
  successfulPings: number;
  failedPings: number;
  consecutiveFailures: number;
  lastPingAt: string | null;
  lastPingLatencyMs: number | null;
  lastPingStatus: 'SUCCESS' | 'FAILED' | 'IDLE';
  lastFailureReason: string | null;
  history: PingHistoryEntry[];
}

export class LivePingService {
  private isRunning: boolean = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private warmupTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  private stats: LivePingStats = {
    totalPingsSent: 0,
    successfulPings: 0,
    failedPings: 0,
    consecutiveFailures: 0,
    lastPingAt: null,
    lastPingLatencyMs: null,
    lastPingStatus: 'IDLE',
    lastFailureReason: null,
    history: [],
  };

  /**
   * Determine the most suitable target URL for self-ping:
   * 1. Explicit LIVE_PING_URL from environment
   * 2. RENDER_EXTERNAL_URL (automatically provided by Render, e.g. https://my-app.onrender.com)
   * 3. Localhost fallback http://127.0.0.1:PORT/live-ping
   */
  public getTargetUrl(): string {
    if (env.LIVE_PING_URL && env.LIVE_PING_URL.trim().length > 0) {
      return env.LIVE_PING_URL.trim();
    }

    if (env.RENDER_EXTERNAL_URL && env.RENDER_EXTERNAL_URL.trim().length > 0) {
      const cleanUrl = env.RENDER_EXTERNAL_URL.trim().replace(/\/$/, '');
      return `${cleanUrl}/live-ping`;
    }

    const host = env.HOST === '0.0.0.0' ? '127.0.0.1' : env.HOST;
    return `http://${host}:${env.PORT}/live-ping`;
  }

  /**
   * Execute an active self-ping request to keep the service warm and record telemetry
   */
  public async pingSelf(): Promise<{
    success: boolean;
    url: string;
    latencyMs: number;
    statusCode?: number;
    error?: string;
  }> {
    const targetUrl = this.getTargetUrl();
    const startTime = Date.now();
    this.stats.totalPingsSent++;

    try {
      const response = await axios.get(targetUrl, {
        timeout: 12000,
        validateStatus: () => true, // accept any HTTP status code to measure latency
        headers: {
          'User-Agent': 'HelpingServices-LivePing/1.0 (Render Keep-Alive Probe)',
          'x-live-ping': 'true',
        },
      });

      const latencyMs = Date.now() - startTime;
      const isSuccess = response.status >= 200 && response.status < 400;

      if (isSuccess) {
        this.stats.successfulPings++;
        this.stats.consecutiveFailures = 0;
        this.stats.lastPingStatus = 'SUCCESS';
        this.stats.lastFailureReason = null;
        this.stats.lastPingAt = new Date().toISOString();
        this.stats.lastPingLatencyMs = latencyMs;

        logger.info(
          `[LIVE-PING] Self-ping SUCCESS -> ${targetUrl} [${response.status}] in ${latencyMs}ms (Render Keep-Alive Active)`
        );
      } else {
        this.stats.failedPings++;
        this.stats.consecutiveFailures++;
        this.stats.lastPingStatus = 'FAILED';
        this.stats.lastFailureReason = `HTTP ${response.status}: ${response.statusText || 'Unexpected status'}`;
        this.stats.lastPingAt = new Date().toISOString();
        this.stats.lastPingLatencyMs = latencyMs;

        logger.warn(
          `[LIVE-PING] Self-ping returned non-2xx -> ${targetUrl} [${response.status}] in ${latencyMs}ms`
        );
        this.scheduleRetry();
      }

      const entry: PingHistoryEntry = {
        timestamp: new Date().toISOString(),
        latencyMs,
        status: isSuccess ? 'SUCCESS' : 'FAILED',
        statusCode: response.status,
        url: targetUrl,
      };
      this.recordHistory(entry);

      return {
        success: isSuccess,
        url: targetUrl,
        latencyMs,
        statusCode: response.status,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const errorMsg = err.message || 'Unknown network error during self-ping';

      this.stats.failedPings++;
      this.stats.consecutiveFailures++;
      this.stats.lastPingStatus = 'FAILED';
      this.stats.lastFailureReason = errorMsg;
      this.stats.lastPingAt = new Date().toISOString();
      this.stats.lastPingLatencyMs = latencyMs;

      logger.warn(`[LIVE-PING] Self-ping FAILED -> ${targetUrl} (${errorMsg}) after ${latencyMs}ms`);
      this.scheduleRetry();

      const entry: PingHistoryEntry = {
        timestamp: new Date().toISOString(),
        latencyMs,
        status: 'FAILED',
        error: errorMsg,
        url: targetUrl,
      };
      this.recordHistory(entry);

      return {
        success: false,
        url: targetUrl,
        latencyMs,
        error: errorMsg,
      };
    }
  }

  /**
   * Alias for manually executing a self-ping probe
   */
  public async executeManualPing(): Promise<{
    success: boolean;
    url: string;
    latencyMs: number;
    statusCode?: number;
    error?: string;
  }> {
    return this.pingSelf();
  }

  /**
   * Optional multi-target ping for external critical services (e.g., Main Backend, Payment Gateway)
   */
  public async pingExternalTargets(): Promise<
    Array<{
      target: string;
      status: 'SUCCESS' | 'FAILED';
      statusCode?: number;
      latencyMs: number;
      error?: string;
    }>
  > {
    const targets = env.LIVE_PING_EXTERNAL_TARGETS;
    if (!targets || targets.length === 0) {
      return [];
    }

    const results = await Promise.all(
      targets.map(async (target) => {
        const start = Date.now();
        try {
          const res = await axios.get(target, {
            timeout: 8000,
            validateStatus: () => true,
            headers: { 'User-Agent': 'HelpingServices-LivePing/1.0' },
          });
          const latencyMs = Date.now() - start;
          const isSuccess = res.status >= 200 && res.status < 400;
          return {
            target,
            status: (isSuccess ? 'SUCCESS' : 'FAILED') as 'SUCCESS' | 'FAILED',
            statusCode: res.status,
            latencyMs,
          };
        } catch (error: any) {
          return {
            target,
            status: 'FAILED' as const,
            latencyMs: Date.now() - start,
            error: error.message || 'Network error',
          };
        }
      })
    );

    return results;
  }

  /**
   * Schedule an accelerated retry in 30s if consecutive failures occur
   */
  private scheduleRetry(): void {
    if (!this.isRunning || this.stats.consecutiveFailures >= 5) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);

    this.retryTimer = setTimeout(async () => {
      logger.info(`[LIVE-PING] Executing fast retry after failure (attempt ${this.stats.consecutiveFailures})...`);
      await this.pingSelf();
    }, 30000);

    if (this.retryTimer.unref) {
      this.retryTimer.unref();
    }
  }

  /**
   * Keep a rolling window of recent ping entries
   */
  private recordHistory(entry: PingHistoryEntry): void {
    this.stats.history.unshift(entry);
    if (this.stats.history.length > 20) {
      this.stats.history.pop();
    }
  }

  /**
   * Get ping history
   */
  public getHistory(): PingHistoryEntry[] {
    return [...this.stats.history];
  }

  /**
   * Start the Live Ping background worker
   */
  public startLivePingWorker(): void {
    if (!env.LIVE_PING_ENABLED) {
      logger.info('[LIVE-PING] Live Ping keep-alive worker is disabled via LIVE_PING_ENABLED=false');
      return;
    }

    if (this.isRunning) {
      logger.info('[LIVE-PING] Live Ping worker is already running');
      return;
    }

    this.isRunning = true;
    const intervalMinutes = Math.max(1, env.LIVE_PING_INTERVAL_MINUTES);
    const intervalMs = intervalMinutes * 60 * 1000;
    const targetUrl = this.getTargetUrl();

    logger.info(
      `[LIVE-PING] Initialized Anti-Sleep Production Engine -> Target: ${targetUrl} (every ${intervalMinutes} mins)`
    );

    // Warm-up ping 15 seconds after server startup
    this.warmupTimer = setTimeout(async () => {
      logger.info('[LIVE-PING] Firing post-boot warm-up heartbeat probe across cluster...');
      await this.pingSelf();
      await this.pingExternalTargets();
    }, 15000);

    if (this.warmupTimer.unref) {
      this.warmupTimer.unref();
    }

    // Recurring keep-alive timer (pings self and all interconnected backends)
    this.pingTimer = setInterval(async () => {
      await this.pingSelf();
      await this.pingExternalTargets();
    }, intervalMs);

    if (this.pingTimer.unref) {
      this.pingTimer.unref();
    }
  }

  /**
   * Stop background timers gracefully
   */
  public stopLivePingWorker(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.isRunning = false;
    logger.info('[LIVE-PING] Live Ping keep-alive worker stopped cleanly');
  }

  /**
   * Human-readable formatted uptime string
   */
  public formatUptime(uptimeSeconds: number): string {
    const d = Math.floor(uptimeSeconds / (3600 * 24));
    const h = Math.floor((uptimeSeconds % (3600 * 24)) / 3600);
    const m = Math.floor((uptimeSeconds % 3600) / 60);
    const s = Math.floor(uptimeSeconds % 60);

    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0 || d > 0) parts.push(`${h}h`);
    if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);

    return parts.join(' ');
  }

  /**
   * Get raw ping statistics
   */
  public getLivePingStats(): LivePingStats {
    return { ...this.stats };
  }

  /**
   * Comprehensive live telemetry diagnostics for production monitoring
   */
  public getLiveTelemetry(): {
    workerRunning: boolean;
    targetUrl: string;
    intervalMinutes: number;
    renderEnvironment: {
      isRender: boolean;
      externalUrl: string | null;
      serviceId: string | null;
      instanceId: string | null;
    };
    stats: {
      totalPingsSent: number;
      successfulPings: number;
      failedPings: number;
      consecutiveFailures: number;
      successRate: string;
      lastPingAt: string | null;
      lastPingLatencyMs: number | null;
      lastPingStatus: 'SUCCESS' | 'FAILED' | 'IDLE';
      lastFailureReason: string | null;
    };
    recentHistory: PingHistoryEntry[];
  } {
    const total = this.stats.totalPingsSent;
    const successes = this.stats.successfulPings;
    const successRate = total > 0 ? `${((successes / total) * 100).toFixed(1)}%` : '100.0%';

    return {
      workerRunning: this.isRunning,
      targetUrl: this.getTargetUrl(),
      intervalMinutes: env.LIVE_PING_INTERVAL_MINUTES,
      renderEnvironment: {
        isRender: env.IS_RENDER,
        externalUrl: env.RENDER_EXTERNAL_URL || null,
        serviceId: env.RENDER_SERVICE_ID || null,
        instanceId: env.RENDER_INSTANCE_ID || null,
      },
      stats: {
        totalPingsSent: this.stats.totalPingsSent,
        successfulPings: this.stats.successfulPings,
        failedPings: this.stats.failedPings,
        consecutiveFailures: this.stats.consecutiveFailures,
        successRate,
        lastPingAt: this.stats.lastPingAt,
        lastPingLatencyMs: this.stats.lastPingLatencyMs,
        lastPingStatus: this.stats.lastPingStatus,
        lastFailureReason: this.stats.lastFailureReason,
      },
      recentHistory: this.stats.history.slice(0, 5),
    };
  }

  /**
   * Full comprehensive diagnostics payload for /live-ping, /ping, and health checks
   */
  public getDiagnostics(): {
    success: boolean;
    status: 'live' | 'degraded';
    ping: 'pong';
    service: string;
    version: string;
    environment: string;
    timestamp: string;
    uptimeSeconds: number;
    activeWebSockets: number;
    uptime: {
      seconds: number;
      human: string;
    };
    interconnectedServices: {
      mainBackend: string;
      backend2: string;
      backend3: string;
      backend4: string;
    };
    render: {
      isRender: boolean;
      externalUrl: string | null;
      serviceId: string | null;
      instanceId: string | null;
    };
    selfPing: {
      workerRunning: boolean;
      targetUrl: string;
      intervalMinutes: number;
      totalPings: number;
      successCount: number;
      failCount: number;
      consecutiveFailures: number;
      successRate: string;
      lastPingAt: string | null;
      lastPingLatencyMs: number | null;
      lastPingStatus: 'SUCCESS' | 'FAILED' | 'IDLE';
      lastFailureReason: string | null;
    };
    databases: {
      allConnected: boolean;
      orders: any;
      fleet: any;
      telemetry: any;
    };
    websockets: {
      activeConnections: number;
    };
    system: {
      memoryRssMb: number;
      memoryHeapUsedMb: number;
      memoryHeapTotalMb: number;
      nodeVersion: string;
      platform: string;
    };
  } {
    const uptimeSec = Math.round(process.uptime());
    const dbHealth = getDatabaseHealth();
    const defaultState = mongoose.connection.readyState;
    const isDbConnected = dbHealth.allConnected || defaultState === 1;

    const total = this.stats.totalPingsSent;
    const successes = this.stats.successfulPings;
    const successRate = total > 0 ? `${((successes / total) * 100).toFixed(1)}%` : '100.0%';

    const mem = process.memoryUsage();

    return {
      success: true,
      status: isDbConnected ? 'live' : 'degraded',
      ping: 'pong',
      service: env.PROJECT_NAME,
      version: env.VERSION,
      environment: env.ENVIRONMENT,
      timestamp: new Date().toISOString(),
      uptimeSeconds: uptimeSec,
      activeWebSockets: wsDispatcher.getActiveCount(),
      uptime: {
        seconds: uptimeSec,
        human: this.formatUptime(uptimeSec),
      },
      interconnectedServices: {
        mainBackend: env.MAIN_BACKEND_URL,
        backend2: env.BACKEND2_URL,
        backend3: env.BACKEND3_URL,
        backend4: env.BACKEND4_URL,
      },
      render: {
        isRender: env.IS_RENDER,
        externalUrl: env.RENDER_EXTERNAL_URL || null,
        serviceId: env.RENDER_SERVICE_ID || null,
        instanceId: env.RENDER_INSTANCE_ID || null,
      },
      selfPing: {
        workerRunning: this.isRunning,
        targetUrl: this.getTargetUrl(),
        intervalMinutes: env.LIVE_PING_INTERVAL_MINUTES,
        totalPings: this.stats.totalPingsSent,
        successCount: this.stats.successfulPings,
        failCount: this.stats.failedPings,
        consecutiveFailures: this.stats.consecutiveFailures,
        successRate,
        lastPingAt: this.stats.lastPingAt,
        lastPingLatencyMs: this.stats.lastPingLatencyMs,
        lastPingStatus: this.stats.lastPingStatus,
        lastFailureReason: this.stats.lastFailureReason,
      },
      databases: {
        allConnected: dbHealth.allConnected,
        orders: dbHealth.databases.orders,
        fleet: dbHealth.databases.fleet,
        telemetry: dbHealth.databases.telemetry,
      },
      websockets: {
        activeConnections: wsDispatcher.getActiveCount(),
      },
      system: {
        memoryRssMb: Math.round(mem.rss / (1024 * 1024)),
        memoryHeapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
        memoryHeapTotalMb: Math.round(mem.heapTotal / (1024 * 1024)),
        nodeVersion: process.version,
        platform: process.platform,
      },
    };
  }
}

export const livePingService = new LivePingService();
