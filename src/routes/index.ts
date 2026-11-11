import { Router } from 'express';
import healthRouter from './health.route';
import internalStreamRouter from './internal-stream.route';
import locationRouter from './location.route';
import deviceRouter from './device.route';
import alertRouter from './alert.route';
import analysisRouter from './analysis.route';
import orderRouter from './order.route';
import partnerRouter from './partner.route';
import productRouter from './product.route';

const apiRouter = Router();

// 1. Health & Probes
apiRouter.use('/health', healthRouter);

// 2. Main Backend Ingestion Webhooks
apiRouter.use('/internal', internalStreamRouter);

// 3. User Order System, Pricing & Billing
apiRouter.use('/orders', orderRouter);

// 4. Partner Management, Online/Offline Toggle & Wallet
apiRouter.use('/partners', partnerRouter);

// 5. Product Catalog & Details
apiRouter.use('/products', productRouter);

// 6. Live Geospatial, Fleet & Geofencing Routes
apiRouter.use('/locations', locationRouter);

// 7. Device & OS Telemetry Analytics
apiRouter.use('/devices', deviceRouter);

// 8. Security & Fleet Operational Alerts
apiRouter.use('/alerts', alertRouter);

// 9. User Behavioral Intelligence & Recommendation Overrides
apiRouter.use('/analysis', analysisRouter);

export default apiRouter;

