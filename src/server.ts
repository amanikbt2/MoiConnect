import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { connectDB } from './config/db';
import routes from './routes';
import { setupSocketIO } from './socket';
import { errorHandler } from './middleware/errorHandler';

const app = express();
const server = http.createServer(app);

// Security & Utility Middlewares
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate Limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

// API Base Route
app.use('/api/v1', routes);

// Health Check
app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'MoiConnect API', status: 'healthy', timestamp: new Date() });
});

// Global Error Handler
app.use(errorHandler);

// Setup Real-Time Socket.IO
const io = new SocketIOServer(server, {
  cors: {
    origin: config.corsOrigins,
    methods: ['GET', 'POST']
  }
});
setupSocketIO(io);

// Start Server
if (process.env.NODE_ENV !== 'test') {
  connectDB().then(() => {
    server.listen(config.port, () => {
      console.log(`=================================`);
      console.log(`[MoiConnect Server Running]`);
      console.log(`Environment: ${config.nodeEnv}`);
      console.log(`Port: ${config.port}`);
      console.log(`API Base: http://localhost:${config.port}/api/v1`);
      console.log(`=================================`);
    });
  });
}

export { app, server };
