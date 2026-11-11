import { TransportMode } from '../models/Partner';

export class TravelTimerService {
  // Speed metrics in meters per second
  // Walking: 4.5 km/h = 1.25 m/s
  // Cycling: 15.0 km/h = 4.167 m/s
  private readonly SPEED_MPS: Record<TransportMode, number> = {
    walk: 1.25,
    cycle: 4.167,
  };

  private readonly BASE_SAFETY_BUFFER_SECONDS = 180; // 3 minutes buffer

  /**
   * Compute initial trip ETA in seconds and target expiration timestamp
   */
  calculateEta(
    distanceMeters: number,
    mode: TransportMode = 'cycle'
  ): { etaSeconds: number; expiresAt: Date } {
    const speed = this.SPEED_MPS[mode] || this.SPEED_MPS.cycle;
    const travelTimeSeconds = Math.round(distanceMeters / speed);
    const etaSeconds = travelTimeSeconds + this.BASE_SAFETY_BUFFER_SECONDS;

    const expiresAt = new Date(Date.now() + etaSeconds * 1000);
    return { etaSeconds, expiresAt };
  }

  /**
   * Evaluate whether partner qualifies for the one-time mercy extension or incurs reputation penalty
   */
  evaluateMercyExtension(
    remainingDistanceMeters: number,
    mode: TransportMode = 'cycle',
    mercyAlreadyUsed: boolean
  ): {
    mercyGranted: boolean;
    additionalSeconds: number;
    newExpiresAt: Date;
    reputationPenalty: number;
    reason: string;
  } {
    if (!mercyAlreadyUsed) {
      // One-time mercy extension granted based on remaining distance
      const speed = this.SPEED_MPS[mode] || this.SPEED_MPS.cycle;
      const additionalSeconds = Math.round(remainingDistanceMeters / speed) + 120; // travel time + 2 min buffer
      const newExpiresAt = new Date(Date.now() + additionalSeconds * 1000);

      return {
        mercyGranted: true,
        additionalSeconds,
        newExpiresAt,
        reputationPenalty: 0,
        reason: 'One-time mercy extension granted based on remaining distance.',
      };
    }

    // Mercy extension already used - apply reputation penalty
    return {
      mercyGranted: false,
      additionalSeconds: 0,
      newExpiresAt: new Date(),
      reputationPenalty: 5, // -5 reputation points
      reason: 'Trip time exceeded after one-time mercy extension. Partner reputation score penalized.',
    };
  }
}

export const travelTimerService = new TravelTimerService();
