export const randomDownloadCount = (): number => Math.floor(Math.random() * (10000 - 500 + 1)) + 500;

export const randomRatingScore = (): string => (Math.floor((Math.random() * 71) + 20) / 10).toFixed(1);

export const stableMaterialStats = (seed: string): { downloads: number; ratingScore: string } => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }
  const normalized = Math.abs(hash);
  const downloads = 500 + (normalized % 9501);
  const ratingTenths = 20 + (normalized % 71);
  return { downloads, ratingScore: (ratingTenths / 10).toFixed(1) };
};
