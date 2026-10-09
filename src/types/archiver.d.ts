declare module 'archiver' {
  import { Readable } from 'stream';

  interface Archiver extends Readable {
    append(source: NodeJS.ReadableStream, data: { name: string }): this;
    abort(): void;
    finalize(): Promise<void>;
  }

  function archiver(format: 'zip', options?: { zlib?: { level?: number } }): Archiver;

  export = archiver;
}
