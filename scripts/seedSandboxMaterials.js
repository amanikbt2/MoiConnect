const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SANDBOX_URI = 'mongodb://127.0.0.1:27017/mconnect_sandbox';
const PER_CATEGORY_LIMIT = 5;
const MATERIAL_GROUPS = [
  { label: 'past papers', types: ['past_paper', 'solution', 'exam'] },
  { label: 'CATs', types: ['cat', 'quiz'] },
  { label: 'notes', types: ['notes', 'revision', 'lecture_notes'] }
];
const MATERIAL_FIELDS = [
  'mtid', 'title', 'description', 'type', 'school', 'department',
  'courseCode', 'unitCode', 'unitName', 'academicYear', 'semester',
  'examYear', 'fileUrl', 'fileType', 'fileSize', 'publicId',
  'status', 'isHidden', 'isDemo', 'createdAt', 'updatedAt'
];

const main = async () => {
  const sourceUri = process.env.MONGODB_PRODUCTION_URI || process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGODB_URL || process.env.MONGO_URL;
  if (!sourceUri) {
    throw new Error('No source Mongo URL found. Add MONGODB_PRODUCTION_URI (or MONGODB_URI) to backend/.env.');
  }
  if (sourceUri === SANDBOX_URI || /(?:localhost|127\.0\.0\.1).*mconnect_sandbox/i.test(sourceUri)) {
    throw new Error('The source URL points to the sandbox. Refusing to seed from the target database.');
  }

  let source;
  let target;
  try {
    target = await mongoose.createConnection(SANDBOX_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    }).asPromise();
    if (target.host !== '127.0.0.1' || target.name !== 'mconnect_sandbox') {
      throw new Error('Sandbox target validation failed. Only local mconnect_sandbox is allowed.');
    }

    source = await mongoose.createConnection(sourceUri, { serverSelectionTimeoutMS: 15000 }).asPromise();

    const sourcePapers = source.collection('papers');
    const targetPapers = target.collection('papers');
    const sourcePaperCount = await sourcePapers.countDocuments({});
    console.log(`Source database "${source.name || '(default)'}" contains ${sourcePaperCount} document(s) in "papers".`);
    if (sourcePaperCount > 0) {
      const statusAndTypeCounts = await sourcePapers.aggregate([
        { $group: { _id: { status: '$status', type: '$type' }, count: { $sum: 1 } } },
        { $sort: { '_id.status': 1, '_id.type': 1 } }
      ]).toArray();
      console.log(`Paper status/type counts: ${JSON.stringify(statusAndTypeCounts.map((item) => ({ status: item._id.status || '(missing)', type: item._id.type || '(missing)', count: item.count })))}`);
    } else {
      const paperLikeCollections = (await source.db.listCollections({}, { nameOnly: true }).toArray())
        .map((collection) => collection.name)
        .filter((name) => /paper|material/i.test(name));
      console.log(`Paper-like collections found: ${paperLikeCollections.join(', ') || '(none)'}`);
    }
    const uniqueMaterials = new Map();
    for (const group of MATERIAL_GROUPS) {
      const docs = await sourcePapers.find(
        { status: 'approved', isHidden: { $ne: true }, isDemo: { $ne: true }, fileUrl: { $exists: true, $ne: '' }, type: { $in: group.types } },
        { projection: { _id: 1, ...Object.fromEntries(MATERIAL_FIELDS.map((field) => [field, 1])) } }
      ).sort({ createdAt: -1 }).limit(PER_CATEGORY_LIMIT).toArray();
      for (const doc of docs) uniqueMaterials.set(String(doc._id), doc);
      console.log(`Read ${docs.length} approved ${group.label} from source.`);
    }

    const materials = [...uniqueMaterials.values()];
    if (!materials.length) {
      console.log('No approved non-demo materials were found. Nothing was written to the sandbox.');
      return;
    }

    const result = await targetPapers.bulkWrite(materials.map((material) => ({
      updateOne: {
        filter: { _id: material._id },
        update: { $setOnInsert: material },
        upsert: true
      }
    })), { ordered: false });
    console.log(`Sandbox now has ${result.upsertedCount} newly copied material(s); existing local records were left unchanged.`);
    console.log('Copied only approved Paper records and academic file metadata. No user, message, device-token, notification, or settings collections were read.');
    console.log('No source write operations were issued; writes were restricted to local mconnect_sandbox.papers.');
  } finally {
    await Promise.all([source?.close(), target?.close()].filter(Boolean));
  }
};

main().catch((error) => {
  console.error(`[Sandbox material seed failed]: ${error.message || error}`);
  process.exitCode = 1;
});
