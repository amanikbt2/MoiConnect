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
import path from 'path';
import {
  renderAdminDashboard,
  renderPublicTempFolder,
  renderSmartPreviewPage
} from './controllers/dashboardController';

const app = express();
const server = http.createServer(app);

// Static files for favicon and public assets
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.static(path.join(__dirname, '../../public')));
app.use(express.static(path.join(process.cwd(), 'public')));

// Serve temporary and uploaded files with permissive inline viewing headers
const tempDirs = [
  path.join(__dirname, '../uploads/temp'),
  path.join(process.cwd(), 'uploads/temp')
];

const tempStaticOptions = {
  maxAge: 0,
  setHeaders: (res: express.Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  }
};

// General uploads static route
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Public Temporary Storage routes (accessible via /mydomain_admin/temp_files/*, /admin/temp_files/*, /temp_files/*)
['/uploads/temp', '/temp_files', '/admin/temp_files', '/mydomain_admin/temp_files'].forEach(routePath => {
  tempDirs.forEach(dir => {
    app.use(routePath, express.static(dir, tempStaticOptions));
  });
});

// Security & Utility Middlewares
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false
}));
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

// Root Web Admin Dashboard
app.get('/', renderAdminDashboard);
app.get('/admin', renderAdminDashboard);

// Public Temporary Storage Directory Index Viewer (/mydomain_admin/temp_files/)
app.get([
  '/mydomain_admin/temp_files',
  '/mydomain_admin/temp_files/',
  '/admin/temp_files',
  '/admin/temp_files/',
  '/temp_files',
  '/temp_files/'
], renderPublicTempFolder);

// Smart Document & Media Preview Route (Images, PDF, Word DOCX/DOC, Text)
app.get(['/admin/preview', '/preview'], renderSmartPreviewPage);

// API Base Route
app.use('/api/v1', routes);

// Health Check
app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'MoiConnect API', status: 'healthy', timestamp: new Date() });
});

// Global Error Handler
app.use(errorHandler);

// Setup Real-Time Socket.IO (Supports WebSocket & Polling Fallback, Permissive CORS for Web & Mobile)
const io = new SocketIOServer(server, {
  cors: {
    origin: (origin, callback) => callback(null, true),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});
setupSocketIO(io);

// Start Server
if (process.env.NODE_ENV !== 'test') {
  const PORT = config.port;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`=================================`);
    console.log(`[MoiConnect Server Running]`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`Port: ${PORT}`);
    console.log(`Bound Interface: 0.0.0.0:${PORT}`);
    console.log(`=================================`);
  });

  // Connect to MongoDB asynchronously
  connectDB().catch((err: any) => {
    console.error('[MongoDB Connection Failure]:', err?.message || err);
  });
}

export { app, server };
