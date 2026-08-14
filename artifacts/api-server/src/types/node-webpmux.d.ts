declare module "node-webpmux" {
  export class Image {
    exif: Buffer;
    load(data: Buffer): Promise<void>;
    save(path: string | null): Promise<Buffer>;
  }
}
