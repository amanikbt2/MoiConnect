import { Paper } from '../models/Paper';

/**
 * Returns the standard prefix for an academic material:
 * - 'N': Notes, revision summaries, lecture notes
 * - 'C': Continuous Assessment Tests (CATs)
 * - 'P': Past examination papers, solutions, and default academic exams
 */
export function getMtidPrefix(type?: string): 'N' | 'C' | 'P' {
  if (!type) return 'P';
  const clean = type.toLowerCase().trim();
  if (clean === 'cat') return 'C';
  if (clean === 'notes' || clean === 'revision' || clean === 'lecture_notes') return 'N';
  return 'P';
}

// In-flight reserved MTIDs awaiting write completion to prevent race conditions during concurrent uploads
const activeReservations = new Set<string>();

// FIFO Promise Queue to strictly serialize MTID generation calls
let generationQueue: Promise<any> = Promise.resolve();

/**
 * Releases a previously reserved MTID from in-flight cache (e.g. after write completes or on failure).
 */
export function releaseMtidReservation(mtid: string): void {
  activeReservations.delete(mtid);
}

/**
 * Generates the next guaranteed-unique, collision-free MTID for a given resource type.
 *
 * Concurrency-Safe Architecture:
 * 1. Serialized queue ensures simultaneous requests do not evaluate database state concurrently.
 * 2. Checks both existing database records AND active in-flight reservations (during file uploads).
 * 3. Immediately locks the candidate MTID into activeReservations so subsequent concurrent
 *    calls automatically skip to the next number.
 */
export async function generateSmartMtid(type?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    generationQueue = generationQueue.then(async () => {
      try {
        const prefix = getMtidPrefix(type);
        const regex = new RegExp(`^${prefix}\\d+$`, 'i');

        // 1. Query all MTIDs currently recorded in MongoDB for this prefix
        const existing = await Paper.find({ mtid: regex }, { mtid: 1 }).lean();

        let maxNum = 0;
        for (const doc of existing) {
          if (!doc.mtid) continue;
          const num = parseInt(doc.mtid.slice(1), 10);
          if (!isNaN(num) && num > maxNum) {
            maxNum = num;
          }
        }

        // 2. Also account for any in-flight reserved MTIDs currently being processed
        for (const reserved of activeReservations) {
          if (reserved.toUpperCase().startsWith(prefix)) {
            const num = parseInt(reserved.slice(1), 10);
            if (!isNaN(num) && num > maxNum) {
              maxNum = num;
            }
          }
        }

        let candidateNum = maxNum + 1;
        let candidateMtid = `${prefix}${String(candidateNum).padStart(4, '0')}`;

        // 3. Collision check loop against BOTH MongoDB and active in-flight reservations
        while (activeReservations.has(candidateMtid) || (await Paper.exists({ mtid: candidateMtid }))) {
          candidateNum += 1;
          candidateMtid = `${prefix}${String(candidateNum).padStart(4, '0')}`;
        }

        // 4. Reserve this MTID immediately for 10 minutes (released automatically or after commit)
        activeReservations.add(candidateMtid);
        setTimeout(() => activeReservations.delete(candidateMtid), 10 * 60 * 1000);

        resolve(candidateMtid);
      } catch (err) {
        reject(err);
      }
    });
  });
}
