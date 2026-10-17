const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://Amani:amani@cluster0.wlukssp.mongodb.net/moiconnect?retryWrites=true&w=majority";

const CORPUS_TXT_PATH = path.resolve(__dirname, '../../../frontend/src/data/moi_academic_corpus.txt');
const DICT_TS_PATH = path.resolve(__dirname, '../../../frontend/src/data/moiAcademicDictionary.ts');
const PUBLISHED_JSON_PATH = path.resolve(__dirname, '../../../frontend/src/data/publishedMaterialsCorpus.json');

// Canonical School normalizer helper
function normalizeSchool(rawSchool) {
  if (!rawSchool) return 'School of Science and Aerospace Studies';
  const s = rawSchool.trim();
  const lower = s.toLowerCase();

  if (lower.includes('science') && lower.includes('aerospace')) return 'School of Science and Aerospace Studies';
  if (lower.includes('biological') || lower.includes('physical sciences')) return 'School of Science and Aerospace Studies';
  if (lower === 'school of science') return 'School of Science and Aerospace Studies';
  if (lower.includes('information')) return 'School of Information Sciences';
  if (lower.includes('law')) return 'School of Law';
  if (lower.includes('medicine')) return 'School of Medicine';
  if (lower.includes('nursing')) return 'School of Nursing Sciences';
  if (lower.includes('public health')) return 'School of Public Health';
  if (lower.includes('dentistry')) return 'School of Dentistry';
  if (lower.includes('engineering')) return 'School of Engineering';
  if (lower.includes('business') || lower.includes('economics')) return 'School of Business & Economics';
  if (lower.includes('education')) return 'School of Education';
  if (lower.includes('arts') || lower.includes('social sciences') || lower.includes('sass')) return 'School of Arts and Social Sciences';
  if (lower.includes('human resource')) return 'School of Business & Economics';
  return s;
}

// Clean Department name helper
function cleanDepartment(rawDept) {
  if (!rawDept) return '';
  let d = rawDept.trim();
  // Standardize common prefix
  return d;
}

function cleanUnitCode(code) {
  if (!code) return '';
  // e.g. "CSC 214" or "CSC214" -> "CSC 214"
  let c = code.trim().toUpperCase().replace(/\s+/g, ' ');
  // Match prefix and number if connected without space e.g. "CSC214" -> "CSC 214"
  const match = c.match(/^([A-Z]{2,5})\s*(\d+[A-Z]?)$/);
  if (match) {
    return `${match[1]} ${match[2]}`;
  }
  return c;
}

