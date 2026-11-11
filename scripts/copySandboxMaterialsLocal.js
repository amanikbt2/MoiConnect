const fs = require('node:fs');
const path = require('node:path');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

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

const downloadMaterial = async (url, destination) => {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
  if (!isCloudinaryUrl(response.url || url)) throw new Error('The download redirected away from Cloudinary.');

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
}

const main = async () => {
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
          await downloadMaterial(sourceUrl, tempDestination);
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
    console.log('Only local mconnect_sandbox.papers was updated. No Cloudinary API, production database, or user collections were written.');
    if (failed) process.exitCode = 1;
  } finally {
    await db?.close();
  }
};

main().catch((error) => {
  console.error(`[Local sandbox material copy failed]: ${error.message || error}`);
  process.exitCode = 1;
});
