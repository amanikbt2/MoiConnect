const fs = require('node:fs');
const path = require('node:path');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

dotenv.config({ path: path.resolve(__dirname, '../.env.sandbox') });

const SANDBOX_URI = 'mongodb://127.0.0.1:27017/mconnect_sandbox';
const MATERIALS_DIR = path.resolve(__dirname, '../uploads/sandbox-materials');
const MAX_FILE_BYTES = 100 * 1024 * 1024;

const isCloudinaryUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'cloudinary.com' || url.hostname.endsWith('.cloudinary.com'));
  } catch {
    return false;
  }
};

const getSafeFilename = (paper, sourceUrl) => {
  const parsed = new URL(sourceUrl);
  const sourceExt = path.extname(parsed.pathname).toLowerCase();
  const ext = /^\.[a-z0-9]{1,8}$/.test(sourceExt) ? sourceExt : '.pdf';
  const id = String(paper.mtid || paper._id).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${id}${ext}`;
};

const saveResponseBody = async (response, destination) => {
  if (!response.body) throw new Error('The file response had no content.');
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    throw new Error('The source returned a web page or error response instead of a material file.');
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_FILE_BYTES) throw new Error('The material exceeds the 100 MB sandbox copy limit.');

  let bytesWritten = 0;
  const sizeGuard = new Transform({
    transform(chunk, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_FILE_BYTES) callback(new Error('The material exceeds the 100 MB sandbox copy limit.'));
      else callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), sizeGuard, fs.createWriteStream(destination));
  if (bytesWritten < 1) throw new Error('The downloaded material is empty.');
};

const getSignedSourceUrls = (paper, originalUrl, sourceCredentials) => {
  if (!sourceCredentials || !paper.publicId) return [];
  const parsed = new URL(originalUrl);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const resourceIndex = segments.findIndex((segment) => ['image', 'video', 'raw'].includes(segment));
  const resourceType = resourceIndex >= 0 ? segments[resourceIndex] : 'raw';
  const pathDeliveryType = resourceIndex >= 0 ? segments[resourceIndex + 1] : '';
  const deliveryTypes = [...new Set([pathDeliveryType, 'upload', 'authenticated', 'private'].filter(Boolean))];
  const format = path.extname(parsed.pathname).replace(/^\./, '').toLowerCase() || 'pdf';

  cloudinary.config({
    cloud_name: sourceCredentials.cloudName,
    api_key: sourceCredentials.apiKey,
    api_secret: sourceCredentials.apiSecret,
    secure: true
  });
  return deliveryTypes.map((type) => cloudinary.utils.private_download_url(paper.publicId, format, {
    resource_type: resourceType,
    type,
    attachment: true,
    expires_at: Math.floor(Date.now() / 1000) + 15 * 60
  }));
};

const downloadMaterial = async (paper, sourceUrl, destination, sourceCredentials) => {
  const candidateUrls = [sourceUrl, ...getSignedSourceUrls(paper, sourceUrl, sourceCredentials)];
  let lastError;

  for (const candidateUrl of candidateUrls) {
    try {
      const response = await fetch(candidateUrl, { redirect: 'follow' });
      if (!response.ok) {
        lastError = new Error(`Download failed with HTTP ${response.status}.`);
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!isCloudinaryUrl(response.url || candidateUrl)) throw new Error('The download redirected away from Cloudinary.');
      await saveResponseBody(response, destination);
      return;
    } catch (error) {
      lastError = error;
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
      if (!/HTTP (401|403|404)/.test(String(error.message || error))) throw error;
    }
  }

  if (lastError?.message?.includes('HTTP 401') && !sourceCredentials) {
    throw new Error('Cloudinary requires authentication. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to the ignored backend .env, then rerun.');
  }
  throw lastError || new Error('Could not download the material.');
};

const main = async () => {
  const sourceEnvPath = path.resolve(__dirname, '../.env');
  const sourceEnv = fs.existsSync(sourceEnvPath) ? dotenv.parse(fs.readFileSync(sourceEnvPath, 'utf8')) : {};
  const sourceCredentials = sourceEnv.CLOUDINARY_CLOUD_NAME && sourceEnv.CLOUDINARY_API_KEY && sourceEnv.CLOUDINARY_API_SECRET
    ? {
        cloudName: sourceEnv.CLOUDINARY_CLOUD_NAME.trim(),
        apiKey: sourceEnv.CLOUDINARY_API_KEY.trim(),
        apiSecret: sourceEnv.CLOUDINARY_API_SECRET.trim()
      }
    : null;
  let db;
  try {
    db = await mongoose.createConnection(SANDBOX_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    }).asPromise();
    if (db.host !== '127.0.0.1' || db.name !== 'mconnect_sandbox') {
      throw new Error('Sandbox database validation failed. Only local mconnect_sandbox is allowed.');
    }

    fs.mkdirSync(MATERIALS_DIR, { recursive: true });
    const papers = db.collection('papers');
    const materials = await papers.find({ status: 'approved', isHidden: { $ne: true }, isDemo: { $ne: true } }).toArray();
    if (!materials.length) {
      console.log('No approved sandbox materials were found. Run seed:sandbox-materials first.');
      return;
    }

    let copied = 0;
    let skipped = 0;
    let failed = 0;
    for (const paper of materials) {
      const sourceUrl = String(paper.fileUrl || '').trim();
      const filename = getSafeFilename(paper, sourceUrl || 'https://res.cloudinary.com/invalid/file.pdf');
      const destination = path.join(MATERIALS_DIR, filename);
      const localUrl = `http://localhost:5000/uploads/sandbox-materials/${encodeURIComponent(filename)}`;
      const alreadyLocal = sourceUrl === localUrl && fs.existsSync(destination);

      try {
        if (alreadyLocal) {
          skipped += 1;
          continue;
        }
        if (!isCloudinaryUrl(sourceUrl)) throw new Error('The source file URL is not an HTTPS Cloudinary URL.');

        const tempDestination = `${destination}.part`;
        try {
          await downloadMaterial(paper, sourceUrl, tempDestination, sourceCredentials);
          fs.renameSync(tempDestination, destination);
        } catch (error) {
          if (fs.existsSync(tempDestination)) fs.unlinkSync(tempDestination);
          throw error;
        }

        await papers.updateOne({ _id: paper._id }, {
          $set: { fileUrl: localUrl, publicId: '' }
        });
        copied += 1;
        console.log(`Copied ${paper.mtid || paper.unitCode || String(paper._id)} to local sandbox storage.`);
      } catch (error) {
        failed += 1;
        console.error(`Could not copy ${paper.mtid || paper.unitCode || String(paper._id)}: ${error.message || error}`);
      }
    }

    console.log(`Local sandbox file copy finished: ${copied} copied, ${skipped} already local, ${failed} failed.`);
    console.log('Only local mconnect_sandbox.papers was updated. No Cloudinary assets, production database, or user collections were changed.');
    if (failed) process.exitCode = 1;
  } finally {
    await db?.close();
  }
};

main().catch((error) => {
  console.error(`[Local sandbox material copy failed]: ${error.message || error}`);
  process.exitCode = 1;
});