async function run() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected to MongoDB!');

  const collection = mongoose.connection.db.collection('paper');
  const materials = await collection.find({}).toArray();
  console.log(`Fetched ${materials.length} total materials from database.`);

  // 1. Read existing corpus text file
  const corpusContent = fs.readFileSync(CORPUS_TXT_PATH, 'utf8');
  const lines = corpusContent.split(/\r?\n/);

  // We will preserve schools, semesters, years of study, exam years, material types
  const existingSchools = new Map(); // name -> aliases
  const existingUnitsMap = new Map(); // cleanCodeKey -> { code, name, department, school, aliases: Set }
  const existingDepartmentsMap = new Map(); // name -> { school, aliases: Set }

  let currentSection = '';
  const headerLines = [];
  const schoolLines = [];
  const semesterLines = [];
  const yearLines = [];
  const examYearLines = [];
  const materialTypeLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('### SECTION 1: SCHOOLS')) {
      currentSection = 'SCHOOLS';
      continue;
    }
    if (trimmed.startsWith('### SECTION 2: SEMESTERS')) {
      currentSection = 'SEMESTERS';
      continue;
    }
    if (trimmed.startsWith('### SECTION 3: YEARS OF STUDY')) {
      currentSection = 'YEARS';
      continue;
    }
    if (trimmed.startsWith('### SECTION 4: EXAM YEARS')) {
      currentSection = 'EXAM_YEARS';
      continue;
    }
    if (trimmed.startsWith('### SECTION 5: MATERIAL TYPES')) {
      currentSection = 'MATERIAL_TYPES';
      continue;
    }
    if (trimmed.startsWith('### SECTION 6: COURSE UNITS')) {
      currentSection = 'UNITS';
      continue;
    }

    if (!currentSection) {
      headerLines.push(line);
      continue;
    }

    if (currentSection === 'SCHOOLS' && trimmed.startsWith('SCHOOL |')) {
      schoolLines.push(line);
      const parts = trimmed.split('|').map(s => s.trim());
      // SCHOOL | CODE | NAME | ALIASES
      const code = parts[1];
      const name = parts[2];
      const aliases = parts[3] ? parts[3].split(',').map(s => s.trim().toLowerCase()) : [];
      existingSchools.set(name, { code, aliases });
    } else if (currentSection === 'SEMESTERS' && trimmed.startsWith('SEMESTER |')) {
      semesterLines.push(line);
    } else if (currentSection === 'YEARS' && trimmed.startsWith('YEAR_OF_STUDY |')) {
      yearLines.push(line);
    } else if (currentSection === 'EXAM_YEARS' && trimmed.startsWith('EXAM_YEARS |')) {
      examYearLines.push(line);
    } else if (currentSection === 'MATERIAL_TYPES' && trimmed.startsWith('MATERIAL_TYPE |')) {
      materialTypeLines.push(line);
    } else if (currentSection === 'UNITS' && trimmed.startsWith('UNIT |')) {
      const parts = trimmed.split('|').map(s => s.trim());
      // UNIT | CODE | NAME | DEPARTMENT | SCHOOL | ALIASES
      const code = cleanUnitCode(parts[1]);
      const name = parts[2] || '';
      const department = parts[3] || '';
      const school = parts[4] || '';
      const aliasesStr = parts[5] || '';
      const aliases = new Set(aliasesStr ? aliasesStr.split(';').map(s => s.trim()).filter(Boolean) : []);

      const key = code.replace(/[^A-Z0-9]/g, '');
      existingUnitsMap.set(key, {
        code,
        name,
        department,
        school,
        aliases
      });

      if (department) {
        if (!existingDepartmentsMap.has(department)) {
          existingDepartmentsMap.set(department, { school, aliases: new Set([department.toLowerCase()]) });
        }
      }
    }
  }

  console.log(`Parsed existing corpus: ${existingUnitsMap.size} units, ${existingSchools.size} schools, ${existingDepartmentsMap.size} departments.`);

  // 2. Process all online materials
  let newUnitsCount = 0;
  let updatedUnitsCount = 0;

  materials.forEach(p => {
    const rawCode = (p.unitCode || p.courseCode || '').trim();
    if (!rawCode) return;
    const cleanCode = cleanUnitCode(rawCode);
    if (!cleanCode) return;
    const key = cleanCode.replace(/[^A-Z0-9]/g, '');

    const rawName = (p.unitName || '').trim();
    const title = (p.title || '').trim();
    const rawSchool = (p.school || '').trim();
    const rawDept = (p.department || '').trim();

    const normalizedSchool = normalizeSchool(rawSchool);
    const cleanedDept = cleanDepartment(rawDept);

    let unitName = rawName;
    if (!unitName || unitName === cleanCode || unitName.toUpperCase() === rawCode.toUpperCase()) {
      if (title && !title.toUpperCase().includes('EXAMINATION') && !title.toUpperCase().includes('PAST PAPER')) {
        // Strip code if title starts with code e.g. "CSC 214 Introduction to..."
        unitName = title.replace(new RegExp(`^${cleanCode}\\s*[-:]?\\s*`, 'i'), '').trim();
      }
    }
    if (!unitName) unitName = title || cleanCode;

    // Register / update department
    if (cleanedDept) {
      if (!existingDepartmentsMap.has(cleanedDept)) {
        existingDepartmentsMap.set(cleanedDept, {
          school: normalizedSchool,
          aliases: new Set([cleanedDept.toLowerCase()])
        });
      }
    }

    if (!existingUnitsMap.has(key)) {
      newUnitsCount++;
      const aliases = new Set();
      if (title && title !== unitName) aliases.add(title);
      existingUnitsMap.set(key, {
        code: cleanCode,
        name: unitName,
        department: cleanedDept || 'General Studies',
        school: normalizedSchool,
        aliases
      });
    } else {
      const existing = existingUnitsMap.get(key);
      let updated = false;
      if (title && title !== existing.name && !existing.aliases.has(title)) {
        existing.aliases.add(title);
        updated = true;
      }
      if ((!existing.name || existing.name === cleanCode) && unitName && unitName !== cleanCode) {
        existing.name = unitName;
        updated = true;
      }
      if ((!existing.department || existing.department === 'General Studies') && cleanedDept) {
        existing.department = cleanedDept;
        updated = true;
      }
      if ((!existing.school || existing.school === 'Moi University') && normalizedSchool) {
        existing.school = normalizedSchool;
        updated = true;
      }
      if (updated) updatedUnitsCount++;
    }
  });

  console.log(`Sync stats: ${newUnitsCount} new units added, ${updatedUnitsCount} units enriched!`);
  console.log(`Total units now: ${existingUnitsMap.size}`);

  // 3. Re-generate moi_academic_corpus.txt
  const sortedUnits = Array.from(existingUnitsMap.values()).sort((a, b) => a.code.localeCompare(b.code));

  let newCorpusTxt = '';
  newCorpusTxt += `================================================================================\n`;
  newCorpusTxt += `MOI UNIVERSITY OFFLINE ACADEMIC CORPUS & SEARCH DICTIONARY\n`;
  newCorpusTxt += `Extracted from Database + Official Curriculum\n`;
  newCorpusTxt += `100% Offline Static Knowledge Base - No Online Sync Required\n`;
  newCorpusTxt += `================================================================================\n\n`;

  newCorpusTxt += `### SECTION 1: SCHOOLS ###\n`;
  schoolLines.forEach(l => {
    newCorpusTxt += l.trim() + '\n';
  });
  newCorpusTxt += '\n';

  newCorpusTxt += `### SECTION 2: SEMESTERS ###\n`;
  semesterLines.forEach(l => {
    newCorpusTxt += l.trim() + '\n';
  });
  newCorpusTxt += '\n';

  newCorpusTxt += `### SECTION 3: YEARS OF STUDY ###\n`;
  yearLines.forEach(l => {
    newCorpusTxt += l.trim() + '\n';
  });
  newCorpusTxt += '\n';

  newCorpusTxt += `### SECTION 4: EXAM YEARS ###\n`;
  newCorpusTxt += `EXAM_YEARS | 2000-2060\n\n`;

  newCorpusTxt += `### SECTION 5: MATERIAL TYPES ###\n`;
  materialTypeLines.forEach(l => {
    newCorpusTxt += l.trim() + '\n';
  });
  newCorpusTxt += '\n';

  newCorpusTxt += `### SECTION 6: COURSE UNITS (${sortedUnits.length} Total Units) ###\n`;
  for (const u of sortedUnits) {
    const aliasesList = Array.from(u.aliases).slice(0, 5).join(' ; ');
    newCorpusTxt += `UNIT | ${u.code} | ${u.name} | ${u.department} | ${u.school}${aliasesList ? ' | ' + aliasesList : ''}\n`;
  }

  fs.writeFileSync(CORPUS_TXT_PATH, newCorpusTxt, 'utf8');
  console.log(`Wrote updated corpus to ${CORPUS_TXT_PATH}!`);

  // 4. Update publishedMaterialsCorpus.json
  const schoolsSet = new Set();
  const departmentsSet = new Set();
  const courseCodesSet = new Set();
  const unitsOutput = [];

  for (const u of sortedUnits) {
    if (u.school) schoolsSet.add(u.school);
    if (u.department) departmentsSet.add(u.department);
    courseCodesSet.add(u.code);
    unitsOutput.push({
      code: u.code,
      name: u.name,
      school: u.school,
      department: u.department,
      titles: Array.from(u.aliases)
    });
  }

  const publishedCorpus = {
    extractedAt: new Date().toISOString(),
    totalMaterials: materials.length,
    schools: Array.from(schoolsSet).sort(),
    departments: Array.from(departmentsSet).sort(),
    courseCodes: Array.from(courseCodesSet).sort(),
    units: unitsOutput
  };
  fs.writeFileSync(PUBLISHED_JSON_PATH, JSON.stringify(publishedCorpus, null, 2), 'utf8');
  console.log(`Wrote published materials JSON to ${PUBLISHED_JSON_PATH}!`);

  // 5. Update moiAcademicDictionary.ts
  const schoolsArray = Array.from(existingSchools.entries()).map(([name, data]) => ({
    name,
    code: data.code,
    aliases: data.aliases
  }));

  const departmentsArray = Array.from(existingDepartmentsMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, data]) => ({
      name,
      school: data.school,
      aliases: Array.from(data.aliases)
    }));

  const unitsArray = sortedUnits.map(u => ({
    code: u.code,
    name: u.name,
    department: u.department,
    school: u.school,
    aliases: u.aliases.size > 0 ? Array.from(u.aliases) : undefined
  }));

  const dictionaryTs = `/**
 * Moi University Master Academic Dictionary & Corpus (100% OFFLINE)
 * Statically compiled from the offline corpus: moi_academic_corpus.txt
 * Zero online API dependencies, instant sub-millisecond execution.
 * Total Units: ${unitsArray.length}
 */

export interface AcademicUnitEntry {
  code: string;
  name: string;
  department: string;
  school: string;
  aliases?: string[];
}

export interface AcademicSchoolEntry {
  name: string;
  code: string;
  aliases: string[];
}

export interface AcademicDepartmentEntry {
  name: string;
  school: string;
  aliases: string[];
}

// 1. Comprehensive Moi University Schools
export const MOI_ACADEMIC_SCHOOLS: AcademicSchoolEntry[] = ${JSON.stringify(schoolsArray, null, 2)};

// 2. Comprehensive Moi University Departments (${departmentsArray.length} Departments)
export const MOI_ACADEMIC_DEPARTMENTS: AcademicDepartmentEntry[] = ${JSON.stringify(departmentsArray, null, 2)};

// 3. Static Offline Moi University Academic Units (${unitsArray.length} Units)
export const MOI_ACADEMIC_UNITS: AcademicUnitEntry[] = ${JSON.stringify(unitsArray, null, 2)};

// 4. Semesters
export const MOI_SEMESTER_MAPPINGS = {
  SEM_1: {
    value: 'Semester 1',
    label: 'Semester 1',
    aliases: ['sem 1', 'sem1', 's1', 'first semester', 'semester 1', 'semester1']
  },
  SEM_2: {
    value: 'Semester 2',
    label: 'Semester 2',
    aliases: ['sem 2', 'sem2', 's2', 'second semester', 'semester 2', 'semester2']
  }
};
export const MOI_ACADEMIC_SEMESTERS = [
  {
    "name": "Semester 1",
    "aliases": [
      "sem 1",
      "sem1",
      "s1",
      "first semester",
      "semester 1",
      "semester1"
    ]
  },
  {
    "name": "Semester 2",
    "aliases": [
      "sem 2",
      "sem2",
      "s2",
      "second semester",
      "semester 2",
      "semester2"
    ]
  }
];

// 5. Years of Study
export const MOI_YEARS_OF_STUDY = [
  { value: 'Year 1', label: 'Year 1', aliases: ['year 1', 'y1', 'yr 1', 'first year', '1st year', 'year one'] },
  { value: 'Year 2', label: 'Year 2', aliases: ['year 2', 'y2', 'yr 2', 'second year', '2nd year', 'year two'] },
  { value: 'Year 3', label: 'Year 3', aliases: ['year 3', 'y3', 'yr 3', 'third year', '3rd year', 'year three'] },
  { value: 'Year 4', label: 'Year 4', aliases: ['year 4', 'y4', 'yr 4', 'fourth year', '4th year', 'year four'] },
  { value: 'Year 5', label: 'Year 5', aliases: ['year 5', 'y5', 'yr 5', 'fifth year', '5th year', 'year five'] },
  { value: 'Year 6', label: 'Year 6', aliases: ['year 6', 'y6', 'yr 6', 'sixth year', '6th year', 'year six'] }
];
export const MOI_ACADEMIC_YEARS_OF_STUDY = [
  {
    "year": 1,
    "label": "Year 1",
    "aliases": [
      "year 1",
      "y1",
      "yr 1",
      "first year",
      "1st year",
      "year one"
    ]
  },
  {
    "year": 2,
    "label": "Year 2",
    "aliases": [
      "year 2",
      "y2",
      "yr 2",
      "second year",
      "2nd year",
      "year two"
    ]
  },
  {
    "year": 3,
    "label": "Year 3",
    "aliases": [
      "year 3",
      "y3",
      "yr 3",
      "third year",
      "3rd year",
      "year three"
    ]
  },
  {
    "year": 4,
    "label": "Year 4",
    "aliases": [
      "year 4",
      "y4",
      "yr 4",
      "fourth year",
      "4th year",
      "year four"
    ]
  },
  {
    "year": 5,
    "label": "Year 5",
    "aliases": [
      "year 5",
      "y5",
      "yr 5",
      "fifth year",
      "5th year",
      "year five"
    ]
  },
  {
    "year": 6,
    "label": "Year 6",
    "aliases": [
      "year 6",
      "y6",
      "yr 6",
      "sixth year",
      "6th year",
      "year six"
    ]
  }
];

// 6. Examination Years Range
export const MOI_EXAM_YEAR_MIN = 2000;
export const MOI_EXAM_YEAR_MAX = 2060;
export const MOI_EXAM_YEARS = Array.from(
  { length: MOI_EXAM_YEAR_MAX - MOI_EXAM_YEAR_MIN + 1 },
  (_, idx) => MOI_EXAM_YEAR_MIN + idx
);

// 7. Material Categories
export const MOI_MATERIAL_TYPE_MAPPINGS = {
  PAST_PAPER: {
    type: 'past_paper',
    label: 'Past Paper',
    aliases: ['past paper', 'pastpaper', 'exam paper', 'exam', 'examination', 'main exam', 'special exam']
  },
  NOTES: {
    type: 'notes',
    label: 'Revision Notes',
    aliases: ['notes', 'revision notes', 'lecture notes', 'pdf notes', 'slides', 'handout', 'reading material']
  },
  CAT: {
    type: 'cat',
    label: 'CAT / Quiz',
    aliases: ['cat', 'cats', 'cat paper', 'quiz', 'continuous assessment', 'cat 1', 'cat 2', 'midterm', 'mid-term']
  },
  SOLUTION: {
    type: 'solution',
    label: 'Exam Solution',
    aliases: ['solution', 'answers', 'marking scheme', 'worked solutions', 'solved paper']
  }
};
export const MOI_MATERIAL_TYPES = [
  {
    "type": "past_paper",
    "label": "Past Paper",
    "aliases": [
      "past paper",
      "pastpaper",
      "exam paper",
      "exam",
      "examination",
      "main exam",
      "special exam"
    ]
  },
  {
    "type": "notes",
    "label": "Revision Notes",
    "aliases": [
      "notes",
      "revision notes",
      "lecture notes",
      "pdf notes",
      "slides",
      "handout",
      "reading material"
    ]
  },
  {
    "type": "cat",
    "label": "CAT / Quiz",
    "aliases": [
      "cat",
      "cats",
      "cat paper",
      "quiz",
      "continuous assessment",
      "cat 1",
      "cat 2",
      "midterm",
      "mid-term"
    ]
  },
  {
    "type": "solution",
    "label": "Exam Solution",
    "aliases": [
      "solution",
      "answers",
      "marking scheme",
      "worked solutions",
      "solved paper"
    ]
  }
];

/**
 * Normalized lookup helpers (100% Offline)
 */
const unitCodeLookup = new Map<string, AcademicUnitEntry>();
const unitDenseLookup = new Map<string, AcademicUnitEntry>();

for (const unit of MOI_ACADEMIC_UNITS) {
  unitCodeLookup.set(unit.code.toUpperCase().trim(), unit);
  unitDenseLookup.set(unit.code.replace(/\\s+/g, '').toUpperCase().trim(), unit);
}

export function findAcademicUnitByCode(code: string): AcademicUnitEntry | undefined {
  if (!code) return undefined;
  const clean = code.trim().toUpperCase();
  return unitCodeLookup.get(clean) || unitDenseLookup.get(clean.replace(/\\s+/g, ''));
}

export function getAllAcademicUnits(): AcademicUnitEntry[] {
  return MOI_ACADEMIC_UNITS;
}
`;

  fs.writeFileSync(DICT_TS_PATH, dictionaryTs, 'utf8');
  console.log(`Wrote updated dictionary to ${DICT_TS_PATH}!`);

  await mongoose.disconnect();
  console.log('Finished sync successfully!');
}

run().catch(err => {
  console.error('Fatal error during sync:', err);
  process.exit(1);
});
