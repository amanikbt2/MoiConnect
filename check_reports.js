const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/moiconnect';

async function checkReports() {
  await mongoose.connect(MONGODB_URI);
  const reports = await mongoose.connection.collection('reports').find({}).toArray();
  console.log('REPORTS_COUNT:', reports.length);
  console.log('REPORTS:', JSON.stringify(reports, null, 2));
  const searchReports = await mongoose.connection.collection('searchreports').find({}).toArray();
  console.log('SEARCH_REPORTS_COUNT:', searchReports.length);
  process.exit(0);
}

checkReports().catch(err => {
  console.error(err);
  process.exit(1);
});
