const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = "mongodb+srv://Amani:amani@cluster0.wlukssp.mongodb.net/moiconnect?retryWrites=true&w=majority";

async function run() {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

    const collection = mongoose.connection.db.collection('paper');
    const materials = await collection.find({ isHidden: { $ne: true } }).toArray();

    console.log(`Extracting from ${materials.length} published materials...`);

    const unitsMap = new Map();
    const schoolsSet = new Set();
    const departmentsSet = new Set();
    const courseCodesSet = new Set();

    materials.forEach(p => {
      const code = (p.unitCode || p.courseCode || '').trim().toUpperCase();
      const course = (p.courseCode || '').trim().toUpperCase();
      const name = (p.unitName || p.title || '').trim();
      const school = (p.school || '').trim();
      const department = (p.department || '').trim();
      const title = (p.title || '').trim();

      if (school) schoolsSet.add(school);
      if (department) departmentsSet.add(department);
      if (course) courseCodesSet.add(course);

      if (code) {
        const existing = unitsMap.get(code);
        if (!existing) {
          unitsMap.set(code, {
            code,
            name: (name && name !== code) ? name : title,
            school: school || 'Moi University',
            department: department || '',
            titles: [title]
          });
        } else {
          if (!existing.titles.includes(title)) existing.titles.push(title);
          if ((!existing.name || existing.name === code) && name && name !== code) {
            existing.name = name;
          }
          if (!existing.school && school) existing.school = school;
          if (!existing.department && department) existing.department = department;
        }
      }
    });

    const publishedCorpus = {
      extractedAt: new Date().toISOString(),
      totalMaterials: materials.length,
      schools: Array.from(schoolsSet).sort(),
      departments: Array.from(departmentsSet).sort(),
      courseCodes: Array.from(courseCodesSet).sort(),
      units: Array.from(unitsMap.values()).sort((a, b) => a.code.localeCompare(b.code))
    };

    const targetPath = path.resolve(__dirname, '../../../frontend/src/data/publishedMaterialsCorpus.json');
    fs.writeFileSync(targetPath, JSON.stringify(publishedCorpus, null, 2), 'utf8');
    console.log(`Successfully wrote published materials corpus to ${targetPath}!`);
    console.log(`Units found: ${publishedCorpus.units.length}`);
    console.log(`Schools found: ${publishedCorpus.schools.length}`);
    console.log(`Departments found: ${publishedCorpus.departments.length}`);

    await mongoose.disconnect();
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

run();
