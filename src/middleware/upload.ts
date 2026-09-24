import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Temporary uploads directory on the server
export const TEMP_UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'temp');

if (!fs.existsSync(TEMP_UPLOADS_DIR)) {
  fs.mkdirSync(TEMP_UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(TEMP_UPLOADS_DIR)) {
      fs.mkdirSync(TEMP_UPLOADS_DIR, { recursive: true });
    }
    cb(null, TEMP_UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const cleanOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniquePrefix = `${Date.now()}-${Math.round(Math.random() * 1e4)}`;
    cb(null, `${uniquePrefix}_${cleanOriginalName}`);
  }
});

export const tempUpload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50 MB max limit
  }
});
