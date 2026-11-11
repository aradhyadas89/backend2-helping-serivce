import { Router } from 'express';
import healthRouter from './health.route';
import internalStreamRouter from './internal-stream.route';
import locationRouter from './location.route';
import deviceRouter from './device.route';
import alertRouter from './alert.route';
import analysisRouter from './analysis.route';

const apiRouter = Router();

// 1. Health & Probes
apiRouter.use('/health', healthRouter);

// 2. Main Backend Ingestion Webhooks
apiRouter.use('/internal', internalStreamRouter);

// 3. Live Geospatial, Fleet & Geofencing Routes
apiRouter.use('/locations', locationRouter);

// 4. Device & OS Telemetry Analytics
apiRouter.use('/devices', deviceRouter);

// 5. Security & Fleet Operational Alerts
apiRouter.use('/alerts', alertRouter);

// 6. User Behavioral Intelligence & Recommendation Overrides
apiRouter.use('/analysis', analysisRouter);

export default apiRouter;

