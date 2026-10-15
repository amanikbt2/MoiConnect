declare module 'archiver' {
  import { Readable, Transform } from 'stream';

  export interface Archiver extends Transform {
    append(source: any, data: { name: string }): this;
    abort(): void;
    finalize(): Promise<void>;
    pointer(): number;
  }

  export class ZipArchive extends Transform {
    constructor(options?: any);
    append(source: any, data: { name: string }): this;
    abort(): void;
    finalize(): Promise<void>;
    pointer(): number;
  }

  export class TarArchive extends Transform {
    constructor(options?: any);
    append(source: any, data: { name: string }): this;
    abort(): void;
    finalize(): Promise<void>;
    pointer(): number;
  }

  function archiver(format: string, options?: any): any;

  export default archiver;
}
